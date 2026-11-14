/** ANSI color + tiny helpers. Respects NO_COLOR / not-a-TTY. */

export const useColor =
  !process.env.NO_COLOR && process.env.TERM !== "dumb" && (process.stdout.isTTY ?? false);

const fg = (code: number) => (s: string): string => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const mix = (a: number, b: number) => (s: string): string => (useColor ? `\x1b[${a};${b}m${s}\x1b[0m` : s);

export const c = {
  reset: (s: string) => s,
  bold: fg(1),
  dim: fg(2),
  italic: fg(3),
  underline: fg(4),
  strike: fg(9),
  red: fg(31),
  green: fg(32),
  yellow: fg(33),
  blue: fg(34),
  magenta: fg(35),
  cyan: fg(36),
  white: fg(37),
  gray: fg(90),
  accent: fg(38), // replaced at runtime if truecolor is available
  brand: fg(35),
  boldDim: mix(1, 90),
  boldWhite: mix(1, 37),
  boldCyan: mix(1, 36),
  orange: fg(33),
};

/** 24-bit colour when the terminal supports it. */
export function rgb(r: number, g: number, b: number) {
  return (s: string): string => (useColor && supportsTrueColor() ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m` : c.magenta(s));
}

let trueColor: boolean | undefined;
export function supportsTrueColor(): boolean {
  if (trueColor !== undefined) return trueColor;
  const ct = process.env.COLORTERM || "";
  trueColor = /truecolor|24bit/i.test(ct) || /-256(color)?$/i.test(process.env.TERM || "") || process.platform === "win32";
  return trueColor;
}

/** Ria palette: warm peach → violet gradient, Claude-Code-ish but its own thing. */
export const palette = {
  brand: (s: string) => (useColor ? rgb(232, 137, 92)(s) : s),
  boldWhite: (s: string) => c.boldWhite(s),
  brandAlt: (s: string) => (useColor ? rgb(214, 122, 174)(s) : s),
  accent: (s: string) => (useColor ? rgb(140, 170, 255)(s) : s),
  ok: (s: string) => (useColor ? rgb(140, 214, 154)(s) : s),
  warn: (s: string) => (useColor ? rgb(230, 192, 122)(s) : s),
  err: (s: string) => (useColor ? rgb(230, 120, 120)(s) : s),
  muted: (s: string) => (useColor ? rgb(130, 133, 143)(s) : s),
  faint: (s: string) => (useColor ? rgb(95, 98, 108)(s) : s),
  text: (s: string) => s,
  code: (s: string) => (useColor ? rgb(178, 209, 160)(s) : s),
  violet: (s: string) => (useColor ? rgb(170, 150, 250)(s) : s),
};

/** Visible width of a string (ignores ANSI escapes, count wide chars as 2). */
export function width(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (cp < 32) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function padTo(s: string, w: number): string {
  const len = width(s);
  return len >= w ? s : s + " ".repeat(w - len);
}

export function center(s: string, w: number): string {
  const len = width(s);
  if (len >= w) return s;
  const left = Math.floor((w - len) / 2);
  return " ".repeat(left) + s + " ".repeat(w - len - left);
}

export function truncate(s: string, w: number): string {
  if (width(s) <= w) return s;
  let out = "";
  let n = 0;
  for (const ch of stripAnsi(s)) {
    const cw = isWide(ch.codePointAt(0)!) ? 2 : 1;
    if (n + cw > w - 1) break;
    out += ch;
    n += cw;
  }
  return out + "…";
}

export function cols(): number {
  return process.stdout.columns || 80;
}

export function rows(): number {
  return process.stdout.rows || 24;
}

/** ANSI-aware word wrap into lines of at most `w` visible columns. */
export function wrap(text: string, w: number, firstIndent = "", restIndent = firstIndent): string[] {
  const out: string[] = [];
  let indent = firstIndent;
  for (const rawLine of text.split("\n")) {
    if (!rawLine) {
      out.push("");
      continue;
    }
    let line = rawLine;
    let avail = w - width(indent);
    if (avail < 10) avail = 10;
    while (width(line) > avail) {
      let cut = 0;
      let n = 0;
      const plain = stripAnsi(line);
      const chars = [...plain];
      for (let i = 0; i < chars.length; i++) {
        n += isWide(chars[i].codePointAt(0)!) ? 2 : 1;
        if (n > avail) break;
        cut = i + 1;
      }
      // prefer breaking at the last space
      let brk = cut;
      for (let i = cut - 1; i > cut * 0.4; i--) {
        if (chars[i] === " " || chars[i] === "-" || chars[i] === "," || chars[i] === "/") {
          brk = i + 1;
          break;
        }
      }
      if (brk <= 0) brk = cut;
      out.push(indent + chars.slice(0, brk).join("").trimEnd());
      line = chars.slice(brk).join("").trimStart();
      indent = restIndent;
      avail = w - width(indent);
      if (avail < 10) avail = 10;
    }
    out.push(indent + line);
    indent = restIndent;
  }
  return out;
}

export function hr(w = cols(), ch = "─"): string {
  return palette.faint(ch.repeat(Math.max(0, w)));
}

export const sym = {
  user: "❯",
  dot: "●",
  dotOpen: "○",
  bullet: "·",
  arrow: "→",
  ok: "✓",
  err: "✗",
  warn: "!",
  run: "◆",
  cursor: "▌",
  bar: "▏",
  ell: "…",
};

export function spinnerFrame(i: number): string {
  const f = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  return f[i % f.length];
}

export function fmtN(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

