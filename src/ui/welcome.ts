/** ASCII wordmark + welcome card shown at REPL start. */
import { cols, fmtN, padTo, palette, stripAnsi, sym, width } from "./theme.ts";

const WORDMARK = [
  "██████╗ ██╗  █████╗ ",
  "██╔══██╗██║ ██╔══██╗",
  "██████╔╝██║ ███████║",
  "██╔══██╗██║ ██╔══██║",
  "██║  ██║██║ ██║  ██║",
  "╚═╝  ╚═╝╚═╝ ╚═╝  ╚═╝",
];

export interface WelcomeInfo {
  model: string;
  provider: string;
  cwd: string;
  skills: number;
  context?: number;
  version: string;
  hints?: Array<[string, string]>;
}

export function renderWelcome(info: WelcomeInfo): string {
  const W = Math.min(cols(), 100);
  const artW = Math.max(...WORDMARK.map((l) => width(l)));
  const meta = metaLines(info);
  const lines: string[] = [""];

  if (W >= artW + 34 && process.stdout.isTTY) {
    for (let i = 0; i < Math.max(WORDMARK.length, meta.length); i++) {
      const art = WORDMARK[i] ? gradient(WORDMARK[i], i / WORDMARK.length) : " ".repeat(artW);
      const row = i < WORDMARK.length ? art : " ".repeat(artW);
      lines.push("  " + row + "   " + (meta[i] ?? ""));
    }
    lines.push("  " + palette.faint("v" + info.version + " — the token-lean coding agent"));
  } else {
    lines.push("  " + palette.brand("Ria") + palette.faint("  v" + info.version));
    lines.push("");
    for (const m of meta) lines.push("  " + m);
  }

  lines.push("");
  const hints: Array<[string, string]> = info.hints ?? [
    ["/help", "commands"],
    ["/model", "switch"],
    ["/context", "tokens"],
    ["/init", "AGENTS.md"],
  ];
  lines.push("  " + hints.map(([k, v]) => palette.brandAlt(k) + " " + palette.faint(v)).join(palette.faint("  ·  ")));
  lines.push(
    "  " +
      palette.faint("Enter send · Alt+Enter new line · Shift+Tab provider · Ctrl+C interrupt · Ctrl+D exit"),
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

function metaLines(info: WelcomeInfo): string[] {
  const ctx = info.context ? palette.faint("  " + fmtN(info.context) + " ctx") : "";
  return [
    palette.faint("model") + "     " + palette.boldWhite(info.model) + ctx,
    palette.faint("provider") + "  " + palette.text(info.provider),
    palette.faint("cwd") + "       " + palette.text(shortPath(info.cwd)),
    palette.faint("skills") + "    " + palette.text(String(info.skills)) + palette.faint(" available"),
    "",
    palette.faint("token-lean agent harness"),
  ];
}

export function shortPath(p: string): string {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  let s = p;
  if (home && s.toLowerCase().startsWith(home.toLowerCase())) s = "~" + s.slice(home.length);
  return s.replace(/\\/g, "/");
}

/** Left-to-right colour gradient across one wordmark row. */
function gradient(s: string, t: number): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return s;
  const r1 = 236, g1 = 143, b1 = 98;
  const r2 = 186, g2 = 138, b2 = 250;
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

/** One-line tool status, like Claude Code's tool rows. */
export function toolLine(name: string, arg: string, status: "run" | "ok" | "err", detail = ""): string {
  const W = cols();
  const glyph = status === "run" ? palette.brand("◆") : status === "ok" ? palette.ok(sym.ok) : palette.err(sym.err);
  const label = status === "run" ? palette.text(name) : palette.faint(name);
  const tail = detail ? palette.faint("  " + clip(detail, Math.max(10, W - width(name) - width(arg) - 12))) : "";
  return `  ${glyph} ${label} ${palette.faint(arg)}${tail}`;
}

export function clip(s: string, w: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return width(one) > w ? one.slice(0, Math.max(0, w - 1)) + "…" : one;
}

/** Short, repo-relative-looking form of a tool argument for the tool line. */
export function shortArg(arg: unknown): string {
  if (typeof arg !== "string" || !arg) return "";
  const s = arg.replace(/\\/g, "/");
  if (s.includes("\n")) return clip(s, 60);
  // Keep the last three path segments: .../src/cli.ts beats an absolute path.
  const parts = s.split("/").filter(Boolean);
  const short = parts.length > 3 ? "…/" + parts.slice(-3).join("/") : s;
  return clip(short, 64);
}

/** Indent every line of a block for display under a tool row. */
export function indent(block: string, prefix = "      "): string {
  return block
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

export interface EditSummary {
  ok: boolean;
  file: string;
  detail: string;
  /** Rendered diff block, when the tool reported one. */
  diff?: string;
  added: number;
  removed: number;
  line: number;
}

/**
 * Parse the structured header `edit_file` / `write_file` return:
 *   edited <path> (line 12 · +2 -1 lines)
 *   wrote  <path> (+5 -0 lines, 120 bytes)
 *   created <path> (40 lines, 900 bytes)
 * followed by a diff block on the next lines.
 */
export function editSummary(output: string): EditSummary {
  const nl = output.indexOf("\n");
  const head = nl === -1 ? output : output.slice(0, nl);
  const diff = nl === -1 ? undefined : output.slice(nl + 1).trim() || undefined;
  const m = head.match(/^(edited|wrote|created)\s+(.+?)\s+\((.*)\)$/);
  if (!m) return { ok: false, file: "", detail: "", added: 0, removed: 0, line: 0 };
  const [, verb, file, tail] = m;
  const line = Number(tail.match(/line (\d+)/)?.[1] ?? 0);
  const added = Number(tail.match(/\+(\d+)/)?.[1] ?? 0);
  const removed = Number(tail.match(/-(\d+)/)?.[1] ?? 0);
  const detail = verb === "created"
    ? palette.faint(tail)
    : `${palette.ok("+" + added)} ${palette.err("-" + removed)}${line ? palette.faint(`  line ${line}`) : ""}`;
  return { ok: true, file, detail, diff, added, removed, line };
}

/** Header block for panels (help / model picker / etc). */
export function panel(title: string, rows: string[], footer?: string): string {
  const W = Math.min(cols(), 100);
  const rule = palette.faint("─".repeat(Math.min(W - 4, 60)));
  const lines: string[] = ["", "  " + palette.brand(sym.bar + " ") + palette.boldWhite(title), "  " + rule];
  for (const r of rows) lines.push("  " + r);
  if (footer) {
    lines.push("  " + rule);
    lines.push("  " + palette.faint(footer));
  }
  lines.push("");
  void padTo;
  void stripAnsi;
  return lines.join("\n");
}
