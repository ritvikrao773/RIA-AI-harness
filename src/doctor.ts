/**
 * `ria doctor` — offline self-diagnostics.
 *
 * Collects a report (no printing) so it can be unit-tested: config file,
 * provider key sources (config / env / apiKeyCommand), default-provider
 * usability, PATH self-install state (Windows), and skills directories.
 * Network is deliberately not touched: doctor must be fast and always work.
 */
import { existsSync } from "node:fs";
import process from "node:process";
import { configPath, apiKeySource, isKeyless, describeFetchedAt, isFresh, type Config } from "./config.js";
import { riaBinDir, userPathFromRegistry, pathContains } from "./pathinstall.js";
import { palette } from "./ui/theme.ts";

export interface DoctorOptions {
  version: string;
  /** Pre-supplied user PATH string (tests); read from the registry when absent. */
  userPath?: string;
}

export interface DoctorRow {
  label: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
}

export interface DoctorReport {
  rows: DoctorRow[];
  /** False only when something blocks normal operation (not mere warnings). */
  ok: boolean;
}

export function runDoctor(cfg: Config, opts: DoctorOptions): DoctorReport {
  const rows: DoctorRow[] = [];

  rows.push({ label: "version", status: "info", detail: `${opts.version} · ${process.platform}` });

  const cPath = configPath();
  rows.push({ label: "config", status: existsSync(cPath) ? "ok" : "warn", detail: cPath });

  const entries = Object.entries(cfg.providers);
  const keyed = entries.filter(([n, p]) => !isKeyless(n, p) && Boolean(apiKeySource(n, p).key));
  const keylessN = entries.filter(([n, p]) => isKeyless(n, p));
  const noKey = entries.filter(([n, p]) => !isKeyless(n, p) && !apiKeySource(n, p).key);
  rows.push({
    label: "providers",
    status: "info",
    detail: `${entries.length} total · ${keyed.length} with key · ${keylessN.length} keyless · ${noKey.length} without key`,
  });

  // Default provider must be usable: keyed and with at least one model.
  const dname = cfg.defaultProvider;
  const dp = cfg.providers[dname];
  if (!dp) {
    rows.push({ label: "default provider", status: "fail", detail: `"${dname}" is not in providers — pick one: Ria provider setup` });
  } else {
    const usable = isKeyless(dname, dp) || Boolean(apiKeySource(dname, dp).key);
    const modelCount = Object.keys(dp.models).length;
    if (!usable) {
      rows.push({ label: "default provider", status: "fail", detail: `${dname} has no key — run: Ria provider setup ${dname}` });
    } else if (!modelCount) {
      rows.push({ label: "default provider", status: "warn", detail: `${dname} has no models yet — run: Ria models ${dname}` });
    } else {
      rows.push({ label: "default provider", status: "ok", detail: `${dname} · ${cfg.defaultModel || "(no model set)"} · ${modelCount} models` });
    }
  }

  // Providers that resolve their key through a helper command (listed, not run).
  const helperUsers = entries.filter(([, p]) => p.apiKeyCommand);
  if (helperUsers.length) {
    rows.push({ label: "apiKeyCommand", status: "info", detail: helperUsers.map(([n]) => n).join(", ") });
  }

  // PATH self-install state (Windows only; the packaged exe adds it itself).
  if (process.platform === "win32") {
    const userPath = opts.userPath ?? userPathFromRegistry();
    const onPath = pathContains(userPath, riaBinDir());
    rows.push({
      label: "PATH",
      status: onPath ? "ok" : "warn",
      detail: onPath
        ? `${riaBinDir()} is registered`
        : `${riaBinDir()} is not on the user PATH — "ria" may not launch from a fresh terminal`,
    });
  }

  const dirs = cfg.skillsDirs ?? [];
  const present = dirs.filter((d) => existsSync(d));
  rows.push({
    label: "skills",
    status: present.length ? "ok" : "warn",
    detail: present.length ? `${present.length}/${dirs.length} directories exist` : "no skills directories found",
  });

  // Keyed providers that still have an empty model list.
  const empty = entries.filter(([n, p]) => !isKeyless(n, p) && Boolean(apiKeySource(n, p).key) && Object.keys(p.models).length === 0);
  if (empty.length) {
    rows.push({ label: "models", status: "warn", detail: `no model list yet: ${empty.map(([n]) => n).join(", ")} — run: Ria models <name>` });
  }
  // Model lists that are getting old (timestamp joins the key check above).
  const stale = entries.filter(([n, p]) => !isKeyless(n, p) && Boolean(apiKeySource(n, p).key) && p.modelsFetchedAt && !isFresh(p.modelsFetchedAt, new Date()));
  if (stale.length) {
    rows.push({
      label: "model lists",
      status: "warn",
      detail: `last fetched over a day ago: ${stale.map(([n, p]) => `${n} (${describeFetchedAt(p.modelsFetchedAt)})`).join(", ")} — run: Ria models <name>`,
    });
  }

  return { rows, ok: !rows.some((r) => r.status === "fail") };
}

/** Render a doctor report as console text (shared by `ria doctor` and /doctor). */
export function renderDoctorReport(cfg: Config, opts: DoctorOptions): { text: string; ok: boolean } {
  const { rows, ok } = runDoctor(cfg, opts);
  const glyph = { ok: palette.ok("✓"), warn: palette.warn("▲"), fail: palette.err("✗"), info: palette.faint("·") } as const;
  const lines = rows.map((r) => `  ${glyph[r.status]} ${palette.text(r.label.padEnd(17))} ${r.detail}`);
  lines.push(ok ? palette.ok("\n  all clear") : palette.warn("\n  fix the ▲/✗ rows above"));
  return { text: lines.join("\n"), ok };
}
