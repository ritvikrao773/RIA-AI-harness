// A runaway bash command must be stopped, not allowed to exhaust the machine.
// Emits indefinitely (no bound) so the output watchdog has to kill it.
import { runTool } from "../src/tools.ts";

const t0 = Date.now();
const out = await runTool("bash", { command: "while ($true) { 'flood line of output text to fill the buffer' }", timeout_ms: 60000 }, []);
const ms = Date.now() - t0;
const killed = /ria stopped this command/.test(out);
console.log(killed ? `  ok   runaway stopped after ${(ms / 1000).toFixed(1)}s` : `  FAIL runaway not stopped (${(ms / 1000).toFixed(1)}s)`);
console.log(`  output length: ${out.length} bytes (bounded)`);
console.log(`  tail: ${out.slice(-140).replace(/\n/g, " | ")}`);
process.exit(killed ? 0 : 1);

