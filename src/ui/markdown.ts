/**
 * Streaming markdown → ANSI renderer.
 *
 * Works incrementally: calls swallow plain text as it streams off the model,
 * re-rendering only when the visible structure actually changes. Code blocks
 * are highlighted once per complete line (or live while open) so long answers
 * do not flicker like a full re-parse on every token.
 */
import { palette, stripAnsi, width } from "./theme.ts";

// ---------------------------------------------------------------- highlight

const KW =
  /\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|implements|interface|type|enum|import|from|export|default|async|await|yield|try|catch|finally|throw|typeof|instanceof|in|of|void|null|undefined|true|false|this|super|public|private|protected|readonly|static|get|set|def|elif|lambda|pass|raise|with|as|is|not|and|or|None|True|False|self|fn|mut|pub|use|struct|impl|match|where|go|func|package|defer|chan|select|string|number|boolean|any|unknown|never)\b/g;
const NUM = /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/g;
const STR = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
const COMMENT = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g;

/** Order matters: comments/strings win over keywords/numbers. */
export function highlight(line: string, lang?: string): string {
  const paint: Array<{ start: number; end: number; fn: (s: string) => string }> = [];
  const langLower = (lang || "").toLowerCase();
  const hashComments = /^(py|python|sh|bash|ps1|powershell|yaml|yml|rb|ruby|toml|r|perl|makefile|dockerfile|ini|conf)$/.test(langLower);
  const commentRe = hashComments ? /(#[^\n]*)/g : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g;

  if (langLower !== "md" && langLower !== "markdown" && langLower !== "text" && langLower !== "txt") {
    let m: RegExpExecArray | null;
    COMMENT.lastIndex = 0;
    while ((m = commentRe.exec(line))) paint.push({ start: m.index, end: m.index + m[0].length, fn: palette.faint });
    STR.lastIndex = 0;
    while ((m = STR.exec(line))) paint.push({ start: m.index, end: m.index + m[0].length, fn: palette.code });
    KW.lastIndex = 0;
    while ((m = KW.exec(line))) paint.push({ start: m.index, end: m.index + m[0].length, fn: palette.violet });
    NUM.lastIndex = 0;
    while ((m = NUM.exec(line))) paint.push({ start: m.index, end: m.index + m[0].length, fn: palette.warn });
  }

  if (!paint.length) return line;
  paint.sort((a, b) => a.start - b.start);
  // resolve overlaps: earlier (comments/strings) wins
  const merged: typeof paint = [];
  let lastEnd = -1;
  for (const p of paint) {
    if (p.start >= lastEnd) {
      merged.push(p);
      lastEnd = p.end;
    }
  }
  let out = "";
  let i = 0;
  for (const p of merged) {
    out += line.slice(i, p.start) + p.fn(line.slice(p.start, p.end));
    i = p.end;
  }
  return out + line.slice(i);
}

// ---------------------------------------------------------------- renderer

export interface RendererOptions {
  /** left gutter indent for wrapped/block text */
  indent?: string;
  width?: number;
}

/** Minimum gap between streaming redraws. Caps terminal output volume. */
const MIN_REDRAW_MS = 80;

export class MarkdownRenderer {
  private text = "";
  private emitted = 0; // raw chars already flushed to the screen
  private lastRendered = ""; // what we last put on screen (for tests/debug)
  private lines = 0; // terminal lines currently occupied by the live block
  private inCode = false;
  private codeLang = "";
  private pendingDraw = false;
  private drawTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDrawAt = 0;
  private partialFence: string | null = null;
  private indent: string;
  private w: number;

  constructor(opts: RendererOptions = {}) {
    this.indent = opts.indent ?? "";
    this.w = opts.width ?? Math.min(process.stdout.columns || 100, 110);
  }

  /** Bytes rendered so far (used to decide "did anything show up?"). */
  get renderedLength(): number {
    return stripAnsi(this.lastRendered).trim().length;
  }

  get raw(): string {
    return this.text;
  }

  /** Feed a streamed chunk; writes any newly-committed output. */
  push(chunk: string): void {
    this.text += chunk;
    // Track fences incrementally from the appended text only (was O(n) per
    // chunk: re-splitting the whole buffer made streaming quadratic).
    for (const l of chunk.split("\n")) {
      if (this.partialFence !== null) { this.partialFence += l; continue; }
      if (/^\s*(```|~~~)/.test(l)) {
        if (!this.inCode) {
          this.inCode = true;
          this.codeLang = l.replace(/^\s*(```|~~~)/, "").trim();
        } else this.inCode = false;
      }
    }

    if (!this.inCode && !chunk.includes("\n")) return;

    // Rate-limit redraws. Each redraw rewrites the block and, in Windows
    // Terminal, pads the scrollback — unthrottled this amplified output ~25x
    // and could exhaust the terminal's memory.
    this.pendingDraw = true;
    this.scheduleDraw();
  }

  private scheduleDraw(): void {
    if (this.drawTimer !== null) return;
    const elapsed = Date.now() - this.lastDrawAt;
    const wait = Math.max(0, MIN_REDRAW_MS - elapsed);
    this.drawTimer = setTimeout(() => {
      this.drawTimer = null;
      if (!this.pendingDraw) return;
      this.pendingDraw = false;
      this.lastDrawAt = Date.now();
      this.flush(false);
      if (this.pendingDraw) this.scheduleDraw();
    }, wait);
    // Never hold the event loop open just for a redraw.
    (this.drawTimer as unknown as { unref?: () => void }).unref?.();
  }

  private cancelScheduled(): void {
    this.pendingDraw = false;
    if (this.drawTimer !== null) {
      clearTimeout(this.drawTimer);
      this.drawTimer = null;
    }
  }

  /** Flush everything remaining (end of turn). */
  end(): void {
    this.cancelScheduled();
    this.flush(true);
  }

  private flush(final: boolean): void {
    const all = this.text.split("\n");
    const ready = final ? all : all.slice(0, -1);
    if (!ready.length) return;
    const rendered = this.renderBlocks(ready, this.inCode, this.codeLang);
    const piped = !process.stdout.isTTY;
    if (piped) {
      // No redraw possible: emit only the final text, once, ending in a newline.
      if (final && rendered) process.stdout.write(rendered + "\n");
      this.lastRendered = rendered;
      this.lines = 0;
      return;
    }
    if (rendered === this.lastRendered) return;
    this.lastRendered = rendered;
    this.draw(rendered, final ? 0 : 1);
  }

  private draw(rendered: string, extraLines: number): void {
    const out = process.stdout;
    if (!out.isTTY) return;
    if (this.lines > 0) out.write(`\x1b[${this.lines}A\r\x1b[0J`);
    out.write(rendered);
    const content = rendered.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    const n = content.split("\n").length;
    this.lines = Math.max(0, n - 1 + extraLines);
    if (this.lines > 0) {
      // keep cursor at the end of the rendered block
      out.write("\n".repeat(0));
    }
  }

  /**
   * Reset after a finished segment so the next one starts clean. Never
   * re-emits text: whatever was rendered is already on screen.
   */
  done(): void {
    this.cancelScheduled();
    this.lines = 0;
    this.text = "";
    this.emitted = 0;
    this.lastRendered = "";
    this.inCode = false;
    this.codeLang = "";
    this.partialFence = null;
  }

  private renderBlocks(lines: string[], openCode: boolean, lang: string): string {
    const out: string[] = [];
    let i = 0;
    let codeBuf: string[] = [];
    let codeLang = lang;
    let inCode = false;

    const flushCode = () => {
      if (!codeBuf.length && !inCode) return;
      out.push(this.codeHeader(codeLang));
      codeBuf.forEach((cl, idx) => {
        const body = highlight(cl.replace(/\t/g, "  "), codeLang);
        out.push(this.indent + palette.faint(String(idx + 1).padStart(2)) + " " + palette.faint("│") + " " + body);
      });
      out.push("");
      codeBuf = [];
    };

    while (i < lines.length) {
      const line = lines[i];
      const fence = /^\s*(```|~~~)(.*)$/.exec(line);
      if (fence) {
        if (!inCode) {
          flushCode();
          inCode = true;
          codeLang = fence[2].trim();
          i++;
          continue;
        }
        inCode = false;
        flushCode();
        i++;
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        i++;
        continue;
      }
      if (!line.trim()) {
        if (out.length && out[out.length - 1] !== "") out.push("");
        i++;
        continue;
      }
      // list item
      const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (list) {
        const depth = Math.floor(list[1].length / 2);
        const pad = this.indent + "  ".repeat(depth);
        const bullet = /^[-*+]$/.test(list[2]) ? palette.brand("•") : palette.brand(list[2]);
        this.pushWrapped(out, list[3], pad + bullet + " ", pad + "  ".repeat(list[2].length + 1));
        i++;
        continue;
      }
      // heading
      const head = /^(#{1,6})\s+(.*)$/.exec(line);
      if (head) {
        const lvl = head[1].length;
        const txt = this.inline(head[2]);
        if (lvl === 1) out.push("", this.indent + palette.brandAlt(palette.text(head[2].replace(/\*\*/g, ""))) + "", "");
        else out.push(this.indent + palette.boldWhite(txt));
        i++;
        continue;
      }
      // blockquote
      if (/^\s*>\s?/.test(line)) {
        this.pushWrapped(out, line.replace(/^\s*>\s?/, ""), this.indent + palette.faint("│ ") + palette.muted(""), this.indent + palette.faint("│ "));
        i++;
        continue;
      }
      // horizontal rule
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        out.push(this.indent + palette.faint("─".repeat(Math.max(10, this.w - this.indent.length - 2))));
        i++;
        continue;
      }
      // table row: render as plain aligned-ish text
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { i++; continue; }
        const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => this.inline(s.trim()));
        out.push(this.indent + cells.join(palette.faint("  ·  ")));
        i++;
        continue;
      }
      this.pushWrapped(out, line, this.indent, this.indent);
      i++;
    }
    if (inCode && codeBuf.length) {
      // live code block while streaming
      out.push(this.codeHeader(codeLang));
      codeBuf.forEach((cl, idx) => {
        out.push(this.indent + palette.faint(String(idx + 1).padStart(2)) + " " + palette.faint("│") + " " + highlight(cl.replace(/\t/g, "  "), codeLang));
      });
    }
    void openCode;
    while (out.length && out[out.length - 1] === "") out.pop();
    return out.join("\n");
  }

  private codeHeader(lang: string): string {
    if (!lang) return this.indent + palette.faint("┌") ;
    return this.indent + palette.faint("┌ ") + palette.faint(lang.toLowerCase());
  }

  private pushWrapped(out: string[], text: string, firstIndent: string, restIndent: string): void {
    const avail = Math.max(20, this.w - width(firstIndent));
    const avail2 = Math.max(20, this.w - width(restIndent));
    // simple greedy wrap on the *plain* text, then colourise each line so
    // inline syntax survives wrapping
    const words = text.split(/(\s+)/).filter((s) => s !== "");
    let cur = "";
    let curAvail = avail;
    let indent = firstIndent;
    const flushLine = () => {
      if (cur) out.push(indent + this.inline(cur.trimEnd()));
      cur = "";
      indent = restIndent;
      curAvail = avail2;
    };
    for (const word of words) {
      const wlen = width(stripAnsi(word));
      if (cur && width(stripAnsi(cur)) + wlen > curAvail) flushLine();
      cur += word;
      if (width(stripAnsi(cur)) > curAvail && wlen > curAvail) {
        // very long single token: hard-split
        flushLine();
      }
    }
    if (cur.trim()) out.push(indent + this.inline(cur.trimEnd()));
  }

  /** Inline markdown: bold, italic, code, links, strikethrough. */
  inline(s: string): string {
    let out = s;
    // inline code first, protected from other rules via placeholder
    const codes: string[] = [];
    out = out.replace(/`([^`]+)`/g, (_, code: string) => {
      codes.push(palette.code(code));
      return `\u0000${codes.length - 1}\u0000`;
    });
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t: string) => palette.brandAlt(palette.text(t)));
    out = out.replace(/\*\*([^*]+)\*\*/g, (_, t: string) => `\x1b[1m${t}\x1b[0m`);
    out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, (_, p: string, t: string) => `${p}\x1b[3m${t}\x1b[0m`);
    out = out.replace(/(^|[\s(])_([^_\s][^_]*)_/g, (_, p: string, t: string) => `${p}\x1b[3m${t}\x1b[0m`);
    out = out.replace(/~~([^~]+)~~/g, (_, t: string) => `\x1b[9m${t}\x1b[0m`);
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t: string, url: string) => `${t} ${palette.faint(`(${url})`)}`);
    out = out.replace(/<([^>]+@[^>]+)>/g, (_, t: string) => palette.accent(t));
    out = out.replace(/\u0000(\d+)\u0000/g, (_, n: string) => codes[Number(n)]);
    return out;
  }
}

/** One-shot: render a complete markdown string (used for transcripts). */
export function renderMarkdown(md: string, opts: RendererOptions = {}): string {
  const r = new MarkdownRenderer(opts);
  r.push(md.endsWith("\n") ? md : md + "\n");
  r.end();
  return (r as unknown as { lastRendered: string }).lastRendered ?? "";
}
