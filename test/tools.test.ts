// Direct tool-layer regression test (no LLM involved).
import { runTool, buildTools } from "../src/tools.ts";
import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "ria-tools-"));
const file = join(dir, "sample.ts");const tools = buildTools([]);
let pass = 0, fail = 0;

function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log("tool list:");
check("has edit_file", tools.some((t) => t.name === "edit_file"));
check("has write_file", tools.some((t) => t.name === "write_file"));
check("has bash", tools.some((t) => t.name === "bash"));
check("has grep", tools.some((t) => t.name === "grep"));

console.log("\nedit_file:");
writeFileSync(file, "const a = 1;\nconst b = 2;\n");

let r = await runTool("edit_file", { path: file, old_string: "const a = 1;", new_string: "const a = 10;" }, []);
check("basic edit succeeds", r.startsWith("edited"), r);
check("basic edit applied", readFileSync(file, "utf8").includes("const a = 10;"));

// stale content: model read the file, then it changed underneath
writeFileSync(file, "const a = 1;\nconst b = 3;\n");
r = await runTool("edit_file", { path: file, old_string: "const b = 2;", new_string: "const b = 20;" }, []);
check("stale-mismatch is reported as failure", r.includes("failed"), r);
check("stale-mismatch did not corrupt file", readFileSync(file, "utf8").includes("const b = 3;"));

// multiple matches
writeFileSync(file, "x();\nx();\n");
r = await runTool("edit_file", { path: file, old_string: "x();", new_string: "y();" }, []);
check("ambiguous edit is reported", r.includes("matches 2"), r);
r = await runTool("edit_file", { path: file, old_string: "x();", new_string: "y();", replace_all: true }, []);
check("replace_all applies", (readFileSync(file, "utf8").match(/y\(\);/g) || []).length === 2, r);

// --- visible diffs (what the user sees after an edit) ---------------------
console.log("\nedit visibility:");
writeFileSync(file, "alpha\nbeta\ngamma\ndelta\nepsilon\n");
r = await runTool("edit_file", { path: file, old_string: "  beta\n".trim() + "\n", new_string: "BETA\n" }, []);
const head = r.split("\n")[0];
check("header names the line", /line 2/.test(head), head);
check("header counts +1 -1", /\+1 -1/.test(head), head);
check("diff marks the removed line", /^-\s+2 beta$/m.test(r), r);
check("diff marks the added line", /^\+\s+2 BETA$/m.test(r), r);
check("diff keeps context lines", /^\s+1 alpha$/m.test(r) && /^\s+3 gamma$/m.test(r), r);
check("unchanged lines are not shown as changes", !/^[-+].*(delta|epsilon)/m.test(r), r);

// substring edit: only part of a line changes, the rest is untouched
writeFileSync(file, "const total = price;\n");
r = await runTool("edit_file", { path: file, old_string: "price;", new_string: "price * qty;" }, []);
check("substring edit reports a single line pair", (r.match(/^[-+]\s+1 /gm) || []).length === 2, r);
check("substring edit keeps the rest of the line", readFileSync(file, "utf8") === "const total = price * qty;\n");

// write_file reports churn instead of a bare byte count
writeFileSync(file, "a\nb\nc\n");
r = await runTool("write_file", { path: file, content: "a\nB\nc\nd\n" }, []);
check("overwrite reports added/removed", /\+2 -1/.test(r), r);
r = await runTool("write_file", { path: join(dir, "..", "ria-created-" + process.pid, "brand-new.txt"), content: "x\ny" }, []);
check("new file is reported as created", r.startsWith("created") && /2 lines/.test(r), r);

// CRLF tolerance
writeFileSync(file, "line one\r\nline two\r\n");
r = await runTool("edit_file", { path: file, old_string: "line one\nline two", new_string: "line ONE\nline two" }, []);
check("LF old_string matches CRLF file", r.startsWith("edited"), r);

// missing file
r = await runTool("read_file", { path: join(dir, "nope.ts") }, []);
check("missing file reports error", r.startsWith("error:"), r);

console.log("\nglob:");
writeFileSync(join(dir, "a.ts"), "");
writeFileSync(join(dir, "b.js"), "");
mkdirSync(join(dir, "sub", "deep"), { recursive: true });
writeFileSync(join(dir, "sub", "c.ts"), "");
writeFileSync(join(dir, "sub", "deep", "d.ts"), "");

for (const [pat, want] of [
  ["**/*", 5],
  ["**", 5],
  ["*.ts", 2],
  ["*.{ts,js}", 3],
  ["**/*.ts", 4],
  ["sub/**/*.ts", 2],
  ["**/d.ts", 1],
] as Array<[string, number]>) {
  const out = await runTool("glob", { pattern: pat, directory: dir }, []);
  const n = out === "(no matches)" ? 0 : out.split("\n").length;
  check(`glob ${pat} → ${want}`, n === want, `got ${n}: ${out.replace(/\n/g, ", ")}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
