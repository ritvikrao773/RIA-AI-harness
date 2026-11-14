/**
 * PATH self-install for the packaged ria.exe (Windows).
 *
 * When Ria runs as a Node Single Executable Application, it makes sure
 * `%USERPROFILE%\.ria\bin` is on the *user* PATH (HKCU\Environment), so
 * typing `ria` in any new cmd / PowerShell window launches the program.
 * The change is broadcast to running shells so new terminals pick it up
 * without a logoff.
 *
 * Safety rails:
 *  - only runs when actually packaged (node:sea.isSea() — never in dev or
 *    tests, which run plain `node dist/cli.cjs`);
 *  - RIA_NO_PATH=1 disables it;
 *  - PATH is rewritten through `reg add` (never `setx`, which truncates
 *    values longer than 1024 chars).
 */
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isSea } from "node:sea";
import process from "node:process";
import { riaHome } from "./config.js";

/** Directory the packaged exe lives in (and the one PATH should contain). */
export function riaBinDir(): string {
  // Follows RIA_HOME so a portable install registers its own bin folder.
  return join(riaHome(), "bin");
}

function normalize(p: string): string {
  return p.trim().toLowerCase().replace(/[\\/]+$/, "");
}

/** The current user PATH from the registry, or "" when the value doesn't exist. */
export function userPathFromRegistry(): string {
  try {
    const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/** True when `dir` is already an entry of a PATH string. */
export function pathContains(pathValue: string, dir: string): boolean {
  return pathValue.split(";").some((e) => normalize(e) === normalize(dir));
}

/** Tell open Explorer/shells that the environment changed (WM_SETTINGCHANGE). */
function broadcastEnvironment(): void {
  try {
    const ps = [
      "$sig='[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'",
      "$t=Add-Type -MemberDefinition $sig -Name W -Namespace W32 -PassThru",
      "$r=[UIntPtr]::Zero",
      "$null=$t::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
    ].join("; ");
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps], {
      windowsHide: true,
      timeout: 10_000,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    // broadcast is best-effort; worst case the user opens a new terminal later
  }
}

/**
 * Ensure the install dir is on the user PATH.
 * Returns "added" | "present" | "skipped" | "failed".
 */
export function ensureRiaOnPath(): "added" | "present" | "skipped" | "failed" {
  if (process.platform !== "win32") return "skipped";
  if (process.env.RIA_NO_PATH) return "skipped";
  // Only the packaged exe may touch the registry — never dev/test runs,
  // which would otherwise write a temp HOME into the real user PATH.
  if (!isSea()) return "skipped";
  // And only when the standard install dir really holds ria.exe (a portable
  // copy run from a flash drive must not register a bogus entry).
  if (!existsSync(join(riaBinDir(), "ria.exe"))) return "skipped";

  const binDir = riaBinDir();
  try {
    const current = userPathFromRegistry();
    if (pathContains(current, binDir)) return "present";
    const next = current ? `${current};${binDir}` : binDir;
    execFileSync(
      "reg",
      ["add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", next, "/f"],
      { windowsHide: true, timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    broadcastEnvironment();
    return "added";
  } catch {
    return "failed";
  }
}
