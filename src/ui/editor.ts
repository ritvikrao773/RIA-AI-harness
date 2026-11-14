/** Multi-line editor with history, slash-command completion, footer hints. */
import { palette, sym, width } from "./theme.ts";
import type { Key } from "./keys.ts";

export interface Completion {
  name: string;
  desc: string;
  insert: string;
}

export interface EditorHost {
  cols(): number;
  write(s: string): void;
}

/**
 * Ranked match of a skill name against the typed "@" token, best first.
 * Prefix beats word-start, then substring ("vide" -> ai-video-editor at
 * word start), then subsequence ("ave" -> ai-video-editor).
 * Returns -1 for no match.
 */
function mentionScore(name: string, query: string): number {
  if (!query) return 0;
  if (name.startsWith(query)) return 0;
  if (name.includes("-" + query)) return 1;
  if (name.includes(query)) return 2;
  let i = 0;
  for (const ch of name) if (ch === query[i]) i++;
  return i === query.length ? 3 : -1;
}

const MAX_INPUT_ROWS = 10;
/** Rows of the completion menu drawn at once; the window slides on ↓/↑. */
const MENU_WINDOW = 12;

export class Editor {
  value = "";
  cursor = 0;
  history: string[] = [];
  historyIndex = -1;
  private draft = "";
  focused = true;
  completions: Completion[] = [];
  private compIndex = 0;
  private lastRows = 0;
  private scrollLine = 0;
  /** Set when the previous key was ESC, to recognise Alt+Enter. */
  private altEnter = false;

  constructor(
    private host: EditorHost,
    initialHistory: string[] = [],
  ) {
    this.history = initialHistory.slice();
  }

  reset(): void {
    this.value = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.draft = "";
    this.compIndex = 0;
    this.scrollLine = 0;
  }

  clearHistory(): void {
    this.history = [];
    this.historyIndex = -1;
  }

  addHistory(line: string): void {
    const t = line.trim();
    if (!t) return;
    if (this.history[this.history.length - 1] === t) return;
    this.history.push(t);
    if (this.history.length > 200) this.history.shift();
  }

  /** Shift+Enter / line feed: insert a line break without submitting. */
  newline(): void {
    this.insert("\n");
  }

  // ------------------------------------------------------------ completions

  private menu(): Completion[] {
    if (this.value.includes("\n")) return [];
    // "@" mid-text mentions a skill: "please @pick this" offers matching
    // skills from the token after the last "@" before the cursor.
    const at = this.mentionQuery();
    if (at !== null) {
      const q = at.toLowerCase();
      return this.completions
        .map((c) => ({ c, s: c.name.startsWith("@") ? mentionScore(c.name.slice(1).toLowerCase(), q) : -1 }))
        .filter((m) => m.s >= 0)
        .sort((a, b) => a.s - b.s)
        .map((m) => m.c)
        .slice(0, 24);
    }
    if (!this.value.startsWith("/")) return [];
    const q = this.value.trim().toLowerCase();
    if (q.includes(" ")) return [];
    return this.completions.filter((c) => c.name.toLowerCase().startsWith(q));
  }

  /** Text after the last "@" before the cursor, or null when not mentioning. */
  private mentionQuery(): string | null {
    if (this.value.startsWith("/")) return null; // "/"-commands never mention
    const upto = this.value.slice(0, this.cursor);
    const i = upto.lastIndexOf("@");
    if (i < 0) return null;
    const token = upto.slice(i + 1);
    if (/\s/.test(token)) return null; // whitespace already ended the token
    return token;
  }

