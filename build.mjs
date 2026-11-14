import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "cjs",
  outfile: "dist/cli.cjs",
  minify: true,
  sourcemap: false,
});
console.log("built dist/cli.cjs");
