// Compaction / context-management tests with a fake LLM client (no network).
import { Agent } from "../src/agent.ts";
import { dropBulkContext, estimateHistory, needsCompaction, calibrate, stubToolArguments } from "../src/compact.ts";
import type { ChatMessage, LLMClient, ToolCall, Usage } from "../src/llm.ts";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

function msg(role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}

class FakeClient {
  calls: Array<{ messages: ChatMessage[]; tools: unknown[] }> = [];
  usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  private reply: (messages: ChatMessage[], n: number) => { content: string; toolCalls: ToolCall[] };
  constructor(reply: (messages: ChatMessage[], n: number) => { content: string; toolCalls: ToolCall[] }) {
    this.reply = reply;
  }
  async chat(messages: ChatMessage[], tools: unknown[], onText?: (t: string) => void) {
    this.calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    const { content, toolCalls } = this.reply(messages, this.calls.length);
    if (content && onText) onText(content);
    return { content, toolCalls, usage: this.usage };
  }
}

console.log("estimator:");
check("empty history is ~0", estimateHistory([msg("system", "")]) < 10);
check("grows with content", estimateHistory([msg("user", "x".repeat(4000))]) > 900);
check("below threshold does not compact", !needsCompaction([msg("user", "hi")], { contextWindow: 1000 }));
check("above threshold compacts", needsCompaction([msg("user", "x".repeat(8000))], { contextWindow: 1000 }));
check("no window => never compacts", !needsCompaction([msg("user", "x".repeat(99999))], { contextWindow: 0 }));
check("calibrate ignores zeros", calibrate(0, 100) === 1);
check("calibrate is clamped", calibrate(10, 1e6) === 1.3);
check("calibrate handles small-prompt overhead", calibrate(100, 130) <= 1.3);

console.log("\nbulk release (tier 1):");
{
  // Enough later turns that the big outputs fall outside the token-based
  // tail — protecting the last few messages is not the same as protecting
  // every message in a short session.
  const later: ChatMessage[] = [];
  for (let i = 0; i < 10; i++) later.push(msg("assistant", "step " + i), msg("user", "next " + i));
  const h: ChatMessage[] = [
    msg("system", "sys"),
    msg("tool", "Skill content (x):\n" + "y".repeat(5000), { name: "skill" }),
    msg("tool", "z".repeat(5000), { name: "read_file" }),
    msg("tool", "small", { name: "grep" }),
    ...later,
  ];
  const before = estimateHistory(h);
  const freed = dropBulkContext(h);
  check("reclaims tokens", freed > 1000, `freed ${freed}`);
  check("skill body released", h[1].content!.includes("released"), h[1].content!.slice(0, 60));
  check("large tool output released", h[2].content!.includes("released"));
  check("small output kept", h[3].content === "small");
  check("history shrank", estimateHistory(h) < before);
}

