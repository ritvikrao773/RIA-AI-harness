import { basename } from "node:path";
import type { LLMClient, ToolDef } from "./llm.js";
import { estimateTokens, type ChatMessage, type Usage } from "./llm.js";
import type { SkillMeta } from "./skills.js";
import { skillPromptLines } from "./skills.js";
import { buildTools, runTool } from "./tools.js";
import {
  COMPACT_PROMPT,
  calibrate,
  dropBulkContext,
  estimateHistory,
  needsCompaction,
  shrinkToolOutput,
} from "./compact.js";

const MAX_TURNS = 40;

export const SYSTEM_PROMPT = (skills: SkillMeta[], cwdName: string) => `You are a fast, token-efficient coding agent in "${cwdName}".
Rules:
- Answer directly. No preamble, no restating the task, no summary of what you are about to do.
- Batch tool calls: emit several read_file/glob/grep calls in ONE response when you need several files. Never fetch files one per turn.
- Do not explore blindly. Use the task's own words to target files (grep for the symbol, glob for the type). Stop as soon as you have what you need.
- Read a file before editing it; copy old_string verbatim. On "edit failed", re-read and retry — never claim success.
- After changing code, run the test/build once to verify. Then report result in one or two lines.
- Load a skill only when its one-line description matches the task.
${skillPromptLines(skills)}`;

export interface AgentEvent {
  type: "text" | "tool_start" | "tool_end" | "usage" | "status" | "compacted";
  data?: unknown;
}

export interface AgentOptions {
  /** Model context window; enables automatic compaction. */
  contextWindow?: number;
  /** Compact when the prompt exceeds this fraction of the window. */
  compactAt?: number;
  /** Messages kept verbatim after a compaction. */
  keepRecent?: number;
  /** Target size for the live conversation; older bulk output is released above it. */
  workingSetTokens?: number;
}

export class Agent {
  private history: ChatMessage[] = [];
  readonly tools: ToolDef[];
  private totalUsage = { prompt_tokens: 0, completion_tokens: 0 };
  private turns = 0;
  /** Estimator correction factor, learned from real prompt_tokens. */
  private calib = 1;
  /** True while we are calling the model to summarise, not for the user. */
  private summarising = false;
  compactCount = 0;
  /** Per-session counters for `--stats`. */
  stats = { requests: 0, toolCalls: 0 };
  /** Turns remaining before auto-compaction may run again (hysteresis). */
  private compactCooldown = 0;
  /** Max chars of a single tool result kept in history (0 = uncapped). */
  private toolOutputCap = 12_000;

  constructor(
    private client: LLMClient,
    private skills: SkillMeta[],
    private emit: (e: AgentEvent) => void,
    private opts: AgentOptions = {},
  ) {
    this.tools = buildTools(skills);
    this.history.push({ role: "system", content: SYSTEM_PROMPT(skills, basename(process.cwd())) });
  }

  get cumulativeUsage() {
    return this.totalUsage;
  }

  /** Estimated prompt size of the current conversation. */
  get estimatedTokens(): number {
    // Always computed from the live history, so compaction/reset are reflected
    // immediately instead of showing a stale pre-compaction number.
    return Math.round(estimateHistory(this.history) * this.calib);
  }

  reset(): void {
    this.history = this.history.slice(0, 1);
    this.compactCount = 0;
    this.turns = 0;
  }

