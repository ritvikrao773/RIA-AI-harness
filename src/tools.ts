import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { cwd } from "node:process";
import type { ToolDef } from "./llm.js";
import type { SkillMeta } from "./skills.js";
import { loadSkillContent } from "./skills.js";
import { diffStats, renderDiff } from "./diff.js";

// Bounded at the tool boundary: a huge read must not enter the prompt at all.
// Head+tail keeps enough context to reason about; the model can re-read a
// narrower range when it needs more.
const MAX_OUT = 4_000 * 4; // ≈16k chars ≈4k tokens

function clip(s: string): string {
  if (s.length <= MAX_OUT) return s;
  const head = Math.floor(MAX_OUT * 0.65);
  const tail = MAX_OUT - head;
  return (
    s.slice(0, head) +
    `\n...[${s.length - MAX_OUT} chars omitted — re-read a smaller range if needed]\n` +
    s.slice(s.length - tail)
  );
}

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024; // proactive kill, before the 10MB buffer limit
const MAX_CHILD_RSS_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB, per bash command

function shell(cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    let killedFor = "";
    let out = "";
    let bytes = 0;
    let done = false;

    // spawn gives real-time pipes; execFile buffers internally, which delays a
    // watchdog and lets a runaway fill memory before we can react.
    const child = spawn(isWin ? "powershell.exe" : "bash", isWin ? ["-NoProfile", "-Command", cmd] : ["-c", cmd], {
      cwd: cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(watch);
      clearTimeout(timer);
      if (err && !out) out = String(err.message);
      if (killedFor) out += `\n[ria stopped this command: ${killedFor}]`;
      resolve(clip(out) || "(no output, exit ok)");
    };

    const onData = (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        killedFor = `output exceeded ${MAX_OUTPUT_BYTES / 1024 / 1024} MB`;
        child.kill();
        return;
      }
      out += d.toString();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    const timer = setTimeout(() => {
      killedFor = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      child.kill();
      finish();
    }, timeoutMs);

    // Watch resident memory so a runaway loop cannot exhaust the machine and
    // get other applications killed by the OS.
    const watch = setInterval(() => {
      const pid = child.pid;
      if (done || !pid) return;
      try {
        const rss = process.platform === "win32"
          ? Number((execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8" }).split(",")[4]?.replace(/[^\d]/g, "") || 0)) * 1024
          : 0;
        if (rss > MAX_CHILD_RSS_BYTES) {
          killedFor = `memory exceeded ${MAX_CHILD_RSS_BYTES / 1024 / 1024 / 1024} GB`;
          child.kill();
        }
      } catch { /* ignore probe failures */ }
    }, 1000);
    (watch as unknown as { unref?: () => void }).unref?.();

    child.on("error", (e) => finish(e));
    child.on("close", () => finish());
  });
}

function walk(dir: string, files: string[] = [], depth = 0): string[] {
  if (depth > 12) return files;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, files, depth + 1);
    else files.push(full);
  }
  return files;
}

function resolvePath(p: string): string {
  return isAbsolute(p) ? p : join(cwd(), p);
}

/**
 * Glob → regex, path-separator agnostic (callers pass "/"-joined paths).
 * `**\/` = any depth including none · `**` = anything · `*` = within a segment
 * · `?` = one char · `{a,b}` = alternatives.
 */
