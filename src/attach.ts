/**
 * Drag-and-drop support: terminals paste dropped files/folders as paths
 * (PowerShell quotes paths with spaces). We detect them and attach content.
 *
 * Token strategy: small text files are inlined (~≤1.5k tokens); large files and
 * folders only get a marker line — the agent reads them with read_file/bash
 * on demand, so a 50MB drop costs nothing upfront.
 */
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";

const MAX_INLINE_BYTES = 6_000; // ≈1.5k tokens
const MAX_FOLDER_ENTRIES = 50;

function looksLikePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("~/") || s.startsWith(".\\") || s.startsWith("./") || s.startsWith("\\\\");
}

/** Extract existing filesystem paths from pasted text. */
export function extractPaths(text: string): string[] {
  const found = new Set<string>();
  // quoted paths (drag-drop with spaces)
  for (const m of text.matchAll(/"([^"\n]{2,300})"/g)) {
    const p = m[1].trim();
    if (looksLikePath(p) && existsSync(p)) found.add(p);
  }
  // bare paths: drive-letter, home-relative, or explicit-relative
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s"“”]+|~\/[^\s"“”]+|\.[\\/][^\s"“”]+/g)) {
    const p = m[0].replace(/[.,;:]+$/, "");
    if (existsSync(p)) found.add(p);
  }
  return [...found];
}

function listFolder(dir: string): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return `contents unreadable: ${(e as Error).message}`;
  }
  const shown = entries.slice(0, MAX_FOLDER_ENTRIES);
  const more = entries.length > MAX_FOLDER_ENTRIES ? ` … (+${entries.length - MAX_FOLDER_ENTRIES} more)` : "";
  return `contents (${entries.length} entries): ${shown.join(", ")}${more}`;
}

/** One compact context block for an attached path. */
export function attachmentContext(p: string): string {
  if (!existsSync(p)) return `[attached path missing: ${p}]`;
  const st = statSync(p);
  if (st.isDirectory()) {
    return `[attached folder: ${p}]\n${listFolder(p)}\nExplore with glob/grep/bash as needed.`;
  }
  if (st.size <= MAX_INLINE_BYTES) {
    try {
      return `[attached file: ${p}]\n${readFileSync(p, "utf8")}`;
    } catch {
      // fall through to marker
    }
  }
  return `[attached file: ${p}, ${st.size} bytes — read it with read_file]`;
}

/** Expand a submitted prompt with attachment context, keeping the prompt intact. */
export function expandAttachments(text: string): string {
  const paths = extractPaths(text);
  if (!paths.length) return text;
  const blocks = paths.map(attachmentContext).join("\n\n");
  return `${text}\n\n${blocks}`;
}
