/** Keys the editor understands. */
export type Key =
  | { t: "char"; ch: string }
  | { t: "enter" }
  | { t: "newline" }
  | { t: "tab" }
  | { t: "backspace" }
  | { t: "delete" }
  | { t: "left" }
  | { t: "right" }
  | { t: "up" }
  | { t: "down" }
  | { t: "home" }
  | { t: "end" }
  | { t: "ctrl"; ch: string }
  | { t: "paste"; text: string }
  | { t: "esc" }
  | { t: "f1" }
  | { t: "f12" }
  | { t: "shiftTab" };

const CSI: Record<string, Key> = {
  "\x1b[A": { t: "up" },
  "\x1b[B": { t: "down" },
  "\x1b[C": { t: "right" },
  "\x1b[D": { t: "left" },
  "\x1b[H": { t: "home" },
  "\x1b[F": { t: "end" },
  "\x1b[1~": { t: "home" },
  "\x1b[4~": { t: "end" },
  "\x1b[7~": { t: "home" },
  "\x1b[8~": { t: "end" },
  "\x1b[3~": { t: "delete" },
  "\x1b[Z": { t: "shiftTab" },
  "\x1bOA": { t: "up" },
  "\x1bOB": { t: "down" },
  "\x1bOC": { t: "right" },
  "\x1bOD": { t: "left" },
  "\x1bOH": { t: "home" },
  "\x1bOF": { t: "end" },
  "\x1bOP": { t: "f1" },
  "\x1b[11~": { t: "f1" },
  "\x1b[24~": { t: "f12" },
};

/** Terminals whose Enter key sends a bare CR. */
const TERM_CR_ENTER = /^(vt100|vt220|ansi|dumb)$/i.test(process.env.TERM || "");

/**
 * Decode a raw stdin chunk into key events. Bracketed paste arrives as
 * `\x1b[200~ … \x1b[201~` and is collapsed into a single paste event.
 */
export function decodeKeys(chunk: string): Key[] {
  // strip any bracketed-paste markers, keeping the inner text as one paste
  const out: Key[] = [];
  let s = chunk;
  const pasteRe = /\x1b\[200~([\s\S]*?)\x1b\[201~/g;
  s = s.replace(pasteRe, (_, inner: string) => {
    out.push({ t: "paste", text: inner });
    return "\u0001";
  });

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\u0001") { i++; continue; }
    if (ch === "\x1b") {
      // try the known CSI/SS3 sequences first
      let matched = false;
      for (const seq of Object.keys(CSI)) {
        if (s.startsWith(seq, i)) {
          out.push(CSI[seq]);
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // Alt+Enter (ESC + CR/LF) is what many terminals send for Shift+Enter.
      // Decode it to ESC, Enter — the editor turns that into a newline.
      if (s.startsWith("\x1b\r\n", i)) { out.push({ t: "esc" }, { t: "enter" }); i += 3; continue; }
      if (s.startsWith("\x1b\r", i) || s.startsWith("\x1b\n", i)) { out.push({ t: "esc" }, { t: "enter" }); i += 2; continue; }
      // Bare ESC (possibly with modifiers we ignore)
      if (i + 1 >= s.length) { out.push({ t: "esc" }); i++; continue; }
      // unknown escape: swallow ESC + one char
      i += 2;
      continue;
    }
    if (ch === "\r") { out.push({ t: "enter" }); i++; continue; }
    if (ch === "\n") { out.push({ t: TERM_CR_ENTER ? "enter" : "newline" }); i++; continue; }
    if (ch === "\t") { out.push({ t: "tab" }); i++; continue; }
    if (ch === "\x7f" || ch === "\b") { out.push({ t: "backspace" }); i++; continue; }
    if (ch === "\x03") { out.push({ t: "ctrl", ch: "c" }); i++; continue; }
    if (ch === "\x04") { out.push({ t: "ctrl", ch: "d" }); i++; continue; }
    if (ch === "\x0c") { out.push({ t: "ctrl", ch: "l" }); i++; continue; }
    if (ch === "\x15") { out.push({ t: "ctrl", ch: "u" }); i++; continue; }
    if (ch === "\x0b") { out.push({ t: "ctrl", ch: "k" }); i++; continue; }
    if (ch === "\x01") { out.push({ t: "ctrl", ch: "a" }); i++; continue; }
    if (ch === "\x05") { out.push({ t: "ctrl", ch: "e" }); i++; continue; }
    if (ch === "\x17") { out.push({ t: "ctrl", ch: "w" }); i++; continue; }
    if (ch === "\x10") { out.push({ t: "ctrl", ch: "p" }); i++; continue; }
    if (ch === "\x0e") { out.push({ t: "ctrl", ch: "n" }); i++; continue; }
    if (ch === "\x12") { out.push({ t: "ctrl", ch: "r" }); i++; continue; }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20) { i++; continue; }
    out.push({ t: "char", ch });
    i += ch.length;
  }
  return out;
}
