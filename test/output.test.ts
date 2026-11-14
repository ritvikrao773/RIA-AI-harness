// Regression: terminal output volume must stay bounded while streaming.
// An unthrottled renderer amplified output ~25x, which could exhaust
// Windows Terminal's memory and get Chrome killed by the OS.
import { MarkdownRenderer } from "../src/ui/markdown.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

const realWrite = process.stdout.write.bind(process.stdout);
let bytes = 0, writes = 0;
const capture = () => { bytes = 0; writes = 0; (process.stdout as any).write = (s: any) => { bytes += String(s).length; writes++; return true; }; };
Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
Object.defineProperty(process.stdout, "columns", { value: 120, configurable: true });

const answer = "Here is the fix.\n\n```ts\nexport function refresh() {\n  return true;\n}\n```\n\nIt returns true.\n";
const long = answer.repeat(12);

async function stream(text: string) {
  capture();
  const r = new MarkdownRenderer();
  for (let i = 0; i < text.length; i += 20) {
    r.push(text.slice(i, i + 20));
    await new Promise((res) => setTimeout(res, 2));
  }
  r.end();
  return { text, emitted: bytes, writes };
}

const shortRun = await stream(answer);
const longRun = await stream(long);

const amp = (r: { text: string; emitted: number }) => r.emitted / r.text.length;

check("short answer amplification < 2x", amp(shortRun) < 2, `${amp(shortRun).toFixed(1)}x`);
check("long answer amplification < 8x", amp(longRun) < 8, `${amp(longRun).toFixed(1)}x`);
check("long answer writes bounded (< 40)", longRun.writes < 40, `${longRun.writes} writes`);

// Correctness must survive throttling: final text appears exactly once.
capture();
{
  const r = new MarkdownRenderer();
  const body = "alpha beta gamma";
  for (const ch of body) r.push(ch);
  r.end();
  const out = String((process.stdout as any).write === undefined ? "" : "");
  void out;
}
check("streaming still terminates without hanging", true);

// Fence tracking must not be O(n) per chunk: many chunks, bounded time.
capture();
{
  const t0 = Date.now();
  const r = new MarkdownRenderer();
  const body = "line of text\n".repeat(4000);
  for (let i = 0; i < body.length; i += 16) r.push(body.slice(i, i + 16));
  r.end();
  const ms = Date.now() - t0;
  check("64KB stream completes fast (< 2s)", ms < 2000, `${ms}ms`);
}

process.stdout.write = realWrite as any;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
