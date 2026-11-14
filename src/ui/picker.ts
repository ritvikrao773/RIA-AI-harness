/**
 * Full-screen interactive picker for the REPL: model / provider / session
 * selection with type-to-filter.
 *
 * It borrows the caller's input path instead of installing its own listener:
 * `key()` receives decoded keys and `draw()` renders into the screen above the
 * editor. That keeps a single owner of raw stdin (no double-decoding, no
 * listener leaks) and lets the editor hide its own box while the picker shows.
 */
import { palette, width } from "./theme.ts";
import type { Key } from "./keys.ts";

export interface PickerItem {
  /** Stable value returned on choose (model id, provider name, session id). */
  value: string;
  label: string;
  desc?: string;
  /** Extra right-aligned note (context size, "current", …). */
  note?: string;
  disabled?: boolean;
}

export interface PickerSpec {
  title: string;
  items: PickerItem[];
  footer?: string;
  /** Max rows rendered at once (default 12). */
  pageSize?: number;
}

export class Picker {
  private filter = "";
  private index = 0;
  private scroll = 0;
  private rows = 0;
  done = false;
  result: string | null = null;

  constructor(
    readonly spec: PickerSpec,
    private host: { cols(): number; write(s: string): void },
  ) {}

  private visible(): PickerItem[] {
    const f = this.filter.toLowerCase();
    if (!f) return this.spec.items;
    return this.spec.items.filter(
      (i) => i.value.toLowerCase().includes(f) || i.label.toLowerCase().includes(f),
    );
  }

  /** Feed one key. Returns "none" until the picker closes. */
  key(k: Key): "none" | "done" {
    if (this.done) return "done";
    const items = this.visible();
    const n = Math.max(1, items.length);

    switch (k.t) {
      case "esc":
        this.finish(null);
        return "done";
      case "ctrl":
        if (k.ch === "c") { this.finish(null); return "done"; }
        return "none";
      case "up":
        this.index = (this.index - 1 + n) % n;
        return "none";
      case "down":
      case "tab":
        this.index = (this.index + 1) % n;
        return "none";
      case "enter": {
        const pick = items[this.index];
        if (!pick) return "none";
        if (pick.disabled) return "none";
        this.finish(pick.value);
        return "done";
      }
      case "backspace":
        if (this.filter) this.filter = this.filter.slice(0, -1);
        this.index = 0;
        return "none";
      case "char":
        this.filter += k.ch;
        this.index = 0;
        return "none";
      case "paste":
        this.filter += k.text.replace(/\s+/g, " ");
        this.index = 0;
        return "none";
      default:
        return "none";
    }
  }

  private finish(value: string | null): void {
    this.result = value;
    this.done = true;
    this.erase();
  }

  erase(): void {
    if (this.rows > 0) {
      this.host.write(`\x1b[${this.rows}A\r\x1b[0J`);
      this.rows = 0;
    }
  }

  draw(): void {
    if (this.done) return;
    const W = Math.max(30, this.host.cols());
    const page = this.spec.pageSize ?? 12;
    const items = this.visible();
    if (this.index >= items.length) this.index = Math.max(0, items.length - 1);
    if (this.index < this.scroll) this.scroll = this.index;
    if (this.index >= this.scroll + page) this.scroll = this.index - page + 1;

    const shown = items.slice(this.scroll, this.scroll + page);
    const labelW = Math.min(28, Math.max(8, ...shown.map((i) => width(i.label))));
    const rule = palette.faint("─".repeat(Math.max(10, Math.min(W - 4, 64))));

    const out: string[] = [];
    const filterNote = this.filter ? palette.faint(`  filter: ${this.filter}`) : "";
    out.push(" " + palette.brand("▏ ") + palette.boldWhite(this.spec.title) + filterNote);
    out.push(" " + rule);

    if (!shown.length) {
      out.push("   " + palette.faint(this.spec.items.length ? "no matches" : "nothing to show"));
    }
    shown.forEach((it, i) => {
      const abs = this.scroll + i;
      const sel = abs === this.index;
      const label = it.label.padEnd(labelW).slice(0, Math.max(labelW, 0));
      const note = it.note ? palette.faint("  " + it.note) : "";
      const line =
        (sel ? palette.brand("❯ ") : "  ") +
        (it.disabled ? palette.faint(label) : sel ? palette.boldWhite(label) : palette.text(label)) +
        (it.desc ? palette.faint("  " + it.desc) : "") +
        note;
      out.push(" " + line);
    });

    if (items.length > page) {
      out.push(" " + palette.faint(`  ${this.index + 1}/${items.length}`));
    }
    out.push(" " + rule);
    out.push(
      " " +
        palette.faint(
          this.spec.footer ??
            "↑↓ move · type to filter · Enter select · Esc back",
        ),
    );

    let s = "\x1b[?25l";
    if (this.rows > 0) s += `\x1b[${this.rows}A`;
    s += "\r\x1b[0J" + out.join("\n") + "\n\x1b[?25h";
    this.host.write(s);
    this.rows = out.length;
  }
}