function globToRegex(pat: string): RegExp {
  if (pat === "**" || pat === "**/*" || pat === "") return /./; // everything
  let re = "";
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === "*") {
      if (pat[i + 1] === "*") {
        const slash = pat[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 3 : 2;
        continue;
      }
      re += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") { re += "[^/]"; i++; continue; }
    if (ch === "{") {
      const end = pat.indexOf("}", i);
      if (end > i) {
        const alts = pat.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"));
        re += "(?:" + alts.join("|") + ")";
        i = end + 1;
        continue;
      }
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$");
}

export function buildTools(skills: SkillMeta[]): ToolDef[] {
  const tools: ToolDef[] = [
    {
      name: "bash",
      description: "Run a shell command (PowerShell on Windows). Returns stdout+stderr, capped.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", description: "default 120000" },
        },
        required: ["command"],
      },
    },
    {
      name: "read_file",
      description: "Read a text file. Optional offset/limit (lines).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          limit: { type: "integer" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a file with content (parent dirs are created).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
    {
      name: "edit_file",
      description: "Exact find-and-replace in a file. Read the file first and copy old_string verbatim. Fails if old_string is missing or ambiguous — on failure, re-read the file and retry. Prefer write_file when rewriting most of a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
    {
      name: "glob",
      description: "List files matching a glob pattern, e.g. src/**/*.ts. Optional directory root.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, directory: { type: "string" } },
        required: ["pattern"],
      },
    },
    {
      name: "grep",
      description: "Search file contents with a regex. Optional include glob (e.g. *.ts) and directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          include: { type: "string" },
          directory: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  ];

  if (skills.length) {
    tools.push({
      name: "skill",
      description: `Load the full instructions of an installed skill: ${skills.map((s) => s.name).join(", ")}.`,
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "skill name" } },
        required: ["name"],
      },
    });
  }
  return tools;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  skills: SkillMeta[],
): Promise<string> {
  try {
    switch (name) {
      case "bash":
        return await shell(args.command as string, (args.timeout_ms as number) || 120_000);

      case "read_file": {
        const p = resolvePath(args.path as string);
        const text = readFileSync(p, "utf8");
        const lines = text.split("\n");
        const off = Math.max(0, ((args.offset as number) || 1) - 1);
        const lim = (args.limit as number) || 2000;
        const slice = lines.slice(off, off + lim).map((l, i) => `${off + i + 1}: ${l}`).join("\n");
        return clip(slice + (off + lim < lines.length ? `\n...[${lines.length - off - lim} more lines]` : ""));
      }

      case "write_file": {
        const p = resolvePath(args.path as string);
        mkdirSync(dirname(p), { recursive: true });
        const content = args.content as string;
        const existed = existsSync(p);
        const before = existed ? readFileSync(p, "utf8") : "";
        writeFileSync(p, content);
        const st = diffStats(before, content);
        return existed
          ? `wrote ${p} (+${st.added} -${st.removed} lines, ${content.length} bytes)`
          : `created ${p} (${content.split(/\r?\n/).length} lines, ${content.length} bytes)`;
      }

      case "edit_file": {
        const p = resolvePath(args.path as string);
        const text = readFileSync(p, "utf8");
        const oldS = args.old_string as string;
        const newS = args.new_string as string;
        if (!oldS) return "edit failed: old_string is empty";

        // Windows files are usually CRLF; models emit LF. Try exact first,
        // then newline-normalised, and write back in the file's own style.
        const crlf = text.includes("\r\n");
        const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s.replace(/\r\n/g, "\n"));

        let target = oldS;
        let count = text.split(target).length - 1;
        if (count === 0 && (crlf || text !== text.replace(/\r\n/g, "\n"))) {
          target = norm(oldS);
          count = text.split(target).length - 1;
        }
        if (count === 0) {
          // tolerate trailing-whitespace drift on each line
          const loose = norm(oldS).replace(/[ \t]+$/gm, "");
          const lines = text.split(/\r?\n/);
          const hay = lines.map((l) => l.replace(/[ \t]+$/g, ""));
          const want = loose.split("\r\n");
          for (let i = 0; i + want.length <= hay.length; i++) {
            if (want.every((w, j) => hay[i + j] === w)) {
              const repl = norm(newS).split("\r\n");
              lines.splice(i, want.length, ...repl);
              const out = lines.join(crlf ? "\r\n" : "\n");
              if (out === text) return "edit failed: new content is identical to the file";
              writeFileSync(p, out);
              const st2 = diffStats(text, out);
              return `edited ${p} (line ${st2.firstLine || i + 1} · +${st2.added} -${st2.removed} lines, whitespace-trimmed match)\n${renderDiff(text, out, { path: p })}`;
            }
          }
          return `edit failed: old_string not found in ${p}. The file may have changed — read it again and copy the exact text.`;
        }
        if (count > 1 && !args.replace_all)
          return `edit failed: old_string matches ${count} places — add more surrounding context or set replace_all=true`;

        const newText = args.replace_all
          ? text.split(target).join(norm(newS))
          : text.replace(target, norm(newS));
        if (newText === text) return "edit failed: new content is identical to the file";
        writeFileSync(p, newText);
        const st = diffStats(text, newText);
        const where = st.changedLines.length ? `line ${st.firstLine}` : "same content";
        return `edited ${p} (${where} · +${st.added} -${st.removed} lines${count > 1 ? ` · ${count} replacements` : ""})\n${renderDiff(text, newText, { path: p })}`;
      }

      case "glob": {
        const root = args.directory ? resolvePath(args.directory as string) : cwd();
        const pat = (args.pattern as string).replace(/\\/g, "/").replace(/^\.\//, "");
        const re = globToRegex(pat);
        const all = walk(root).map((f) => relative(root, f).replace(/\\/g, "/"));
        const hits = all.filter((f) => re.test(f)).slice(0, 500);
        return clip(hits.join("\n") || "(no matches)");
      }

      case "grep": {
        const root = args.directory ? resolvePath(args.directory as string) : cwd();
        const re = new RegExp(args.pattern as string, "i");
        const incRe = args.include
          ? new RegExp("(^|[/\\\\])" + (args.include as string).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*") + "$", "i")
          : null;
        const hits: string[] = [];
        for (const f of walk(root)) {
          if (incRe && !incRe.test(f)) continue;
          let text;
          try {
            if (statSync(f).size > 2_000_000) continue;
            text = readFileSync(f, "utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < 200; i++) {
            if (re.test(lines[i])) hits.push(`${relative(root, f)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
          if (hits.length >= 200) break;
        }
        return clip(hits.join("\n") || "(no matches)");
      }

      case "skill": {
        const meta = skills.find((s) => s.name === args.name || s.name.toLowerCase() === (args.name as string).toLowerCase());
        if (!meta) return `unknown skill "${args.name}". Available: ${skills.map((s) => s.name).join(", ")}`;
        return loadSkillContent(meta);
      }

      default:
        return `unknown tool ${name}`;
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}
