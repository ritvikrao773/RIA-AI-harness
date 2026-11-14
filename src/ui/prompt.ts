/**
 * Minimal line prompt with secret masking, used by `/provider setup` and the
 * first-run key wizard.
 *
 * It is a one-shot reader: it takes over the (already raw) stdin for the
 * duration of one line, draws prompt + masked characters with every keypress,
 * and resolves with the text on Enter (or "" on Esc / Ctrl+C). The REPL must
 * not process input while a prompt is pending.
 */
import { palette } from "./theme.ts";
import { decodeKeys, type Key } from "./keys.ts";

export interface PromptHost {
  cols(): number;
  write(s: string): void;
}

export interface PromptOptions {
  /** Mask each typed character (API keys) instead of echoing it. */
  secret?: boolean;
  /** Shown after the label as a default, used when Enter is pressed on empty input. */
  initial?: string;
  /** Validation run on Enter; return a message to reject the value. */
  validate?: (value: string) => string | null;
  /** Keys typed before the prompt existed (held during setup) — replayed first. */
  initialKeys?: Key[];
}

export function promptLine(host: PromptHost, label: string, opts: PromptOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = "";
    let error = "";
    let rows = 0;
    let finished = false;
    const mask = (s: string) => (opts.secret ? "•".repeat(Math.min(s.length, 48)) : s);
    const hint = opts.secret
      ? "input hidden · Enter confirm · Esc cancel"
      : opts.initial
        ? `Enter accepts "${opts.initial}" · Esc cancel`
        : "Enter confirm · Esc cancel";

    const render = () => {
      const out = [
        " " + palette.brand("? ") + palette.boldWhite(label) + " " +
          palette.text(mask(value)) + palette.brand("▌"),
      ];
      if (error) out.push("   " + palette.err(error));
      out.push(" " + palette.faint(hint));
      let s = "\x1b[?25l";
      if (rows > 0) s += `\x1b[${rows}A`;
      s += "\r\x1b[0J" + out.join("\n") + "\n\x1b[?25h";
      host.write(s);
      rows = out.length;
    };

    const finish = (result: string) => {
      if (finished) return;
      finished = true;
      // Collapse the prompt into one committed line: rewrite the first row
      // (prompt) and clear the rows below it.
      const shown = result ? mask(result) : "(cancelled)";
      const keep =
        " " + palette.brand("? ") + palette.boldWhite(label) + " " +
        (result ? palette.text(shown) : palette.faint(shown)) + "\n";
      let s = "\r";
      if (rows > 1) s += `\x1b[${rows - 1}A`;
      s += "\x1b[0J" + keep + "\x1b[?25h";
      host.write(s);
      stdin.removeListener("data", onData);
      resolve(result);
    };

    const handle = (keys: Key[]) => {
      for (const k of keys) {
        if (k.t === "enter") {
          const v = value || opts.initial || "";
          if (!v) { finish(""); return; }
          const msg = opts.validate?.(v) ?? null;
          if (msg) { error = msg; render(); continue; }
          finish(v);
          // Keys that arrived after Enter (fast typist / paste) belong to the
          // caller, not to this prompt.
          const rest = keys.slice(keys.indexOf(k) + 1);
          if (rest.length) stdin.emit("ria:leftover", rest);
          return;
        }
        if (k.t === "esc" || (k.t === "ctrl" && k.ch === "c")) { finish(""); return; }
        if (k.t === "backspace") { value = value.slice(0, -1); error = ""; continue; }
        if (k.t === "char") { value += k.ch; error = ""; continue; }
        if (k.t === "paste") { value += k.text.replace(/[\r\n]+/g, "").trim(); error = ""; continue; }
      }
      render();
    };

    const onData = (chunk: Buffer | string) => {
      if (finished) return;
      handle(decodeKeys(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
    };
    // Replay keys typed before the prompt existed; they may finish it at once.
    if (opts.initialKeys?.length) handle(opts.initialKeys);
    if (!finished) {
      stdin.on("data", onData);
      stdin.resume();
      render();
    }
  });
}
