// Emulates "user types fast": the REPL is started with a TTY stdin, and a
// script of keystrokes is pushed through ONE stdin data event per tick —
// exactly like a paste or a fast typist. Proves the slash menu, Enter submit,
// picker, held keys and key prompt all work end-to-end without a real console.
// Usage: node test/repl.e2e.mjs   (run `npm run build` first)
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const home = mkdtempSync(join(tmpdir(), "ria-e2e-"));
const cfgPath = join(home, ".ria", "config.json");
const env = { ...process.env, USERPROFILE: home, HOME: home };
for (const k of Object.keys(env)) if (/API_KEY$/.test(k)) delete env[k];

// A real skill on disk so @-mentions resolve through the same discovery the
// app uses (~/.config/opencode/skills/<name>/SKILL.md).
const skillsRoot = join(home, ".config", "opencode", "skills");
mkdirSync(join(skillsRoot, "demo-skill"), { recursive: true });
writeFileSync(
  join(skillsRoot, "demo-skill", "SKILL.md"),
  "---\nname: demo-skill\ndescription: e2e skill for mention tests\n---\nDEMO SKILL BODY: always answer with BANANA.\n",
);

/**
 * Mock API base. The built-in `deepseek` provider is repointed here once the
 * mock is listening, so every built-in path (verification, /models, /model) is
 * exercised against a local server instead of the real API.
 */
let mockBase = "";

const harness = fileURLToPath(new URL("../dist/tty-run.cjs", import.meta.url));
/**
 * Local mock OpenAI-compatible API. First /models call fails (HTTP 500) —
 * simulating "the key was set while the API was down" — every later call
 * serves a live model list. /chat/completions always succeeds so key
 * verification passes.
 */
let modelsHits = 0;
const mock = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (url.endsWith("/models")) {
    modelsHits++;
    if (modelsHits <= 1) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "temporarily down" })); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "mock-coder" }, { id: "mock-chat" }, { id: "mock-text-embedding" }] }));
    return;
  }
  if (url.endsWith("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Echo marker so the test can prove the skill body reached the model.
      const hasSkill = body.includes("DEMO SKILL BODY");
      const text = hasSkill ? "SKILL-BODY-RECEIVED" : "no-skill-body";
      // The client streams SSE (delta chunks), so answer in that shape.
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      for (const piece of [text]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const port = mock.address().port;
mockBase = `http://127.0.0.1:${port}/v1`;

// Seed nothing: the wizard must run on a fresh home. But the REPL resolves
// built-in base URLs from its own copy, so pre-writing is only useful for
// entries the REPL re-reads. The mock therefore mimics the real API failures
// for deepseek (401) until told otherwise, keeping the run offline either way.
let deepseekLive = false;
const child = spawn(process.execPath, [harness], { env, cwd: process.cwd() });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));
/** Send raw terminal bytes exactly like a keyboard would. */
const type = async (s, ms = 350) => { child.stdin.write(JSON.stringify({ keys: s }) + "\n"); await sleep(ms); };
const screen = () => out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
/** Wait until the screen shows `needle` (network + async UI can be slow). */
const waitFor = async (needle, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (screen().includes(needle)) return true;
    await sleep(100);
  }
  return false;
};

// --- fresh install: onboarding wizard must appear -------------------------
await sleep(1500);
check("first run shows the provider wizard", screen().includes("choose your provider"), screen().slice(-300));
check("wizard offers built-ins", /deepseek/.test(screen()));
await type("\x1b[A"); // one Up wraps to "+ custom API" (last item, page 2)
await sleep(400);
check("wizard offers custom API (second picker page)", /custom API/.test(screen()), screen().slice(-300));
await type("\r");
await type("mybox\r");
await type(`http://127.0.0.1:${port}/v1\r`);
await type("sk-e2e-secret\r", 3000);
const cfgText = readFileSync(cfgPath, "utf8");
check("custom provider + key saved to config", cfgText.includes("mybox") && cfgText.includes("sk-e2e-secret"));
check("wizard finished and REPL started", screen().includes("mybox"), screen().slice(-300));

