import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Find skill directories: each subdir with a SKILL.md, or a bare SKILL.md. */
export function discoverSkills(dirs: string[]): SkillMeta[] {
  const skills: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const skillMd = statSync(full, { throwIfNoEntry: false })?.isDirectory()
        ? join(full, "SKILL.md")
        : entry.toLowerCase() === "skill.md"
          ? full
          : null;
      if (!skillMd || !existsSync(skillMd)) continue;
      const text = readFileSync(skillMd, "utf8");
      const fm = parseFrontmatter(text);
      const name = fm.name || (statSync(full).isDirectory() ? entry : basename(dirname(full)));
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const desc = (fm.description || "").slice(0, 200);
      skills.push({ name, description: desc, path: skillMd });
    }
  }
  return skills;
}

export function defaultSkillsDirs(): string[] {
  return [
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
}

/** One cheap line per skill for the system prompt. */
export function skillPromptLines(skills: SkillMeta[]): string {
  if (!skills.length) return "";
  return "\nSkills available (use the skill tool to load full instructions):\n" +
    skills.map((s) => `- ${s.name}: ${s.description}`).join("\n") + "\n";
}

/**
 * Expand `@name` mentions in a prompt into the skill's full instructions.
 * The mention stays in the text (so the model sees which skill was asked
 * for) and the skill body is appended as a fenced block, exactly like the
 * skill tool would load. Unknown mentions pass through untouched.
 */
export function expandSkillMentions(text: string, skills: SkillMeta[]): string {
  if (!text.includes("@")) return text;
  const byName = new Map(skills.map((s) => [s.name.toLowerCase(), s]));
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:^|\s)@([\w-]+)/g)) {
    const s = byName.get(m[1].toLowerCase());
    if (s) found.add(s.name.toLowerCase());
  }
  if (!found.size) return text;
  const blocks: string[] = [];
  for (const key of found) {
    const meta = byName.get(key)!;
    try {
      const body = loadSkillContent(meta);
      blocks.push(`<skill name="${meta.name}">\n${body.trim()}\n</skill>`);
    } catch {
      blocks.push(`<skill name="${meta.name}">unreadable at ${meta.path}</skill>`);
    }
  }
  return `${text}\n\n${blocks.join("\n\n")}`;
}

export function loadSkillContent(meta: SkillMeta): string {
  return readFileSync(meta.path, "utf8");
}
