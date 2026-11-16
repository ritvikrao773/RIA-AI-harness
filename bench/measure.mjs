// Token bench: fixed per-request payload, plus a replay of real saved
// sessions through the free-release path. No network, no API calls.
//
//   node bench/measure.mjs [sessionId ...]
//
// With no ids it uses the largest session for the current directory.
import { build } from "esbuild";
import { readFileSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Sources resolve against the project, not against the cwd: the cwd stays the
// directory whose sessions we are measuring.
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(mkdtempSync(join(tmpdir(), "ria-bench-")), "measure.mjs");
await build({
  entryPoints: [join(projectRoot, "src", "measure-entry.ts")],
  absWorkingDir: projectRoot,
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: out, logLevel: "error",
});
const { measure, measureSession } = await import(`file://${out.replace(/\\/g, "/")}`);

// ---------------------------------------------------------- fixed payload
const fixed = measure();
console.log("FIXED PER-REQUEST PAYLOAD");
console.log(`  system prompt : ${fixed.systemPromptTokens} tokens`);
console.log(`  tool schemas  : ${fixed.toolsTokens} tokens  (${fixed.toolCount} tools)`);
console.log(`  TOTAL         : ${fixed.totalFixedPerRequest} tokens, paid on every request`);
console.log(`  skills line   : ${fixed.skillLinesTokens} tokens for ${fixed.skillNames.length} skills`);
const thinSkills = fixed.skillNames.filter((s) => s.includes("(2 chars desc)"));
if (thinSkills.length) console.log(`  WARNING: ${thinSkills.length} skills have an empty description (folded YAML?)`);

// ------------------------------------------------------------ session replay
const root = join(homedir(), ".ria", "sessions");
const dir = join(root, createHash("sha256").update(process.cwd().toLowerCase()).digest("hex").slice(0, 12));

let ids = process.argv.slice(2);
if (!ids.length && existsSync(dir)) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sized = files.map((f) => {
    try { return { f, n: JSON.parse(readFileSync(join(dir, f), "utf8")).messages?.length ?? 0 }; } catch { return { f, n: 0 }; }
  }).sort((a, b) => b.n - a.n);
  if (sized.length) ids = [sized[0].f.replace(/\.json$/, "")];
}

if (!ids.length) {
  console.log("\nno saved sessions for this directory — pass one with `node bench/measure.mjs <id>`");
  process.exit(0);
}

console.log("\nSESSION REPLAY (free release only, no API calls)");
for (const id of ids) {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) { console.log(`  ${id}: not found at ${p}`); continue; }
  const s = JSON.parse(readFileSync(p, "utf8"));
  const r = measureSession(s.messages ?? []);
  const pct = r.before ? ((r.freed / r.before) * 100).toFixed(1) : "0.0";
  console.log(`  ${id}  (${r.messages} messages)`);
  console.log(`    ${r.before} → ${r.after} tokens  (freed ${r.freed}, ${pct}%)`);
  console.log(`    idempotent: ${r.secondPassFreed === 0 ? "yes" : `NO — ${r.secondPassFreed} freed on 2nd pass`}`);
}