// Point built-in deepseek at the mock so later steps never hit the real API.
{
  const c = JSON.parse(readFileSync(cfgPath, "utf8"));
  c.providers.deepseek.baseURL = mockBase;
  writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}

// --- "/" opens the command menu ------------------------------------------
out = "";
await type("/", 400);
const menu = screen();
check("typing / shows the command menu", menu.includes("/help") && menu.includes("/provider") && menu.includes("/model"), menu.slice(-300));
check("the slash itself was not swallowed", menu.includes("❯ /"), menu.slice(-200));

// finish the command in the same menu session, then Enter runs it
await type("providers\r", 700);
check("/providers runs from the menu", /key|no key|sk-e2e|deepseek/.test(screen().split("\n").slice(-12).join("\n")), screen().slice(-500));
check("/providers lists the mined built-ins", /xai/.test(screen()) && /moonshot/.test(screen()) && /cerebras/.test(screen()) && /mistral/.test(screen()), screen().slice(-500));

// --- /provider opens the picker; Esc returns to the prompt ----------------
await type("\x15", 200); // clear any pending input first (Ctrl+U)
out = "";
await type("/provider\r", 600);
check("/provider opens the picker", screen().includes("↑↓ move") && screen().includes("deepseek"), screen().slice(-300));
await type("\x1b", 500);
out = "";
await type("x", 300);
check("Esc closes the picker and the prompt takes input again", screen().includes("❯ x"), screen().slice(-200));

// --- fast typing: the whole command arrives in one chunk ------------------
await type("\x15", 200);
out = "";
await type("/provider key deepseek\r", 800);
check("key command asks for the key", screen().includes("paste your API key"), screen().slice(-300));
await type("sk-deepseek-e2e\r");
check("key verify finished (ok or rejected)", await waitFor("key works", 40_000) || screen().includes("could not verify"), screen().slice(-400));
const cfg2 = JSON.parse(readFileSync(cfgPath, "utf8"));
check("key typed during setup still reaches the key prompt", cfg2.providers.deepseek.apiKey === "sk-deepseek-e2e", JSON.stringify(cfg2.providers.deepseek.apiKey));
check("the key never echoes to the screen", !screen().includes("sk-deepseek-e2e"));
check("the command switched to the configured provider", await waitFor("provider → deepseek", 5_000), screen().slice(-300));

// --- @skill mentions: menu, completion, and expansion on submit ----------
// Run on `mybox` (the mock-backed provider) so the turn has a real server.
await type("\x15", 200);
await type("/provider mybox\r", 900);
check("switched to the mock provider for the mention test", await waitFor("provider → mybox", 6_000), screen().slice(-300));
await type("\x15", 200);
out = "";
await type("please @demo", 600);
check("@ opens the skill mention menu", await waitFor("demo-skill", 5_000), screen().slice(-400));
await type("\t", 600);
check("Tab completes the mention token", await waitFor("please @demo-skill", 5_000), screen().slice(-400));
// Fresh line, full mention typed out, then Enter submits it.
await type("\x15", 400);
out = "";
await type("say hi @demo-skill", 600);
check("full mention typed without the menu interfering", await waitFor("say hi @demo-skill", 5_000), screen().slice(-400));
await type("\r", 1500);
check("the model receives the expanded skill body", await waitFor("SKILL-BODY-RECEIVED", 10_000), screen().slice(-500));
await type("\x15", 200);
await type("/provider deepseek\r", 900);

// --- /model resolves per-provider aliases ---------------------------------
await type("\x15", 200);
out = "";
await type("/model fast\r", 700);
check("/model fast resolves the deepseek alias", await waitFor("model → deepseek-chat", 5_000), screen().slice(-300));
check("the alias name never becomes the model id", !screen().includes("model → fast"), screen().slice(-300));

