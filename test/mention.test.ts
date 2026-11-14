// @skill mentions: expansion into inline skill blocks (pure, no UI).
import { expandSkillMentions, type SkillMeta } from "../src/skills.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

console.log("expansion:");
const dir = mkdtempSync(join(tmpdir(), "ria-skillmention-"));
mkdirSync(join(dir, "alpha"), { recursive: true });
writeFileSync(join(dir, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: test alpha\n---\nALPHA BODY");
mkdirSync(join(dir, "beta"), { recursive: true });
writeFileSync(join(dir, "beta", "SKILL.md"), "---\nname: beta\ndescription: test beta\n---\nBETA BODY");
const skills: SkillMeta[] = [
  { name: "alpha", description: "test alpha", path: join(dir, "alpha", "SKILL.md") },
  { name: "beta", description: "test beta", path: join(dir, "beta", "SKILL.md") },
];

const one = expandSkillMentions("fix it @alpha please", skills);
check("mention keeps the prompt intact", one.startsWith("fix it @alpha please"), one.slice(0, 40));
check("body is appended in a skill block", one.includes('<skill name="alpha">') && one.includes("ALPHA BODY"), one);

const two = expandSkillMentions("@alpha + @beta", skills);
check("two mentions both expand", two.includes("ALPHA BODY") && two.includes("BETA BODY"));
check("one block per skill, not per mention", (two.match(/<skill /g) || []).length === 2);

const dup = expandSkillMentions("@alpha and again @alpha", skills);
check("duplicate mentions collapse", (dup.match(/<skill /g) || []).length === 1);

const unknown = expandSkillMentions("use @doesnotexist now", skills);
check("unknown mention passes through untouched", unknown === "use @doesnotexist now", unknown);

const plain = expandSkillMentions("email me@example.com about @signs", skills);
check("emails and strays are not expansions", plain === "email me@example.com about @signs", plain);

const Mixed = expandSkillMentions("@ALPHA works case-insensitively", skills);
check("mention is case-insensitive", Mixed.includes("ALPHA BODY"));

const dash = expandSkillMentions("run @replica-recon first", skills.concat({ name: "replica-recon", description: "", path: join(dir, "alpha", "SKILL.md") }));
check("dashed names match", dash.includes("ALPHA BODY"));

// broken file → graceful marker, not a crash
const bad: SkillMeta[] = [{ name: "gone", description: "", path: join(dir, "missing", "SKILL.md") }];
const bo = expandSkillMentions("x @gone", bad);
check("unreadable skill degrades gracefully", bo.includes("unreadable at"), bo);

console.log(fail ? `\n${fail} FAIL / ${pass} ok` : `\nall ${pass} ok`);
process.exit(fail ? 1 : 0);
