import { build } from "esbuild";
import { mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

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
  define: { __RIA_VERSION__: JSON.stringify(pkg.version) },
});
console.log("built dist/cli.cjs");
