/**
 * Model-id hygiene for the `/model` picker and bulk refresh.
 *
 * A provider's /models list is not all chat models: embedding, speech,
 * rerank and moderation endpoints are listed alongside them (a real
 * OpenRouter-style listing had 53 of 1345). Nothing is deleted — ids are
 * classified so the picker can hide non-chat entries by default and
 * `--prune` can drop only unambiguous junk (blank / duplicate ids).
 */

export type ModelKind = "chat" | "embedding" | "speech" | "rerank" | "moderation";

const PATTERNS: Array<[ModelKind, RegExp]> = [
  ["embedding", /(^|[-/_.])(embed|embedding|embeddings)([-/_.]|$)/i],
  ["speech", /(^|[-/_.])(whisper|tts|speech|audio-(preview|speech)|voice)([-/_.]|$)|tts-/i],
  ["rerank", /(^|[-/_.])(rerank|reranking|reranker)([-/_.]|$)/i],
  ["moderation", /(^|[-/_.])(moderation|guard|safety-check)([-/_.]|$)/i],
];

/** Classify a model id. Anything unrecognised is assumed to be a chat model. */
export function classifyModel(id: string): ModelKind {
  const s = id.trim();
  for (const [kind, rx] of PATTERNS) if (rx.test(s)) return kind;
  return "chat";
}

/** True when the id can be used for chat completions with Ria. */
export function isChatModel(id: string): boolean {
  return classifyModel(id) === "chat";
}

export interface ModelJunk {
  /** Ids that are blank or whitespace-only (removed). */
  blank: string[];
  /** Case-insensitive duplicates after the first occurrence (removed). */
  duplicates: string[];
}

/**
 * Find ids that are safe to delete without losing information:
 * blank entries and case-insensitive duplicates. Chat/non-chat is
 * never a reason to delete.
 */
export function findJunkModels(ids: readonly string[]): ModelJunk {
  const blank: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id.trim()) { blank.push(id); continue; }
    const norm = id.trim().toLowerCase();
    if (seen.has(norm)) duplicates.push(id);
    else seen.add(norm);
  }
  return { blank, duplicates };
}

/** Split a model map into chat and non-chat ids, preserving order. */
export function splitModels(ids: readonly string[]): { chat: string[]; other: string[] } {
  const chat: string[] = [];
  const other: string[] = [];
  for (const id of ids) (isChatModel(id) ? chat : other).push(id);
  return { chat, other };
}

/**
 * One-line summary of a provider's model list for `/providers` and
 * `ria providers`: a short preview plus chat/non-chat counts, so a list of
 * 1000+ ids never floods the terminal.
 */
export function summarizeModels(ids: readonly string[], previewCount = 3): string {
  if (!ids.length) return "";
  const { chat, other } = splitModels(ids);
  const shown = [...chat, ...other].slice(0, previewCount);
  const rest = ids.length - shown.length;
  const preview = shown.join(", ") + (rest > 0 ? `, +${rest} more` : "");
  if (!other.length) return `${preview}  (${chat.length} chat)`;
  return `${preview}  (${chat.length} chat · ${other.length} non-chat)`;
}
