// Bundle the TypeScript tests with esbuild (same transform the build uses),
// then run them, so tests exercise exactly what ships.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const entries = process.argv.slice(2);
if (!entries.length) {
  console.error("usage: node test/run.mjs <file.test.ts> [...]");
  process.exit(1);
}

mkdirSync("dist/test", { recursive: true });
let failed = 0;

for (const entry of entries) {
  const out = `dist/test/${entry.replace(/[\\/]/g, "_").replace(/\.ts$/, ".mjs")}`;
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: out,
    logLevel: "error",
    // keep the test's own process.exit working
  });
  console.log(`\n=== ${entry}`);
  const r = spawnSync(process.execPath, [out], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (failed) {
  console.error(`\n${failed} test file(s) failed`);
  process.exit(1);
}
