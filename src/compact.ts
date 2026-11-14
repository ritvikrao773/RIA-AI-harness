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
 * Tier 1: free reduction. Skill bodies and old large tool outputs are the
 * biggest, least valuable blocks — collapse them first.
 * Returns tokens reclaimed.
 */
export function dropBulkContext(history: ChatMessage[], minToolChars = 500): number {
  const before = estimateHistory(history);
  // Skip the last few messages: the model still needs the current step.
  const protectedTail = 4;
  for (let i = 0; i < history.length - protectedTail; i++) {
    const m = history[i];
    if (m.role === "tool" && m.content) {
      if (m.content.startsWith(SKILL_MARKER) || m.content.length > minToolChars) {
        m.content = `[${m.name ?? "tool"} output released to save context — re-run if needed]`;
      }
    } else if (m.role === "assistant" && (m.content?.length || 0) > 2000 && !m.tool_calls?.length) {
      // long narration from an earlier turn; keep the head
      m.content = m.content!.slice(0, 600) + "\n…[truncated earlier narration]";
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
