/**
 * Context compaction — keeps a long session alive without losing the thread.
 *
 * Two tiers:
 *  1. Cheap (no API call): drop stale skill bodies and old tool outputs.
 *  2. Compaction: when the estimated prompt crosses the model's usable window,
 *     summarise the older half of the conversation into a dense state block
 *     ("compact skill") and continue from it.
 *
 * Estimates are deliberately conservative; the real prompt_tokens from the
 * provider is used to calibrate the estimator after each turn.
 */
import type { ChatMessage } from "./llm.js";
import { estimateTokens } from "./llm.js";

export const COMPACT_PROMPT = `Summarise this session so work can continue after context is compacted.
Write ONLY the state block, no preamble, max ~400 words, in this exact shape:

## Goal
<what the user ultimately wants, 1-2 lines>

## Done
<changes made so far — files touched, what changed. Bullet list, file paths exact.>

## Verified
<what was actually run and the result (tests/build/commands). Only confirmed facts.>

## In progress
<the exact next step if one was underway, else "none">

## Constraints
<user preferences, conventions, decisions to respect. Omit if none.>

Do not invent anything. Drop conversational filler. Keep exact file paths,
command lines, error text and identifiers — they are needed to resume.`;

/** Markers used to recognise droppable content. */
const SKILL_MARKER = "Skill content";

/** Placeholder left where an old tool call's bulk argument used to be. */
export const RELEASED_ARGS = "…[released — re-read the file if you need the old text]";

/**
 * Argument keys that carry the *intent* of a call and must survive release:
 * a replayed `edit_file` must still say which file, a `bash` call which
 * command. Everything else (file bodies, search strings) is bulk.
 */
const STRUCTURAL_KEYS = new Set([
  "path", "file_path", "directory", "pattern", "include", "name",
  "offset", "limit", "timeout_ms", "replace_all",
]);

/** Keep this many chars of a structural string (e.g. a bash command). */
const STRUCTURAL_MAX = 200;

/**
 * Rewrite one tool call's arguments into a schema-valid stub: structural keys
 * are kept, bulk string values are replaced by a marker. Returns the new JSON,
 * or null when nothing would change (already released / too small / not JSON).
 *
 * Idempotent on purpose: re-running over an already-stubbed call changes
 * nothing, so it cannot invalidate a provider's prompt cache repeatedly.
 */
export function stubToolArguments(argsJson: string, minChars = 400): string | null {
  if (!argsJson || argsJson.length < minChars) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null; // never corrupt a call we cannot parse
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    if (value.startsWith(RELEASED_ARGS)) {
      out[key] = value; // already released; keep byte-identical
      continue;
    }
    if (STRUCTURAL_KEYS.has(key) && value.length <= STRUCTURAL_MAX) {
      out[key] = value;
      continue;
    }
    out[key] = STRUCTURAL_KEYS.has(key)
      ? value.slice(0, STRUCTURAL_MAX) + "…"
      : `${RELEASED_ARGS} (${value.length} chars)`;
    changed = true;
  }
  return changed ? JSON.stringify(out) : null;
}

export interface CompactOptions {
  /** Model context window in tokens. */
  contextWindow: number;
  /** Fraction of the window we allow before compacting. */
  threshold?: number;
  /** Keep this many recent messages verbatim after compaction. */
  keepRecent?: number;
}

/** Rough size of the conversation, in tokens. */
export function estimateHistory(history: ChatMessage[]): number {
  let n = 0;
  for (const m of history) {
    n += estimateTokens(m.content || "") + 4;
    if (m.tool_calls) for (const tc of m.tool_calls) n += estimateTokens(tc.function.arguments) + estimateTokens(tc.function.name) + 8;
  }
  return n;
}

/**
 * Index before which messages may be trimmed. The tail is protected by
 * *both* counts: up to `maxMessages` recent messages, but never more than
 * `maxTailTokens` of them. Message count alone is the wrong unit — one 8 KB
 * tool result outweighs twenty small turns, and protecting eight messages
 * would blow past a small model's whole window.
 */
export function trimCutoff(history: ChatMessage[], maxMessages = 8, maxTailTokens = 1_500): number {
  let tokens = 0;
  let i = history.length;
  while (i > 0 && history.length - i < maxMessages) {
    const m = history[i - 1];
    let t = estimateTokens(m.content || "") + 4;
    for (const tc of m.tool_calls ?? []) {
      t += estimateTokens(tc.function.arguments) + estimateTokens(tc.function.name) + 8;
    }
    // Always keep the newest message, even if it alone exceeds the budget:
    // it is the call or answer the model is working from.
    if (i < history.length && tokens + t > maxTailTokens) break;
    tokens += t;
    i--;
  }
  return i;
}

/**
 * Tier 1: free reduction. Skill bodies, old large tool outputs, and — the
 * biggest win — the bulk arguments of stale tool calls (a full file body
 * echoed into `edit_file`) are collapsed first.
 *
 * `cutoff` is the exclusive index before which messages may be trimmed;
 * it defaults to "everything except the last 4". Every rewrite is
 * idempotent, so calling this twice on the same history frees nothing the
 * second time and a provider's prompt cache is not invalidated for free.
 * Returns tokens reclaimed.
 */
export function dropBulkContext(history: ChatMessage[], minToolChars = 500, cutoff?: number): number {
  const before = estimateHistory(history);
  // Skip the recent tail: the model still needs the current step.
  const stop = cutoff ?? trimCutoff(history);
  const noun = (name?: string) => (name === "bash" ? "command output" : `${name ?? "tool"} output`);
  for (let i = 0; i < stop; i++) {
    const m = history[i];
    if (m.role === "tool" && m.content) {
      if (m.content.startsWith(SKILL_MARKER) || m.content.length > minToolChars) {
        m.content = `[${noun(m.name)} released to save context — re-run if needed]`;
      }
    } else if (m.role === "assistant") {
      // A call's arguments can dwarf its result: keep the file path and the
      // command, drop the file bodies that were rewritten.
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const stub = stubToolArguments(tc.function.arguments, minToolChars);
          if (stub) tc.function.arguments = stub;
        }
      } else if ((m.content?.length || 0) > 2000) {
        // long narration from an earlier turn; keep the head
        m.content = m.content!.slice(0, 600) + "\n…[truncated earlier narration]";
      }
    }
  }
  return before - estimateHistory(history);
}

/**
 * Shrink one oversized tool result as it arrives, keeping enough to be useful:
 * head + tail plus a pointer, instead of the whole payload.
 */
export function shrinkToolOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    `\n\n…[${text.length - maxChars} chars omitted — full output not kept; re-run the tool or read a smaller range if you need it]\n\n` +
    text.slice(text.length - tail)
  );
}

/** True when the session should be compacted. */
export function needsCompaction(history: ChatMessage[], opts: CompactOptions): boolean {
  if (!opts.contextWindow) return false;
  const threshold = opts.threshold ?? 0.72;
  return estimateHistory(history) > opts.contextWindow * threshold;
}

/**
 * Ratio between the estimator and the provider's real prompt_tokens.
 * Lets us correct for chat-template overhead we cannot see — but the reported
 * count includes fixed per-request overhead, which badly skews small prompts,
 * so the correction is deliberately narrow.
 */
export function calibrate(estimated: number, actualPromptTokens: number): number {
  if (!estimated || !actualPromptTokens) return 1;
  const raw = actualPromptTokens / estimated;
  return Math.min(1.3, Math.max(0.8, raw));
}
