// The real failing shape: few messages, one huge tool result, small window.
import { Agent } from "../src/agent.ts";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, LLMClient } from "../src/llm.ts";

const events: Array<{ type: string; data: any }> = [];
let summaryCalls = 0;
const fake = {
  usage: { prompt_tokens: 0, completion_tokens: 0 },
  async chat(m: ChatMessage[], _t: unknown[], onText?: (s: string) => void) {
    const last = m[m.length - 1];
    if (last.content?.includes("Summarise this session")) {
      summaryCalls++;
      const s = "## Goal\nfind token\n## Done\n- read notes.md, token is PLUTO-9\n## Verified\nnone\n## In progress\nnone";
      onText?.(s);
      return { content: s, toolCalls: [], usage: this.usage };
    }
    if (m.length === 1 || last.role === "user") {
      return { content: "", toolCalls: [{ id: "t" + m.length, name: "read_file", arguments: JSON.stringify({ path: big }) }], usage: this.usage };
    }
    const r = "The token is PLUTO-9.";
    onText?.(r);
    return { content: r, toolCalls: [], usage: this.usage };
  },
};

const big = join(tmpdir(), "ria_trace_big.txt");
writeFileSync(big, "token is PLUTO-9\n" + "filler line\n".repeat(500));

const agent = new Agent(fake as unknown as LLMClient, [], (e) => events.push(e as any), { contextWindow: 1500 });
await agent.run("read " + big + " and find the token");
console.log("after turn 1 → messages:", agent.historySnapshot.length, "est:", agent.estimatedTokens, "/1500");
console.log("compactions:", agent.compactCount, "summaryCalls:", summaryCalls);

await agent.run("what is the token?");
console.log("after turn 2 → messages:", agent.historySnapshot.length, "est:", agent.estimatedTokens, "/1500");
console.log("compactions:", agent.compactCount, "summaryCalls:", summaryCalls);
console.log("events:", events.filter((e) => e.type === "status" || e.type === "compacted").map((e) => e.type === "compacted" ? `compacted ${e.data.before}->${e.data.after}` : `${e.data.kind}`).join(", ") || "(none)");

const ok = agent.compactCount > 0 && summaryCalls > 0;
console.log(ok ? "\nPASS: auto-compaction fired on the huge-message case" : "\nFAIL: still no compaction");
process.exit(ok ? 0 : 1);
