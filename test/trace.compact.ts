// Why didn't auto-compaction fire? Trace the decision on a real-ish history.
import { estimateHistory, needsCompaction } from "../src/compact.ts";
import type { ChatMessage } from "../src/llm.ts";

const h: ChatMessage[] = [
  { role: "system", content: "x".repeat(1200) },
  { role: "user", content: "/read medium.txt and remember the marker word" },
  { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: '{"path":"medium.txt"}' } }] },
  { role: "tool", tool_call_id: "1", name: "read_file", content: "y".repeat(8600) },
  { role: "assistant", content: "The marker word is CHIMERA." },
];

const est = estimateHistory(h);
console.log("estimated tokens:", est);
console.log("window 2500, threshold 0.72 → limit", 2500 * 0.72);
console.log("needsCompaction:", needsCompaction(h, { contextWindow: 2500 }));
