/** Bottom status bar: model · tokens · context meter · git branch. */
import { execFileSync } from "node:child_process";
import { cols, fmtN, palette, sym, width } from "./theme.ts";

export interface StatusState {
  model: string;
  provider: string;
  usedTokens: number;
  contextWindow?: number;
  cwd: string;
  branch?: string;
  busy?: boolean;
  spinner?: string;
  elapsedMs?: number;
  mode: "idle" | "thinking" | "tool" | "streaming";
  toolName?: string;
  hint?: string;
  /** Age label for the current provider's model list ("" = fresh/never fetched). */
  staleModels?: string;
}

const BAR_W = 8;

export function renderStatus(s: StatusState, W = cols()): string {
  const parts: string[] = [];

  if (s.busy) {
    const frame = palette.brand(s.spinner || "·");
    const label =
      s.mode === "tool"
        ? `${frame} ${palette.text("running")} ${palette.boldWhite(s.toolName || "tool")}`
        : s.mode === "streaming"
          ? `${frame} ${palette.text("responding")}`
          : `${frame} ${palette.text("thinking")}`;
    const t = s.elapsedMs ? palette.faint(` ${(s.elapsedMs / 1000).toFixed(1)}s`) : "";
    parts.push(label + t);
    parts.push(palette.warn("esc to interrupt"));
  } else {
    parts.push(palette.brand("❯") + " " + palette.boldWhite(s.model));
  }

  parts.push(palette.faint(s.provider));

  // context meter
  const used = s.usedTokens;
  const win = s.contextWindow || 200_000;
  const pct = Math.min(1, used / win);
  const filled = Math.round(pct * BAR_W);
  const meter =
    palette.faint("[") +
    (filled ? palette.ok("█".repeat(filled)) : "") +
    (filled < BAR_W ? palette.faint("░".repeat(BAR_W - filled)) : "") +
    palette.faint("]") +
    " " +
    palette.muted(fmtN(used)) +
    palette.faint(" / " + fmtN(win));
  parts.push(meter);

  if (s.branch) parts.push(palette.violet("⎇ ") + palette.muted(s.branch));
  if (s.staleModels) parts.push(palette.warn(`models ${s.staleModels}`));

  let line = parts.join(palette.faint("  ·  "));
  if (s.hint && width(line) + width(s.hint) + 4 < W) {
    const pad = Math.max(2, W - width(line) - width(s.hint) - 2);
    line += " ".repeat(pad) + palette.faint(s.hint);
  }
  return " " + line;
}

export function renderStatusDim(hint: string): string {
  return " " + palette.faint(hint);
}

let cachedBranch: { dir: string; at: number; value: string } | undefined;

export function gitBranch(cwd: string): string {
  const now = Date.now();
  if (cachedBranch && cachedBranch.dir === cwd && now - cachedBranch.at < 15_000) return cachedBranch.value;
  let value = "";
  try {
    value = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: 1200,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    })
      .toString()
      .trim();
  } catch {
    value = "";
  }
  cachedBranch = { dir: cwd, at: now, value };
  return value;
}

export function statusSeparator(W = cols()): string {
  return palette.faint("─".repeat(Math.max(10, W - 1)));
}

export { sym };
