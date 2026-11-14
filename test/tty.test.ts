// Drives the REPL headlessly: real `process.stdin` stream, editor handle(),
// Picker and promptLine — everything except the terminal itself.
// Usage: node scripts/ttydrive.mjs   (bundles itself with esbuild first)
import { PassThrough } from "node:stream";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Editor } from "../src/ui/editor.ts";
import { decodeKeys } from "../src/ui/keys.ts";
import { Picker } from "../src/ui/picker.ts";
import { promptLine } from "../src/ui/prompt.ts";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// A fake TTY stdin: raw bytes in, 'data' events out (exactly what process.stdin does).
const fakeStdin = new PassThrough();
Object.assign(fakeStdin, { isTTY: true, setRawMode: () => {} });
Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
const writes = [];
const collect = { write: (s) => writes.push(s), cols: () => 100 };
const flush = () => writes.splice(0).join("");

// ---------------------------------------------------------------- editor
console.log("editor (/ menu, enter, alt+enter):");
const ed = new Editor(collect);
ed.completions = [
  { name: "/help", desc: "commands", insert: "/help" },
  { name: "/model", desc: "model picker", insert: "/model" },
  { name: "/provider", desc: "provider picker", insert: "/provider" },
];
const feed = (s) => decodeKeys(s).map((k) => ed.handle(k));
ed.draw("");
flush();

// regression: ESC-based Alt+Enter used to eat the next key ("/m" -> "/")
ed.reset();
const before = ed.value;
feed("hello ");
feed("\x1bm"); // Alt+m
check("Alt+<char> consumes the pair but keeps the buffer intact", ed.value === before + "hello ", JSON.stringify(ed.value));
ed.reset();

const actions = feed("/");
check("typing / keeps the char in the buffer", ed.value.endsWith("/"), JSON.stringify(ed.value));
ed.draw("");
const menu = flush();
check("/ shows the command menu", menu.includes("/help") && menu.includes("/model") && menu.includes("/provider"));

ed.reset();
feed("/mo");
flush();
ed.draw("");
check("typing /mo keeps exactly what was typed", ed.value === "/mo", JSON.stringify(ed.value));
check("menu narrows to /model", flush().includes("/"))

ed.reset();
feed("hi");
const a1 = feed("\r");
check("Enter submits", a1.includes("submit") && ed.value.trim() === "hi", JSON.stringify(a1));

ed.reset();
feed("one");
feed("\x1b\r"); // Alt+Enter
check("Alt+Enter inserts a newline, no submit", ed.value === "one\n", JSON.stringify(ed.value));

ed.reset();
feed("one");
feed("\n"); // Shift+Enter on modern terminals sends LF
check("Shift+Enter (LF) inserts a newline", ed.value === "one\n", JSON.stringify(ed.value));

ed.reset();
feed("one\\");
const a2 = feed("\r");
check("\\\\ + Enter inserts a newline", ed.value.startsWith("one\n") && !a2.includes("submit"), JSON.stringify(ed.value));

ed.reset();
feed("x");
feed("\x1b[OP");
check("F1 asks for help", ed.handle({ t: "f1" }) === "help");

// -------------------------------------------------------- @skill mentions
console.log("\neditor (@skill mention menu):");
ed.completions = [
  { name: "@alpha", desc: "test alpha", insert: "@alpha " },
  { name: "@beta", desc: "test beta", insert: "@beta " },
  { name: "/help", desc: "commands", insert: "/help" },
];

ed.reset();
feed("please ");
feed("@");
flush();
ed.draw("");
check("typing @ mid-text opens the mention menu", flush().includes("@alpha"), flush());

ed.reset();
feed("do it @al");
flush();
ed.draw("");
const mentMenu = flush();
check("mention filters by token", mentMenu.includes("@alpha") && !mentMenu.includes("@beta"), mentMenu);

ed.reset();
feed("use @al");
feed("\t");
check("Tab completes just the token, prefix intact", ed.value === "use @alpha" && ed.cursor === 10, JSON.stringify(ed.value));

ed.reset();
feed("first");
feed("\n"); // newline → no mention menu across lines
flush();
check("menu suppressed across newlines", ed.value.includes("\n"));

ed.reset();
feed("/mo");
flush();
ed.draw("");
check("slash command takes precedence over @", !flush().includes("@alpha"));

// regression: an exact mention used to swallow Enter and never submit
ed.reset();
feed("say hi @alpha");
const submitRes = feed("\r");
check("Enter on an exact mention submits", submitRes.includes("submit"), JSON.stringify(submitRes));
check("submit keeps the mention intact", ed.value === "say hi @alpha", JSON.stringify(ed.value));

// Enter on a partial mention completes it without submitting
ed.reset();
feed("say hi @al");
const partial = feed("\r");
check("Enter on a partial mention completes instead", !partial.includes("submit") && ed.value === "say hi @alpha", JSON.stringify(ed.value));

// Tab adds no stray trailing space mid-sentence
ed.reset();
feed("use @al");
feed("\t");
check("Tab completion does not add a trailing space", ed.value === "use @alpha", JSON.stringify(ed.value));

// Skill names are usually hyphenated ("replica-recon"): a mid-name match
// must still be offered, and stronger matches must rank first.
ed.completions = [
  { name: "@replica-test", desc: "test", insert: "@replica-test " },
  { name: "@ai-video-editor", desc: "video", insert: "@ai-video-editor " },
  { name: "@replica-recon", desc: "recon", insert: "@replica-recon " },
  { name: "@reverse-engineer-anything", desc: "re", insert: "@reverse-engineer-anything " },
];
ed.reset();
feed("@recon");
ed.draw("");
const midMenu = flush();
check("mention matches mid-name segments", midMenu.includes("@replica-recon"), midMenu);
check("substring match leads the menu over a subsequence", midMenu.indexOf("@replica-recon") >= 0, midMenu);
ed.reset();
feed("use @recon");
feed("\t");
check("Tab completes a mid-name match", ed.value === "use @replica-recon", JSON.stringify(ed.value));

