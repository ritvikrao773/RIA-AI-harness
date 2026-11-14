// Diff engine: correct change detection, line numbers, and bounded rendering.
import { diffLines, diffStats, renderDiff } from "../src/diff.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

console.log("diff lines:");
const a = "one\ntwo\nthree\nfour\nfive";
const b = "one\ntwo\nTHREE\nfour\nfive";
const d1 = diffLines(a, b);
check("single line change detected", d1.filter((r) => r.type !== "=").length === 2, JSON.stringify(d1.map((r) => r.type)));
check("change is one - and one +", d1.some((r) => r.type === "-" && r.text === "three") && d1.some((r) => r.type === "+" && r.text === "THREE"));
check("unchanged lines preserved", d1.filter((r) => r.type === "=").length === 4);
check("removed line keeps old number", d1.find((r) => r.type === "-")?.beforeLine === 3);
check("added line keeps new number", d1.find((r) => r.type === "+")?.afterLine === 3);

// word-level change inside a line (the "change the part" case)
const c1 = "const total = price;";
const c2 = "const total = price * qty;";
const d2 = diffLines(c1, c2);
check("in-line edit is a single line pair", d2.filter((r) => r.type !== "=").length === 2);

console.log("\nstats:");
const st = diffStats("a\nb\nc", "a\nB\nc\nd");
check("added counted", st.added === 2, String(st.added));
check("removed counted", st.removed === 1, String(st.removed));
check("firstLine points at the change", st.firstLine === 2, String(st.firstLine));
check("changedLines lists new lines", st.changedLines.join(",") === "2,4", st.changedLines.join(","));
const same = diffStats("x\ny", "x\ny");
check("no change → empty stats", same.added === 0 && same.removed === 0 && same.firstLine === 0);

console.log("\nrender:");
const r = renderDiff("a\nb\nc\nd\ne\nf\ng\nh", "a\nb\nc\nD\ne\nf\ng\nH");
check("renders - and + markers with line numbers", /^-\s+4 d$/m.test(r) && /^\+\s+4 D$/m.test(r), r);
check("context lines included", /^\s+3 c$/m.test(r), r);
check("added/removed lines both shown", /^\+\s+8 H$/m.test(r), r);
const far = renderDiff(
  Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"),
  Array.from({ length: 40 }, (_, i) => (i === 2 ? "CHANGED" : `l${i}`)).join("\n"),
);
check("elides far-away unchanged lines", /elided/.test(far), far);

console.log("\nedge cases:");
check("empty before", diffStats("", "a\nb").added === 2);
check("empty after", diffStats("a\nb", "").removed === 2);
check("identical produces no change rows", diffLines("same", "same").every((r) => r.type === "="));
check("CRLF vs LF not treated as change", diffStats("a\r\nb", "a\nb").added === 0 && diffStats("a\r\nb", "a\nb").removed === 0);
const big1 = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
const big2 = big1.replace("line 1500", "line 1500 changed");
const bs = diffStats(big1, big2);
check("large file: only the real change counted", bs.added === 1 && bs.removed === 1, `${bs.added}/${bs.removed}`);
const rr = renderDiff(big1, big2);
check("large file render stays bounded", rr.split("\n").length <= 41, String(rr.split("\n").length));

console.log(fail ? `\n${fail} FAIL / ${pass} ok` : `\nall ${pass} ok`);
process.exit(fail ? 1 : 0);
