// Verify the tier-1 release path and its event, end to end in the agent.
import { Agent } from "../src/agent.ts";
import type { ChatMessage, LLMClient } from "../src/llm.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

class Fake {
  usage = { prompt_tokens: 0, completion_tokens: 0 };
  replies: Array<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }>;
  constructor(replies: Fake["replies"]) { this.replies = replies; }
  async chat(_m: ChatMessage[], _t: unknown[], onText?: (s: string) => void) {
    const r = this.replies.shift() ?? { content: "done", toolCalls: [] };
    if (r.content) onText?.(r.content);
    return { ...r, usage: this.usage };
  }
}

const events: Array<{ type: string; data: any }> = [];
const fake = new Fake([
  { content: "", toolCalls: [{ id: "1", name: "read_file", arguments: '{"path":"x"}' }] },
  { content: "ok", toolCalls: [] },
]);
const agent = new Agent(fake as unknown as LLMClient, [], (e) => events.push(e as any), { contextWindow: 1_000_000 });
// Force a huge tool result by pointing read_file at a big real file.
const { writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const big = join(tmpdir(), "ria_big_tool.txt");
writeFileSync(big, "q".repeat(40_000));
fake.replies = [
  { content: "", toolCalls: [{ id: "1", name: "read_file", arguments: JSON.stringify({ path: big }) }] },
  { content: "ok", toolCalls: [] },
];
await agent.run("read the big file");

const toolMsg = agent.historySnapshot.find((m) => m.role === "tool");
check("oversized tool output is capped in history", (toolMsg?.content?.length ?? 0) < 13_000, `len=${toolMsg?.content?.length}`);
check("cap keeps a notice", toolMsg?.content?.includes("chars omitted") === true);
const trim = events.find((e) => e.type === "status" && e.data?.kind === "trim");
check("trim event emitted with reclaimed tokens", !!trim && trim.data.reclaimed > 0, JSON.stringify(trim?.data));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
