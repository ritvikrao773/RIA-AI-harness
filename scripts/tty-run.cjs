// Test-only wrapper: pretend stdin is a TTY, then load the real bundled REPL.
// Keystrokes arrive as one JSON line each on stdin: {"keys":"<raw bytes>"}.
// The real stdin socket is read asynchronously (never blocks the event loop,
// so fetches and timers inside the REPL keep working).
const { PassThrough } = require("node:stream");

const realStdin = process.stdin;

const input = new PassThrough();
input.isTTY = true;
input.setRawMode = () => input;
input.ref = () => input;
input.unref = () => input;
Object.defineProperty(process, "stdin", { value: input, configurable: true });
process.stdout.isTTY = true;
process.stdout.columns = 110;
process.stdout.rows = 40;

let buf = "";
realStdin.setEncoding("utf8");
realStdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try { input.write(JSON.parse(line).keys); } catch { /* ignore malformed control lines */ }
  }
});

require("./cli.cjs");