  private handleCompletionKey(k: Key): boolean {
    const menu = this.menu();
    if (!menu.length) {
      this.compIndex = 0;
      return false;
    }
    if (k.t === "up") {
      this.compIndex = (this.compIndex - 1 + menu.length) % menu.length;
      return true;
    }
    if (k.t === "down") {
      this.compIndex = (this.compIndex + 1) % menu.length;
      return true;
    }
    // Tab inside an @-mention completes just the token; "/"-menu replaces
    // the whole line (it is a command).
    if (k.t === "tab" || k.t === "enter") {
      const isMention = !this.value.startsWith("/");
      const pick = menu[this.compIndex % menu.length];
      if (isMention) {
        const upto = this.value.slice(0, this.cursor);
        const at = upto.lastIndexOf("@");
        if (at >= 0) {
          const typed = upto.slice(at).toLowerCase();
          // Enter on an already-complete mention submits the message instead
          // of re-completing it (that used to swallow the Enter entirely).
          if (k.t === "enter" && typed === pick.name.toLowerCase()) return false;
          // Tab (or Enter on a partial token) replaces only the token.
          const insert = k.t === "tab" ? pick.insert.trimEnd() : pick.name;
          this.value = this.value.slice(0, at) + insert + this.value.slice(this.cursor);
          this.cursor = at + insert.length;
          this.compIndex = 0;
          return true;
        }
      }
      if (k.t === "tab") {
        this.value = pick.insert;
        this.cursor = this.value.length;
        this.compIndex = 0;
        return true;
      }
      // Enter on the slash menu: submit the completed command.
      if (k.t === "enter") {
        const typed = this.value.trim().toLowerCase();
        const exact = menu.find((c) => c.name.toLowerCase() === typed);
        if (!exact && pick.insert !== this.value) {
          this.value = pick.insert;
          this.cursor = this.value.length;
          this.compIndex = 0;
          return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------ editing

  handle(key: Key): "submit" | "none" | "interrupt" | "eof" | "clear-screen" | "help" | "picker" {
    if (key.t === "ctrl" && key.ch === "c") return "interrupt";
    if (key.t === "ctrl" && key.ch === "d") return this.value ? "none" : "eof";
    if (key.t === "ctrl" && key.ch === "l") return "clear-screen";

    if (this.handleCompletionKey(key)) return "none";
    if (this.compIndex) this.compIndex = 0;

    // Alt+Enter decodes as ESC then Enter: continue on a new line.
    if (key.t === "esc") {
      this.altEnter = true;
      return "none";
    }
    if (key.t === "enter" && this.altEnter) {
      this.altEnter = false;
      this.newline();
      return "none";
    }
    this.altEnter = false;

    switch (key.t) {
      case "char":
        this.insert(key.ch);
        break;
      case "newline":
        this.newline();
        break;
      case "paste":
        this.insert(key.text.replace(/\r\n?/g, "\n"));
        break;
      case "f1":
        return "help";
      case "f12":
        return "picker";
      case "enter": {
        const before = this.value.slice(0, this.cursor);
        if (before.endsWith("\\")) {
          this.value = before.slice(0, -1) + "\n" + this.value.slice(this.cursor);
          this.cursor = before.length;
          return "none";
        }
        const next = this.value.slice(this.cursor, this.cursor + 1);
        const isLineEnd = next === "" || next === "\n";
        if (!isLineEnd) {
          this.insert("\n");
          return "none";
        }
        if (!this.value.trim()) return "none";
        return "submit";
      }
      case "tab":
        this.insert("  ");
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
          this.cursor--;
        }
        break;
      case "delete":
        if (this.cursor < this.value.length) {
          this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
        }
        break;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        this.cursor = Math.min(this.value.length, this.cursor + 1);
        break;
      case "home":
        this.cursor = this.lineStart(this.cursor);
        break;
      case "end":
        this.cursor = this.lineEnd(this.cursor);
        break;
      case "up":
        this.moveVertical(-1);
        break;
      case "down":
        this.moveVertical(1);
        break;
      case "ctrl":
        this.ctrlKey(key.ch);
        break;
      default:
        break;
    }
    return "none";
  }

  private ctrlKey(ch: string): void {
    if (ch === "a") this.cursor = this.lineStart(this.cursor);
    else if (ch === "e") this.cursor = this.lineEnd(this.cursor);
    else if (ch === "u") {
      const s = this.lineStart(this.cursor);
      this.value = this.value.slice(0, s) + this.value.slice(this.cursor);
      this.cursor = s;
    } else if (ch === "k") {
      const e = this.lineEnd(this.cursor);
      this.value = this.value.slice(0, this.cursor) + this.value.slice(e);
    } else if (ch === "w") {
      let s = this.cursor;
      while (s > 0 && /\s/.test(this.value[s - 1])) s--;
      while (s > 0 && !/[\s/.]/.test(this.value[s - 1])) s--;
      this.value = this.value.slice(0, s) + this.value.slice(this.cursor);
      this.cursor = s;
    }
  }

  private insert(s: string): void {
    this.value = this.value.slice(0, this.cursor) + s + this.value.slice(this.cursor);
    this.cursor += s.length;
    this.compIndex = 0;
  }

  private lineStart(p: number): number {
    const i = this.value.lastIndexOf("\n", p - 1);
    return i < 0 ? 0 : i + 1;
  }

  private lineEnd(p: number): number {
    const i = this.value.indexOf("\n", p);
    return i < 0 ? this.value.length : i;
  }

  private moveVertical(dir: number): void {
    const lines = this.value.split("\n");
    const curLine = this.value.slice(0, this.cursor).split("\n").length - 1;
    const curCol = this.cursor - this.lineStart(this.cursor);
    const target = curLine + dir;
    if (target < 0) {
      this.historyMove(-1);
      return;
    }
    if (target >= lines.length) {
      this.historyMove(1);
      return;
    }
    let pos = 0;
    for (let i = 0; i < target; i++) pos += lines[i].length + 1;
    this.cursor = pos + Math.min(curCol, lines[target].length);
  }

  private historyMove(dir: number): void {
    if (!this.history.length) return;
    if (this.historyIndex === -1) {
      if (dir > 0) return;
      this.draft = this.value;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += dir;
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1;
        this.value = this.draft;
        this.cursor = this.value.length;
        return;
      }
      if (this.historyIndex < 0) this.historyIndex = 0;
    }
    this.value = this.history[this.historyIndex] ?? "";
    this.cursor = this.value.length;
    this.compIndex = 0;
  }

  // ------------------------------------------------------------ drawing

  draw(footer = ""): void {
    if (!this.focused) return;
    const W = Math.max(24, this.host.cols());
    const availW = Math.max(10, W - 2);
    const out: string[] = [];

    const menu = this.menu();
    if (menu.length) {
      // Sliding window: show at most MENU_WINDOW rows, scrolled so the
      // selected item stays visible; the rest is indicated in a hint row.
      const start =
        menu.length > MENU_WINDOW
          ? Math.max(0, Math.min(this.compIndex - 3, menu.length - MENU_WINDOW))
          : 0;
      const shown = menu.slice(start, start + MENU_WINDOW);
      const nameW = Math.min(16, Math.max(...shown.map((m) => m.name.length)));
      shown.forEach((m, i) => {
        const sel = start + i === this.compIndex % menu.length;
        const label = m.name.padEnd(nameW);
        out.push(
          sel
            ? "  " + palette.brand(sym.user) + " " + palette.boldWhite(label) + "  " + palette.muted(m.desc)
            : "    " + palette.faint(label) + "  " + palette.faint(m.desc),
        );
      });
      const above = start;
      const below = menu.length - (start + shown.length);
      if (above || below) {
        const arrows = `${above ? `↑${above} ` : ""}${below ? `↓${below}` : ""}`;
        out.push("  " + palette.faint(`${arrows} keep typing to narrow`));
      }
    }

    const raw = this.value.split("\n");
    const visual: Array<{ text: string; logical: number; off: number }> = [];
    for (let i = 0; i < raw.length; i++) {
      const line = raw[i];
      if (!line.length) {
        visual.push({ text: "", logical: i, off: 0 });
        continue;
      }
      let off = 0;
      while (off < line.length) {
        let take = Math.min(availW, line.length - off);
        while (take > 1 && width(line.slice(off, off + take)) > availW) take--;
        visual.push({ text: line.slice(off, off + take), logical: i, off });
        off += take;
      }
      if (line.length % availW === 0) visual.push({ text: "", logical: i, off: line.length });
    }

    const cursorRow = this.value.slice(0, this.cursor).split("\n").length - 1;
    const cursorCol = this.cursor - this.lineStart(this.cursor);
    let curVisual = visual.findIndex(
      (v) => v.logical === cursorRow && cursorCol >= v.off && cursorCol <= v.off + v.text.length,
    );
    if (curVisual < 0) curVisual = visual.length - 1;

    if (curVisual < this.scrollLine) this.scrollLine = curVisual;
    if (curVisual >= this.scrollLine + MAX_INPUT_ROWS) this.scrollLine = curVisual - MAX_INPUT_ROWS + 1;
    this.scrollLine = Math.max(0, Math.min(this.scrollLine, Math.max(0, visual.length - MAX_INPUT_ROWS)));

    const visible = visual.slice(this.scrollLine, this.scrollLine + MAX_INPUT_ROWS);
    for (const v of visible) {
      const isFirst = v.logical === 0 && v.off === 0;
      const prefix = isFirst ? palette.brand(sym.user) + " " : "  ";
      const accent = this.value.startsWith("/") || /(^|\s)@[\w-]*$/.test(this.value)
        ? palette.brand
        : (s: string) => s;
      let body: string;
      if (v.logical === cursorRow && cursorCol >= v.off && cursorCol <= v.off + v.text.length) {
        const rel = cursorCol - v.off;
        const before = v.text.slice(0, rel);
        const ch = v.text.slice(rel, rel + 1) || " ";
        const after = v.text.slice(rel + 1);
        body =
          accent(before) + ("\x1b[4m" + accent(ch) + "\x1b[24m") + accent(after);
      } else {
        body = accent(v.text);
      }
      out.push(prefix + body);
    }

    let s = "\x1b[?25l";
    if (this.lastRows > 0) s += `\x1b[${this.lastRows}A`;
    // `…` marks the row being edited, so it stays visible even when empty.
    const hint = footer ? palette.faint(footer) : palette.faint("…");
    s += "\r\x1b[0J" + out.join("\n") + "\n" + hint + "\n\x1b[?25h";
    this.host.write(s);
    this.lastRows = out.length + 1;
  }

  erase(): void {
    if (this.lastRows > 0) {
      this.host.write(`\x1b[${this.lastRows}A\r\x1b[0J`);
      this.lastRows = 0;
    }
  }
}