// --- /model picker shows when the list was fetched -----------------------
// (verified in phase 1b below, which starts with a stamped model list)

// --- /doctor shows the health report inside the REPL ----------------------
await type("\x15", 200);
out = "";
await type("/doctor\r", 700);
check("/doctor prints the health report", await waitFor("default provider", 5_000), screen().slice(-400));
check("/doctor reaches a verdict", await waitFor("all clear", 3_000), screen().slice(-400));

// --- Shift+Tab switches provider from the empty prompt -------------------
await type("\x15", 200);
out = "";
await type("\x1b[Z");
check("Shift+Tab cycles provider", await waitFor("provider →", 5_000), screen().slice(-300));

// --- Alt+Enter makes a new line instead of submitting --------------------
await type("\x15", 200);
out = "";
await type("line one");
await type("\x1b\r", 300);
await type("line two", 400);
const typed = screen();
check("Alt+Enter keeps the prompt open", typed.includes("line one") && typed.includes("line two") && !typed.includes("error:"), typed.slice(-300));

// --- paste: bracketed paste with CRLF becomes a newline, not a submit -----
await type("\x15", 200);
out = "";
await type("\x1b[200~a\r\nb\x1b[201~", 300);
check("pasted CRLF becomes a newline", screen().includes("a") && screen().includes("b") && !screen().includes("error:"), screen().slice(-300));

// --- /doctor reports the config file actually in use (e2e temp home) ------
// Clear the multi-line draft left by the Alt+Enter / paste checks: the first
// Ctrl+C empties the buffer (stays running), then `/doctor` runs on its own.
await type("\x03", 500);
await type("\x15", 300);
out = "";
await type("/doctor\r", 900);
check("/doctor names the active config file", await waitFor(cfgPath, 8_000), screen().slice(-400));
check("/doctor ran as a command, not as chat", !screen().includes("api error: fetch failed"), screen().slice(-300));

// --- @skill mentions: menu, completion, and expansion on submit ----------
await type("\x15", 200);
out = "";
await type("please @demo", 500);
check("@ opens the skill mention menu", await waitFor("demo-skill", 5_000), screen().slice(-400));
await type("s");
await type("\t", 400);
check("Tab completes the mention token", /please @demo-skill /.test(screen().slice(-400)), screen().slice(-300));
await type("\x15", 200);
out = "";
await type("say hi @demo-skill\r", 1500);
check("the model receives the expanded skill body", await waitFor("SKILL-BODY-RECEIVED", 10_000), screen().slice(-500));
await type("\x15", 200);
await type("\x15", 200);
out = "";
await type("\x03");
await sleep(500);
await type("\x03");
const exitCode = await new Promise((r) => { if (child.exitCode !== null) r(child.exitCode); else child.on("exit", r); setTimeout(() => r("timeout"), 5000); });
check("Ctrl+C on an empty prompt exits", exitCode === 0, String(exitCode));

// === phase 1b: /model picker shows the model-list age =====================
// A provider with a stamped fetch time must show "updated 4m ago" and turn
// the live option into a refresh — no network involved.
{
  const c = JSON.parse(readFileSync(cfgPath, "utf8"));
  c.defaultProvider = "stamped";
  c.defaultModel = "mock-coder";
  c.providers.stamped = {
    name: "Stamped", baseURL: mockBase, apiKey: "sk-stamped", authMode: "apiKey",
    models: { "mock-coder": {}, "mock-chat": {} },
    modelsFetchedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  };
  c.providers.stale = {
    name: "Stale", baseURL: mockBase, apiKey: "sk-stale", authMode: "apiKey",
    models: { "mock-coder": {} },
    modelsFetchedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  };
  // Mixed kinds + junk ids for the picker/prune checks.
  c.providers.mixed = {
    name: "Mixed", baseURL: mockBase, apiKey: "sk-mixed", authMode: "apiKey",
    models: {
      "mock-coder": {}, "mock-chat": {}, "dup-model": {},
      "text-embedding-3-large": {}, "whisper-1": {}, "cohere/rerank-v3.5": {},
      "": {}, "Mock-Coder": {}, // junk: blank + case duplicate of mock-coder
    },
  };
  writeFileSync(cfgPath, JSON.stringify(c, null, 2));
}
const child1b = spawn(process.execPath, [harness], { env, cwd: process.cwd() });
let out1b = "";
child1b.stdout.on("data", (d) => (out1b += d));
child1b.stderr.on("data", (d) => (out1b += d));
const screen1b = () => out1b.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const waitFor1b = async (needle, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (screen1b().includes(needle)) return true; await sleep(100); }
  return false;
};
const type1b = async (s, ms = 350) => { child1b.stdin.write(JSON.stringify({ keys: s }) + "\n"); await sleep(ms); };