  async run(userText: string, signal?: AbortSignal): Promise<string> {
    this.history.push({ role: "user", content: userText });
    this.turns = 0;
    await this.maybeCompact(signal);

    let finalText = "";
    while (this.turns++ < MAX_TURNS) {
      let res;
      try {
        this.enforceBudget();
        res = await this.client.chat(
          this.history,
          this.tools,
          (t) => {
            if (!this.summarising) {
              this.emit({ type: "text", data: t });
              finalText += t;
            }
          },
          signal,
        );
      } catch (e) {
        if (signal?.aborted) return finalText;
        this.emit({ type: "status", data: { kind: "api_error", error: (e as Error).message } });
        throw e;
      }
      const { content, toolCalls, usage } = res;
      this.stats.requests++;
      this.accountUsage(usage);
      if (signal?.aborted) return finalText;

      if (toolCalls.length) {
        finalText = ""; // intermediate turns aren't the final answer
        this.history.push({
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } })),
        });

        const execute = async (tc: (typeof toolCalls)[number]) => {
          this.stats.toolCalls++;
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch { /* empty args */ }
          // Carry the primary argument so the UI can name the file/command
          // as the tool starts, not only after it finishes.
          const target = (args.path ?? args.file_path ?? args.command ?? args.pattern ?? args.query ?? args.name ?? "") as unknown;
          this.emit({ type: "tool_start", data: { name: tc.name, target: typeof target === "string" ? target : "" } });
          let out = await runTool(tc.name, args, this.skills);
          if (tc.name === "skill" && !/^unknown skill/i.test(out)) {
            // Mark so bulk-release can recognise skill bodies later.
            out = `Skill content (${args.name}):\n${out}`;
          }
          const ok = !/^(edit failed|error:|unknown tool|unknown skill|spawn error)/i.test(out);
          this.emit({ type: "tool_end", data: { name: tc.name, output: out, ok } });
          // Store a bounded copy: a 25KB file read must not eat the window.
          // The model already saw the full output above; keeping head+tail is
          // enough to keep working, and the tool can be re-run for more.
          const stored = this.toolOutputCap ? shrinkToolOutput(out, this.toolOutputCap) : out;
          if (stored.length < out.length) {
            this.emit({ type: "status", data: { kind: "trim", reclaimed: estimateTokens(out) - estimateTokens(stored) } });
          }
          this.history.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: stored });
        };

        // Parallel calls in one bundle: read-only tools are independent, so
        // running them together saves wall-clock time without extra tokens.
        // Mutating calls (edit/write/bash) stay sequential and ordered.
        const READ_ONLY = new Set(["read_file", "glob", "grep", "skill"]);
        let batch: Promise<void>[] = [];
        for (let i = 0; i < toolCalls.length; i++) {
          const tc = toolCalls[i];
          if (READ_ONLY.has(tc.name)) {
            batch.push(execute(tc));
            continue;
          }
          if (batch.length) { await Promise.all(batch); batch = []; }
          await execute(tc);
        }
        if (batch.length) await Promise.all(batch);
        await this.maybeCompact(signal);
        continue;
      }
      // Record the assistant's answer — otherwise the model never sees its
      // own previous replies (in-session or after a session resume).
      this.history.push({ role: "assistant", content: content || finalText || "(no response)" });
      return content || finalText || "(no response)";
    }
    const lastText = finalText || "(stopped: turn limit)";
    this.history.push({ role: "assistant", content: lastText });
    return lastText;
  }

  /** Manual `/compact` — summarise now regardless of size. */
  async compactNow(signal?: AbortSignal): Promise<boolean> {
    return this.compact(signal, true);
  }

  private accountUsage(u?: Usage): void {
    if (!u) return;
    this.totalUsage.prompt_tokens += u.prompt_tokens || 0;
    this.totalUsage.completion_tokens += u.completion_tokens || 0;
    if (u.prompt_tokens) this.calib = calibrate(estimateHistory(this.history), u.prompt_tokens);
    this.emit({ type: "usage", data: this.totalUsage });
  }

  /**
   * Cost control, not just overflow control: every tool result is re-sent on
   * each subsequent request, so a long turn compounds. Keep the working set
   * small by releasing bulk output early, independent of the model's window.
   */
  private enforceBudget(): void {
    const BUDGET = this.opts.workingSetTokens ?? 8_000;
    if (estimateHistory(this.history) <= BUDGET) return;
    const freed = dropBulkContext(this.history, 400);
    if (freed > 0) this.emit({ type: "status", data: { kind: "trim", reclaimed: freed } });
  }

  /** Reduce context if needed: free trimming first, then summarisation. */
  private async maybeCompact(signal?: AbortSignal): Promise<void> {
    // Always try the cheap working-set budget first.
    this.enforceBudget();

    const win = this.opts.contextWindow;
    if (!win) return;

    const overLimit = () => needsCompaction(this.history, { contextWindow: win, threshold: this.opts.compactAt ?? 0.72 });
    if (!overLimit()) return;

    // Tier 1 — free: release skill bodies and old tool outputs.
    const freed = dropBulkContext(this.history);
    if (freed > 0) {
      this.emit({ type: "status", data: { kind: "trim", reclaimed: freed } });
      if (!overLimit()) return;
    }

    // Tier 2 — summarise the older half.
    if (this.compactCooldown > 0) {
      // Just compacted: give the session room to breathe instead of
      // re-summarising on every message.
      this.compactCooldown--;
      return;
    }
    if (await this.compact(signal, false)) {
      // Require the conversation to roughly refill before compacting again.
      this.compactCooldown = 6;
    }
  }

  private async compact(signal?: AbortSignal, manual = false): Promise<boolean> {
    const sys = this.history[0];
    const body = this.history.slice(1);

    // Manual /compact compresses the whole conversation down to a state block.
    // Automatic compaction keeps the recent tail verbatim — but the tail is
    // chosen by tokens, not message count: a session can be over the window
    // with only a handful of huge messages.
    const keepMsgs = manual ? 0 : 4;
    if (body.length === 0) return false;
    if (!manual && body.length <= keepMsgs) {
      // Few messages but still over budget: summarise everything instead of
      // refusing (a dense state block beats an over-window prompt).
      const est = estimateHistory(this.history);
      const win = this.opts.contextWindow ?? 0;
      if (!win || est <= win) return false;
      return this.compact(signal, true);
    }

    const old = manual ? body : body.slice(0, body.length - keepMsgs);
    const recent = manual ? [] : body.slice(body.length - keepMsgs);
    if (!old.length) return false;

    const before = estimateHistory(this.history);
    this.emit({ type: "status", data: { kind: "compacting", before } });
    this.summarising = true;
    let summary = "";
    try {
      const res = await this.client.chat(
        [
          { role: "system", content: "You compress agent sessions into dense state blocks. Be terse and factual." },
          ...old,
          { role: "user", content: COMPACT_PROMPT },
        ],
        [],
        (t) => { summary += t; },
        signal,
      );
      this.accountUsage(res.usage);
      summary = (res.content || summary).trim();
      // Keep the state block dense: ~400 words is plenty to resume.
      if (summary.length > 3000) summary = summary.slice(0, 3000) + "\n…[summary trimmed]";
    } catch (e) {
      this.emit({ type: "status", data: { kind: "compact_failed", error: (e as Error).message } });
      return false;
    } finally {
      this.summarising = false;
    }

    if (!summary) return false;
    const note: ChatMessage = {
      role: "user",
      content:
        `[context compacted to keep the session running — here is the session state]\n\n${summary}\n\n` +
        `[end of state — continue from here; do not repeat completed work]`,
    };
    const next = [sys, note, ...recent];
    const after = estimateHistory(next);
    // Automatic compaction normally must save space. But when the session is
    // well past the window, a dense summary is better than unbounded history —
    // accept it even if the block itself is not smaller.
    const win = this.opts.contextWindow ?? 0;
    const badlyOver = win > 0 && before > win * 1.15;
    if (after >= before && !manual && !badlyOver) {
      this.emit({ type: "status", data: { kind: "compact_skipped", before, after } });
      return false;
    }
    this.history = next;
    this.compactCount++;
    // The learned correction ratio was fitted to the old, much larger prompt.
    this.calib = 1;
    this.compactCooldown = 0;
    this.emit({
      type: "compacted",
      data: { before, after, summary, manual, grew: after >= before },
    });
    return true;
  }

  /** Exposed for /context display + tests. */
  get historySnapshot(): ChatMessage[] {
    return this.history;
  }

  /** Restore a persisted conversation (excludes the system prompt). */
  loadHistory(messages: ChatMessage[]): void {
    this.history = [this.history[0], ...messages];
    this.calib = 1;
    this.compactCooldown = 0;
  }

  /** Messages after the system prompt — the persistable conversation. */
  get exportMessages(): ChatMessage[] {
    return this.history.slice(1);
  }
}

export { estimateTokens };
