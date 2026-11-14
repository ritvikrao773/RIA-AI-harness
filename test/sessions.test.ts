// Sessions: save / list / search / resume roundtrip must work with zero API calls.
import {
  saveSession, loadSession, listSessions, searchSessions,
  latestSessionId, matchSessionId, newSessionId, titleFrom, projectDir, type SessionFile,
} from "../src/sessions.ts";
import { Agent } from "../src/agent.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

// Hermetic: RIA_HOME points at a temp dir, so no real ~/.ria/sessions is touched.
const tmpHome = join(tmpdir(), `ria-sessions-test-${process.pid}`);
process.env.RIA_HOME = tmpHome;
const proj = join(tmpHome, "test-sessions-proj");
rmSync(projectDir(proj), { recursive: true, force: true });
const cwdOf = (f: (cwd: string) => unknown) => f(proj);

// --- save two sessions
const t0 = new Date().toISOString();
const s1: Omit<SessionFile, "updated" | "version"> = {
  id: newSessionId(), title: titleFrom("fix the login bug"), cwd: proj,
  provider: "mesh_api", model: "deepseek/deepseek-v4.1-flash-1017", created: t0,
  messages: [
    { role: "user", content: "fix the login bug" },
    { role: "assistant", content: "The bug was in token refresh order. Fixed." },
  ],
};
saveSession(s1);
const s2: Omit<SessionFile, "updated" | "version"> = {
  id: newSessionId(), title: titleFrom("write bench harness"), cwd: proj,
  provider: "mesh_api", model: "deepseek/deepseek-v4.1-flash-1017", created: t0,
  messages: [
    { role: "user", content: "write bench harness" },
    { role: "assistant", content: "Done. bench.mjs measures tokens per task." },
  ],
};
saveSession(s2);
// a tiny delay-in-a-row save to keep updated distinct is unnecessary; sort is stable enough

const all = cwdOf((c) => listSessions(c));
check("lists both sessions", all.length === 2, `got ${all.length}`);

const latest = cwdOf((c) => latestSessionId(c));
check("latest returns an id", !!latest, String(latest));

// --- load roundtrip
const loaded = cwdOf((c) => loadSession(c, s1.id));
check("load restores messages", loaded?.messages.length === 2 && loaded.messages[1].content.includes("token refresh"), "");
check("load restores title", loaded?.title === s1.title, loaded?.title ?? "");

// --- search
const hits = cwdOf((c) => searchSessions(c, "token refresh"));
check("search finds content", hits.length >= 1 && hits[0].snippet.includes("token refresh"), JSON.stringify(hits).slice(0, 120));
const weird = cwdOf((c) => searchSessions(c, "(not a regex?["));
check("search regex-safe with plain text", weird.length === 0);
// --- prefix matching
check("prefix match resolves unique", cwdOf((c) => matchSessionId(c, s1.id.slice(0, 16))) === s1.id, "");
check("prefix match exact", cwdOf((c) => matchSessionId(c, s1.id)) === s1.id, "");

// --- agent resume roundtrip (no API)
const fakeClient = {
  chat: async () => ({ content: "The bug was in token refresh order. Fixed.", toolCalls: [], usage: undefined }),
};
const agent = new Agent(fakeClient as never, [], () => {}, { contextWindow: 1000 });
agent.loadHistory(loaded!.messages);
check("agent history restored", agent.exportMessages.length === 2);
check("system prompt still first", (agent.historySnapshot[0] as { role: string }).role === "system");
check("estimatedTokens > 0 after restore", agent.estimatedTokens > 0);

// --- a full turn records the assistant's answer (regression: answers were
// previously lost, so saved sessions had no replies and resume was useless)
const agent2 = new Agent(fakeClient as never, [], () => {}, { contextWindow: 1000 });
await agent2.run("hello");
check("assistant answer stored in history", agent2.exportMessages.length === 2 && agent2.exportMessages[1].role === "assistant", JSON.stringify(agent2.exportMessages.map((m) => m.role)));
const savedTurn: Omit<SessionFile, "updated" | "version"> = {
  id: newSessionId(), title: "turn test", cwd: proj, provider: "mesh_api",
  model: "m", created: t0, messages: agent2.exportMessages,
};
saveSession(savedTurn);
const reloaded = cwdOf((c) => loadSession(c, savedTurn.id));
const agent3 = new Agent(fakeClient as never, [], () => {}, { contextWindow: 1000 });
agent3.loadHistory(reloaded!.messages);
check("roundtrip: full conversation survives save+resume", agent3.exportMessages.length === 2 && agent3.exportMessages[1].role === "assistant", `${agent3.exportMessages.length} messages`);
const cleanedTurn = cwdOf((c) => matchSessionId(c, savedTurn.id));
check("turn session findable", cleanedTurn === savedTurn.id);

// --- save clears isolation
rmSync(projectDir(proj), { recursive: true, force: true });
check("cleanup", !listSessions(proj).length);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