await sleep(1500);
await type1b("/model\r", 800);
check("/model picker shows the model-list age", await waitFor1b("updated 4m ago", 5_000), screen1b().slice(-400));
check("live option becomes a refresh once fetched", /refresh from API/.test(screen1b()), screen1b().slice(-400));
await type1b("\x1b", 300);

// stale badge: a 3-day-old list shows "models 3d ago" in the status bar
await type1b("\x15", 200);
out1b = "";
await type1b("/provider stale\r", 900);
check("stale model list shows an age badge", await waitFor1b("models 3d ago", 6_000), screen1b().slice(-400));

// bulk refresh: /models --all sweeps every keyed provider against the mock
await type1b("\x15", 200);
out1b = "";
await type1b("/models --all\r", 2500);
check("/models --all reports each provider", await waitFor1b("2/2 refreshed", 8_000) || /✓ *(stamped|stale)/i.test(screen1b()), screen1b().slice(-500));
{
  const c = JSON.parse(readFileSync(cfgPath, "utf8"));
  const stampAge = Date.now() - Date.parse(c.providers.stale.modelsFetchedAt);
  check("bulk refresh re-stamped the stale provider", stampAge < 60_000, `${Math.round(stampAge / 1000)}s`);
  check("bulk refresh left fresh lists alone… still stamped", Boolean(c.providers.stamped.modelsFetchedAt));
}
await type1b("\x15", 200);
out1b = "";
await type1b("/models --stale\r", 2500);
// The mock-backed providers were just refreshed; only the leftover fake-key
// deepseek entry is still stale (and it fails, since that key is not real).
check("/models --stale visits only the stale provider", await waitFor1b("/1 refreshed", 10_000), screen1b().slice(-400));
check("stale sweep did not re-visit fresh providers", !/✓ *(stamped|stale)/i.test(screen1b()), screen1b().slice(-400));

// --- /model hides non-chat models behind one row -------------------------
await type1b("\x15", 200);
out1b = "";
await type1b("/provider mixed\r", 900);
check("switched to the mixed provider", await waitFor1b("provider → mixed", 6_000), screen1b().slice(-300));
await type1b("\x15", 200);
out1b = "";
await type1b("/model\r", 900);
check("picker lists the chat model", await waitFor1b("mock-coder", 5_000), screen1b().slice(-500));
check("picker hides embedding/speech/rerank rows", !/text-embedding-3-large|whisper-1|rerank-v3\.5/.test(screen1b().slice(-900)), screen1b().slice(-500));
check("picker shows a non-chat count row", /… 4 non-chat models/.test(screen1b()), screen1b().slice(-500));
check("picker footer splits chat from other", /5 chat \+ 4 other/.test(screen1b()), screen1b().slice(-500));
await type1b("\x1b", 400);