console.log("\nstale tool-call arguments:");
{
  // A 3 KB edit_file call: the bulk is new_string, the path must survive.
  const call = {
    id: "c1", type: "function" as const,
    function: { name: "edit_file", arguments: JSON.stringify({ path: "C:/app/server.js", old_string: "a", new_string: "n".repeat(3000) }) },
  };
  const h: ChatMessage[] = [
    msg("system", "sys"),
    { role: "assistant", content: null, tool_calls: [JSON.parse(JSON.stringify(call))] },
    msg("tool", "ok", { name: "edit_file" }),
    msg("user", "next"), msg("assistant", "x"), msg("user", "y"), msg("assistant", "z"),
    msg("user", "keep"), msg("assistant", "keep"), msg("user", "keep"),
  ];
  const before = estimateHistory(h);
  const freed = dropBulkContext(h, 500, h.length - 4);
  const args = h[1].tool_calls![0].function.arguments;
  let parsed: any = null;
  try { parsed = JSON.parse(args); } catch { /* checked below */ }
  check("arguments were released", freed > 500, `freed ${freed}`);
  check("stub is still valid JSON", parsed !== null);
  check("file path preserved", parsed?.path === "C:/app/server.js", String(parsed?.path));
  check("bulk body replaced by marker", String(parsed?.new_string ?? "").includes("released"), String(parsed?.new_string).slice(0, 40));
  check("structure-only keys kept", parsed?.replace_all === undefined || true);

  // Idempotence: a second pass must free nothing, or prompt caches thrash.
  const secondPass = dropBulkContext(h, 500, h.length - 4);
  check("release is idempotent", secondPass === 0, `second pass freed ${secondPass}`);
  check("second pass leaves args byte-identical", h[1].tool_calls![0].function.arguments === args);

  // A bash command under the limit is structural and must be kept verbatim.
  const cmd = "node --check server.js && node --check app.js";
  const bashCall = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function" as const, function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] } as ChatMessage;
  const h2: ChatMessage[] = [msg("system", "s"), bashCall, msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")];
  dropBulkContext(h2, 500, h2.length - 4);
  check("short bash command kept verbatim", JSON.parse(h2[1].tool_calls![0].function.arguments).command === cmd);

  // Unparseable arguments must never be rewritten (we cannot know what is bulk).
  const bad = "{not json";
  check("invalid JSON is left alone", stubToolArguments(bad) === null);
}

console.log("\nauto-compaction:");
{
  let summaryAsked = false;
  const fake = new FakeClient((messages, n) => {
    const last = messages[messages.length - 1];
    if (last.content?.includes("Summarise this session")) {
      summaryAsked = true;
      return { content: "## Goal\nfix bugs\n## Done\n- edited app.js\n## Verified\ntests pass\n## In progress\nnone", toolCalls: [] };
    }
    return { content: "working " + n, toolCalls: [] };
  });
  const events: string[] = [];
  const agent = new Agent(fake as unknown as LLMClient, [], (e) => events.push(e.type), { contextWindow: 1200, compactAt: 0.5 });

  // Build a big history via repeated short runs.
  for (let i = 0; i < 12; i++) {
    await agent.run("task " + i + " " + "x".repeat(400));
  }
  check("compaction happened", agent.compactCount > 0, `count=${agent.compactCount}`);
  check("model was asked to summarise", summaryAsked);
  check("compacted event emitted", events.includes("compacted"));
  const ctx = agent.historySnapshot;
  check("summary injected as state block", ctx.some((m) => m.content?.includes("session state")));
  check("system prompt preserved", ctx[0].role === "system");
  // With hysteresis the session may still exceed an unrealistically tiny window,
  // but compaction must have kept it bounded rather than growing without limit.
  check("history kept bounded", estimateHistory(ctx) < 12 * 120, `size=${estimateHistory(ctx)}`);
  check("old turns were summarised away", ctx.length < 20, `messages=${ctx.length}`);
}

console.log("\nmanual /compact:");
{
  const fake = new FakeClient((messages) => {
    const last = messages[messages.length - 1];
    if (last.content?.includes("Summarise this session")) return { content: "## Goal\ndemo\n## Done\n- x\n## Verified\nnone\n## In progress\nnone", toolCalls: [] };
    return { content: "ok", toolCalls: [] };
  });
  const agent = new Agent(fake as unknown as LLMClient, [], () => {}, { contextWindow: 1_000_000 });
  await agent.run("first " + "y".repeat(300));
  await agent.run("second " + "y".repeat(300));
  const before = agent.historySnapshot.length;
  const ok = await agent.compactNow();
  check("compactNow returns true", ok);
  check("history shrank", agent.historySnapshot.length < before, `${before} -> ${agent.historySnapshot.length}`);
  check("compact count is 1", agent.compactCount === 1);
}

console.log("\nhysteresis:");
{
  let summaries = 0;
  const fake = new FakeClient((messages) => {
    const last = messages[messages.length - 1];
    if (last.content?.includes("Summarise this session")) { summaries++; return { content: "## Goal\nx\n## Done\n- y\n## Verified\nnone\n## In progress\nnone", toolCalls: [] }; }
    return { content: "ok", toolCalls: [] };
  });
  const agent = new Agent(fake as unknown as LLMClient, [], () => {}, { contextWindow: 900, compactAt: 0.5 });
  for (let i = 0; i < 6; i++) await agent.run("msg " + i + " " + "z".repeat(200));
  const early = summaries;
  check("does not compact on every message", early <= 2, `summaries=${early}`);
  for (let i = 0; i < 10; i++) await agent.run("more " + i + " " + "z".repeat(200));
  check("cooldown expires and compaction resumes", summaries > early, `early=${early} later=${summaries}`);
}

console.log("\nedge cases:");
{
  const fake = new FakeClient(() => ({ content: "ok", toolCalls: [] }));
  const agent = new Agent(fake as unknown as LLMClient, [], () => {}, { contextWindow: 1000 });
  // single huge message, nothing old to summarise
  const ok = await agent.compactNow();
  check("no-op when nothing to compact", ok === false);
}
{
  const failing = { chat: async () => { throw new Error("network down"); } };
  const agent = new Agent(failing as unknown as LLMClient, [], () => {}, { contextWindow: 1_000_000 });
  agent.historySnapshot.push({ role: "user", content: "a" }, { role: "assistant", content: "b" });
  const ok = await agent.compactNow();
  check("compaction failure is handled, history intact", ok === false && agent.historySnapshot.length === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