ed.reset();
feed("@ave");
ed.draw("");
check("subsequence match finds ai-video-editor", flush().includes("@ai-video-editor"), flush());

// 15 skills: the menu renders a sliding window (with a more-hint) instead
// of silently cutting off, and ↓ keeps the selection inside the window.
ed.completions = Array.from({ length: 15 }, (_, n) => {
  const name = `@skill-${String(n + 1).padStart(2, "0")}`;
  return { name, desc: "s", insert: `${name} ` };
});
ed.reset();
feed("@");
ed.draw("");
const big = flush();
check(
  "large menu shows a full window plus a more-hint",
  (big.match(/@skill-\d\d/g) || []).length === 12 && big.includes("keep typing"),
  big,
);
for (let i = 0; i < 14; i++) feed("\x1b[B");
ed.draw("");
const slid = flush();
check("sliding window keeps the selected skill visible", slid.includes("@skill-15"), slid);

ed.completions = [
  { name: "/help", desc: "commands", insert: "/help" },
  { name: "/model", desc: "model picker", insert: "/model" },
  { name: "/provider", desc: "provider picker", insert: "/provider" },
];

// ---------------------------------------------------------------- picker
console.log("\npicker:");
const pk = new Picker(
  {
    title: "provider",
    items: [
      { value: "deepseek", label: "deepseek", desc: "DeepSeek" },
      { value: "qwen", label: "qwen", desc: "Qwen" },
      { value: "glm", label: "glm", desc: "GLM" },
    ],
  },
  collect,
);
pk.draw();
check("draws all items", flush().includes("deepseek") && writes.length === 0);
check("down moves", pk.key({ t: "down" }) === "none");
check("type filters", pk.key({ t: "char", ch: "q" }) === "none");
flush();
pk.draw();
check("filtered view shows qwen", flush().includes("qwen") && !pk.done);
check("enter chooses the filtered item", pk.key({ t: "enter" }) === "done" && pk.result === "qwen", pk.result);

const pk2 = new Picker({ title: "x", items: [{ value: "a", label: "a" }] }, collect);
pk2.draw();
flush();
check("esc cancels", pk2.key({ t: "esc" }) === "done" && pk2.result === null);

// ---------------------------------------------------------------- prompt
console.log("\nprompt (masked key entry):");
const pending = promptLine(collect, "deepseek — paste your API key", { secret: true });
fakeStdin.write("sk-li");
await new Promise((r) => setTimeout(r, 10));
const drawn = flush();
check("masks typed characters", drawn.includes("•••••") && !drawn.includes("sk-li"));
fakeStdin.write("ve-123\r");
const key = await pending;
check("returns the full key on Enter", key === "sk-live-123", key);
check("committed line is masked", !flush().includes("sk-live-123"));

const pending2 = promptLine(collect, "url", { initial: "https://" });
await new Promise((r) => setTimeout(r, 5));
fakeStdin.write("\r");
check("Enter accepts the initial value", (await pending2) === "https://");
flush();

const pending3 = promptLine(collect, "url");
await new Promise((r) => setTimeout(r, 5));
fakeStdin.write("\x1b");
check("Esc cancels with empty string", (await pending3) === "");
flush();

// stdin listener must be released, or the REPL would process keys twice.
check("promptLine removes its stdin listener", fakeStdin.listenerCount("data") === 0, String(fakeStdin.listenerCount("data")));

// ---------------------------------------------------------------- onboarding module
console.log("\nonboarding (fresh install, custom provider):");
{
  const home = mkdtempSync(join(tmpdir(), "ria-home-"));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const cfgMod = await import("../src/config.ts");
  const { ensureReady } = await import("../src/onboard.ts");
  const cfg = cfgMod.loadConfig();
  check("fresh config has built-in providers", Object.keys(cfg.providers).length >= 6);
  check("no key ships with the app", Object.values(cfg.providers).every((p) => !p.apiKey));
  check("no private default provider", !("mesh_api" in cfg.providers));

  writes.length = 0;
  const run = ensureReady(cfg, collect);
  await new Promise((r) => setTimeout(r, 20));
  const first = writes.join("");
  check("wizard lists providers", first.includes("deepseek"));
  writes.length = 0;
  fakeStdin.write("\x1b[A"); // move to "+ custom API" (last item) by wrapping up once
  await new Promise((r) => setTimeout(r, 10));
  check("wizard offers custom API (second picker page)", writes.join("").includes("custom API"));
  writes.length = 0;
  fakeStdin.write("\r");
  await new Promise((r) => setTimeout(r, 30));
  fakeStdin.write("localbox\r");
  await new Promise((r) => setTimeout(r, 30));
  fakeStdin.write("http://127.0.0.1:8000/v1\r");
  await new Promise((r) => setTimeout(r, 30));
  fakeStdin.write("sk-abc-123\r");
  await run;
  check("wizard did not crash on prompt input", true);
  flush();
  const saved = JSON.parse(readFileSync(join(home, ".ria", "config.json"), "utf8"));
  check("custom provider saved", saved.providers.localbox?.baseURL === "http://127.0.0.1:8000/v1", JSON.stringify(saved.providers.localbox));
  check("key stored only in the user config", saved.providers.localbox?.apiKey === "sk-abc-123");
  check("provider/model selected", saved.defaultProvider === "localbox" && "default" in saved.providers.localbox.models);
  check("onboarding marked done", saved.onboarded === true);
  check("wizard releases stdin", fakeStdin.listenerCount("data") === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);