// --- REPL parity: /models --prune (junk seeded before launch) ------------
await type1b("\x15", 200);
out1b = "";
await type1b("/models --prune\r", 900);
check("/models --prune reports what it removed", await waitFor1b("pruned 2 junk ids", 6_000), screen1b().slice(-400));
{
  const c = JSON.parse(readFileSync(cfgPath, "utf8"));
  const keys = Object.keys(c.providers.mixed.models);
  check("junk ids gone from config", !keys.includes("") && !keys.includes("Mock-Coder"), keys.join(","));
  check("non-chat ids survived prune", keys.includes("text-embedding-3-large") && keys.includes("whisper-1"), keys.join(","));
}
await type1b("\x15", 200);
out1b = "";
await type1b("/models --prune\r", 900);
check("/models --prune is idempotent", await waitFor1b("nothing to prune", 6_000), screen1b().slice(-400));

// --- /models --all-ids reveals non-chat ids, tagged by kind --------------
await type1b("\x15", 200);
out1b = "";
await type1b("/models --all-ids\r", 2500);
check("/models --all-ids shows hidden non-chat ids", await waitFor1b("mock-text-embedding", 8_000), screen1b().slice(-500));
check("--all-ids tags the model kind", /mock-text-embedding\s+\(embedding\)/.test(screen1b()), screen1b().slice(-500));

// --- /providers shows a compact chat/non-chat summary --------------------
await type1b("\x15", 200);
out1b = "";
await type1b("/providers all\r", 900);
check("/providers summarises model counts", await waitFor1b("chat ·", 6_000), screen1b().slice(-900));
check("/providers avoids dumping every id", !/(mock-coder, ){2,}/.test(screen1b()), screen1b().slice(-400));
check("/providers shows the +N more preview", /more\s+\(/.test(screen1b()) || /chat · \d+ non-chat/.test(screen1b()), screen1b().slice(-500));
await type1b("\x03"); await sleep(400); await type1b("\x03");
const exit1b = await new Promise((r) => { if (child1b.exitCode !== null) r(child1b.exitCode); else child1b.on("exit", r); setTimeout(() => r("timeout"), 5000); });
check("phase 1b exits cleanly", exit1b === 0, String(exit1b));

// === phase 2: switching to a keyed provider with an empty model list ======
// Simulates "the key was set earlier while the API was down": `second` has a
// key but zero models. Switching to it must background-fetch the live list
// (mock /models now answers 200) and adopt a real model id.
const cfgAfter = JSON.parse(readFileSync(cfgPath, "utf8"));
cfgAfter.providers.second = {
  name: "Second", baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "sk-second",
  authMode: "apiKey", models: {},
};
writeFileSync(cfgPath, JSON.stringify(cfgAfter, null, 2));

const child2 = spawn(process.execPath, [harness], { env, cwd: process.cwd() });
let out2 = "";
child2.stdout.on("data", (d) => (out2 += d));
child2.stderr.on("data", (d) => (out2 += d));
const screen2 = () => out2.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const waitFor2 = async (needle, ms = 10_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (screen2().includes(needle)) return true; await sleep(100); }
  return false;
};
const type2 = async (s, ms = 350) => { child2.stdin.write(JSON.stringify({ keys: s }) + "\n"); await sleep(ms); };

await sleep(1500);
check("second REPL starts without the wizard", screen2().includes("❯"), screen2().slice(-300));
await type2("\x15", 200);
out2 = "";
await type2("/provider\r", 700);
await type2("second", 400);
await type2("\r", 700);
check("switching to a keyed model-less provider fetches models", await waitFor2("models fetched for second", 8_000), screen2().slice(-400));
await type2("\x15", 200);
out2 = "";
await type2("/model\r", 700);
await type2("coder", 400);
await type2("\r", 700);
check("fetched model is selectable via /model", await waitFor2("model → mock-coder", 8_000), screen2().slice(-400));

await type2("\x03"); await sleep(500); await type2("\x03");
const exitCode2 = await new Promise((r) => { if (child2.exitCode !== null) r(child2.exitCode); else child2.on("exit", r); setTimeout(() => r("timeout"), 5000); });
check("second REPL exits cleanly", exitCode2 === 0, String(exitCode2));
mock.close();

try { rmSync(home, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
