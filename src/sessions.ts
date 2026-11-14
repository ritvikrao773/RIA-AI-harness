/**
 * Persistent chat sessions, keyed by project directory.
 *
 * Token/time design:
 *  - Saving is a single atomic JSON write per turn (~ms, no API call).
 *  - Resuming injects the stored history directly — zero API calls. The
 *    stored history is already bounded by the agent's working-set budget,
 *    so a resume is as cheap as the session's last state.
 *  - Reading old content is on demand: list returns headers only, search
 *    returns matching snippets, read is capped.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ChatMessage } from "./llm.js";
import { estimateTokens } from "./llm.js";
import { riaHome } from "./config.js";

export interface SessionFile {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  created: string;
  updated: string;
  version: number;
  messages: ChatMessage[]; // excludes the system prompt
  stats?: { in: number; out: number };
}

export interface SessionMeta {
  id: string;
  title: string;
  updated: string;
  messages: number;
  tokensEst: number;
}

const ROOT = () => join(riaHome(), "sessions");

export function projectDir(cwd: string): string {
  const h = createHash("sha256").update(cwd.replace(/[\\/]+$/, "").toLowerCase()).digest("hex").slice(0, 12);
  return join(ROOT(), h);
}

export function newSessionId(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `${stamp}_${randomBytes(2).toString("hex")}`;
}

/** Cheap auto-title from the first user message — no API call. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 59) + "…" : t || "(empty)";
}

export function saveSession(s: Omit<SessionFile, "updated" | "version"> & { updated?: string }): void {
  const dir = projectDir(s.cwd);
  mkdirSync(dir, { recursive: true });
  const file: SessionFile = { ...s, updated: s.updated ?? new Date().toISOString(), version: 1 } as SessionFile;
  const tmp = join(dir, s.id + ".tmp");
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, join(dir, s.id + ".json"));
}

function readSessionFile(path: string): SessionFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionFile;
  } catch {
    return null;
  }
}

export function listSessions(cwd: string, limit = 50): SessionMeta[] {
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  const out: SessionMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const s = readSessionFile(join(dir, name));
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.title,
      updated: s.updated,
      messages: s.messages?.length ?? 0,
      tokensEst: (s.messages ?? []).reduce((n, m) => n + estimateTokens(m.content || ""), 0),
    });
  }
  out.sort((a, b) => (a.updated < b.updated ? 1 : -1));
  return out.slice(0, limit);
}

export function loadSession(cwd: string, id: string): SessionFile | null {
  const p = join(projectDir(cwd), id + ".json");
  if (!existsSync(p)) return null;
  return readSessionFile(p);
}

export function latestSessionId(cwd: string): string | null {
  const all = listSessions(cwd, 1);
  return all[0]?.id ?? null;
}

/** Resolve a (possibly partial) session id: exact match first, then unique prefix. */
export function matchSessionId(cwd: string, arg: string): string | null {
  const all = listSessions(cwd, 200);
  if (all.some((s) => s.id === arg)) return arg;
  const pref = all.filter((s) => s.id.startsWith(arg));
  return pref.length === 1 ? pref[0].id : null;
}

export interface SearchHit {
  id: string;
  title: string;
  updated: string;
  snippet: string;
}

/** Regex search across this project's sessions; returns one snippet per match, capped. */
export function searchSessions(cwd: string, query: string, limit = 12): SearchHit[] {
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch {
    return [];
  }
  const dir = projectDir(cwd);
  if (!existsSync(dir)) return [];
  const hits: SearchHit[] = [];
  const files = readdirSync(dir).filter((n) => n.endsWith(".json")).sort().reverse().slice(0, 30);
  for (const name of files) {
    const s = readSessionFile(join(dir, name));
    if (!s) continue;
    for (const m of s.messages ?? []) {
      const text = (m.content || "").replace(/\s+/g, " ").trim();
      const idx = text.search(re);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 40);
      hits.push({
        id: s.id,
        title: s.title,
        updated: s.updated,
        snippet: (start > 0 ? "…" : "") + text.slice(start, idx + 120) + (idx + 120 < text.length ? "…" : ""),
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}
