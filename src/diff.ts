/**
 * Small line diff for showing edits: LCS over lines, then a unified-style
 * render with context. Used for tool output and the REPL display so the user
 * can see exactly which lines changed instead of a whole-file rewrite.
 */

/** Common-prefix / common-suffix trim, then LCS on the middle. */
export function diffLines(before: string, after: string): Array<{ type: "=" | "-" | "+"; text: string; beforeLine: number; afterLine: number }> {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const out: Array<{ type: "=" | "-" | "+"; text: string; beforeLine: number; afterLine: number }> = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  for (let i = 0; i < start; i++) out.push({ type: "=", text: a[i], beforeLine: i + 1, afterLine: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // Guard: huge middles fall back to whole-block replace (bounded memory).
  if (midA.length * midB.length > 4_000_000) {
    midA.forEach((t, i) => out.push({ type: "-", text: t, beforeLine: start + i + 1, afterLine: 0 }));
    midB.forEach((t, i) => out.push({ type: "+", text: t, beforeLine: 0, afterLine: start + i + 1 }));
  } else {
    out.push(...lcs(midA, midB, start));
  }

  for (let i = 0; i < a.length - endA; i++) {
    out.push({ type: "=", text: a[endA + i], beforeLine: endA + i + 1, afterLine: endB + i + 1 });
  }
  return out;
}

function lcs(
  a: string[],
  b: string[],
  off: number,
): Array<{ type: "=" | "-" | "+"; text: string; beforeLine: number; afterLine: number }> {
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i:], b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ type: "=" | "-" | "+"; text: string; beforeLine: number; afterLine: number }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: "=", text: a[i], beforeLine: off + i + 1, afterLine: off + j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "-", text: a[i], beforeLine: off + i + 1, afterLine: 0 }); i++; }
    else { out.push({ type: "+", text: b[j], beforeLine: 0, afterLine: off + j + 1 }); j++; }
  }
  while (i < n) { out.push({ type: "-", text: a[i], beforeLine: off + i + 1, afterLine: 0 }); i++; }
  while (j < m) { out.push({ type: "+", text: b[j], beforeLine: 0, afterLine: off + j + 1 }); j++; }
  return out;
}

export interface DiffStats {
  added: number;
  removed: number;
  /** 1-based line numbers in the new file that changed. */
  changedLines: number[];
  /** First changed line in the new file (0 when nothing changed). */
  firstLine: number;
}

export function diffStats(before: string, after: string): DiffStats {
  const d = diffLines(before, after);
  const changedLines: number[] = [];
  let added = 0, removed = 0;
  for (const r of d) {
    if (r.type === "+") { added++; if (r.afterLine) changedLines.push(r.afterLine); }
    else if (r.type === "-") removed++;
  }
  return { added, removed, changedLines, firstLine: changedLines[0] ?? 0 };
}

/** Unified-style render with `context` lines around each change. */
export function renderDiff(before: string, after: string, opts: { context?: number; maxLines?: number; path?: string } = {}): string {
  const context = opts.context ?? 3;
  const maxLines = opts.maxLines ?? 40;
  const d = diffLines(before, after);
  const keep = new Array(d.length).fill(false);
  d.forEach((r, i) => {
    if (r.type === "=") return;
    for (let k = Math.max(0, i - context); k <= Math.min(d.length - 1, i + context); k++) keep[k] = true;
  });
  const kept = d.filter((_, i) => keep[i]);
  const omitted = d.length - kept.length;

  const lines: string[] = [];
  for (const r of kept) {
    const n = r.type === "+" ? r.afterLine : r.beforeLine;
    lines.push(`${r.type === "=" ? " " : r.type}${String(n).padStart(5)} ${r.text}`);
  }
  let text = lines.join("\n");
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    text = head.join("\n") + `\n… (${lines.length - head.length} more changed lines)`;
  }
  if (omitted > 0 && lines.length <= maxLines) text += `\n… (${omitted} unchanged lines elided)`;
  return text;
}
