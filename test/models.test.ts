// Model-id hygiene: classification, junk detection, chat/non-chat split.
import { classifyModel, isChatModel, findJunkModels, splitModels } from "../src/models.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

console.log("classification:");
const cases: Array<[string, string]> = [
  ["deepseek/deepseek-v4.1-flash-1017", "chat"],
  ["openai/gpt-6-luna", "chat"],
  ["z-ai/glm-5v-turbo", "chat"],
  ["text-embedding-3-large", "embedding"],
  ["openai/text-embedding-3-small", "embedding"],
  ["baai/bge-m3", "chat"], // no "embed" token → treated as chat (conservative)
  ["qwen/qwen3-embedding-8b", "embedding"],
  ["alibaba/qwen3-tts-1-7b-base", "speech"],
  ["openai/whisper-large-v3", "speech"],
  ["tts-1-hd", "speech"],
  ["cohere/rerank-v3.5", "rerank"],
  ["bge-reranker-v2-m3", "rerank"],
  ["openai/moderation-omni", "moderation"],
  ["ollama/qwen3:30b", "chat"],
];
for (const [id, kind] of cases) {
  check(`${id} → ${kind}`, classifyModel(id) === kind, classifyModel(id));
}
check("isChatModel true for chat", isChatModel("gpt-5") === true);
check("isChatModel false for embedding", isChatModel("text-embedding-3-large") === false);
check("case-insensitive", classifyModel("TEXT-EMBEDDING-3") === "embedding");
check("surrounding whitespace trimmed", classifyModel("  whisper-1  ") === "speech");

console.log("\njunk detection:");
const j1 = findJunkModels(["a", "b", "a", "  ", "", "B"]);
check("blank ids found", j1.blank.length === 2, JSON.stringify(j1.blank));
check("duplicates found (case-insensitive)", j1.duplicates.length === 2, JSON.stringify(j1.duplicates));
check("unique list has no junk", findJunkModels(["x", "y"]).blank.length === 0 && findJunkModels(["x", "y"]).duplicates.length === 0);
check("non-chat ids are never junk", findJunkModels(["text-embedding-3-large"]).duplicates.length === 0);

console.log("\nsplit:");
const sp = splitModels(["gpt-5", "text-embedding-3-large", "whisper-1", "glm-4.6", "rerank-v3"]);
check("chat list preserves order", sp.chat.join(",") === "gpt-5,glm-4.6", sp.chat.join(","));
check("other list has the rest", sp.other.length === 3, sp.other.join(","));
check("empty input splits cleanly", splitModels([]).chat.length === 0 && splitModels([]).other.length === 0);

// realistic shape from a live OpenRouter-style listing
const live = ["deepseek/deepseek-v4.1-flash-1017", "openai/gpt-6-luna", "alibaba/qwen3-tts-1-7b-base", "openai/text-embedding-3-large"];
const liveSplit = splitModels(live);
check("realistic listing keeps chat models visible", liveSplit.chat.length === 2, liveSplit.chat.join(","));
check("realistic listing hides tts + embedding", liveSplit.other.length === 2, liveSplit.other.join(","));

// --- provider summary (summarizeModels) -----------------------------------
console.log("\nprovider summary:");
const { summarizeModels } = await import("../src/models.ts");
check("empty list summarises to ''", summarizeModels([]) === "");
const chatOnly = summarizeModels(["gpt-5", "claude-sonnet-4-5"]);
check("chat-only shows preview + chat count", chatOnly === "gpt-5, claude-sonnet-4-5  (2 chat)", chatOnly);
const mixedSum = summarizeModels(["gpt-5", "text-embedding-3-large", "whisper-1", "glm-4.6"]);
check("mixed shows chat and non-chat counts", /\(2 chat · 2 non-chat\)$/.test(mixedSum), mixedSum);
check("mixed preview lists chat models first", mixedSum.startsWith("gpt-5, glm-4.6"), mixedSum);
const big = Array.from({ length: 1282 }, (_, i) => `vendor/model-${i}`)
  .concat(Array.from({ length: 63 }, (_, i) => `text-embedding-${i}`));
const bigSum = summarizeModels(big);
check("huge list is shortened with +N more", /\+1342 more/.test(bigSum), bigSum);
check("huge list keeps real counts", /\(1282 chat · 63 non-chat\)$/.test(bigSum), bigSum);
check("huge summary stays short", bigSum.length < 120, String(bigSum.length));
check("preview count is respected", summarizeModels(["a", "b", "c", "d"], 2).startsWith("a, b, +2 more"));
check("exact-fit preview has no +N", !summarizeModels(["a", "b"], 2).includes("more"));

console.log(fail ? `\n${fail} FAIL / ${pass} ok` : `\nall ${pass} ok`);
process.exit(fail ? 1 : 0);