/** First-run / missing-key wizard: pick a provider, paste a key. */
import process from "node:process";
import {
  addProvider,
  apiKeyEnvName,
  configPath,
  fetchProviderModels,
  mergeProviderModels,
  hasKey,
  listProviders,
  saveConfig,
  setProviderKey,
  verifyProvider,
  type Config,
  type Provider,
} from "./config.js";
import { decodeKeys } from "./ui/keys.ts";
import { Picker, type PickerItem } from "./ui/picker.ts";
import { promptLine, type PromptHost } from "./ui/prompt.ts";
import { palette } from "./ui/theme.ts";

const defaultHost: PromptHost = {
  cols: () => process.stdout.columns || 80,
  write: (s: string) => process.stdout.write(s),
};

/** Use the first model the provider actually advertises. */
export function preferredModel(ids: string[]): string | undefined {
  return ids.find((i) => /coder/i.test(i)) ?? ids.find((i) => /chat/i.test(i)) ?? ids[0];
}

/** Save a key and try to populate the live model list. Returns the model count. */
async function saveKeyAndModels(cfg: Config, name: string, prov: Provider, key: string): Promise<{ count: number; error?: string }> {
  setProviderKey(cfg, name, key);
  let count = 0;
  let error: string | undefined;
  try {
    const ids = await fetchProviderModels(prov, key);
    mergeProviderModels(prov, ids);
    count = ids.length;
    const pref = preferredModel(ids);
    if (pref) cfg.defaultModel = pref;
  } catch (e) {
    error = (e as Error).message;
  }
  saveConfig(cfg);
  return { count, error };
}

/**
 * Interactive setup. Runs when there is no usable provider yet (fresh install,
 * or the default provider lost its key). Never runs when stdin is not a TTY.
 */
export async function ensureReady(cfg: Config, host: PromptHost = defaultHost): Promise<void> {
  const pname = cfg.defaultProvider;
  const p = cfg.providers[pname];
  const ready = Boolean(p && hasKey(pname, p) && Object.keys(p.models).length > 0);
  if (ready && cfg.onboarded) return;

  if (!process.stdin.isTTY) {
    if (!ready) {
      const envVar = p ? apiKeyEnvName(pname, p) : "DEEPSEEK_API_KEY";
      console.error(palette.warn(`No API key for "${pname}". Run: Ria provider setup ${pname}  (or set ${envVar})`));
    }
    return;
  }

  const wasRaw = process.stdin.isRaw;
  if (!wasRaw) process.stdin.setRawMode(true);
  const restore = () => { if (!wasRaw) process.stdin.setRawMode(false); };

  host.write("\n");
  host.write("  " + palette.boldWhite("Welcome to Ria") + palette.faint("  — bring your own key; nothing is shared") + "\n");
  host.write("  " + palette.faint(`config: ${configPath()} (keys stay on this machine)`) + "\n");
  host.write("\n");

  const items: PickerItem[] = listProviders(cfg).map(([n, prov]) => ({
    value: n,
    label: n,
    desc: prov.name,
    note: hasKey(n, prov) ? palette.ok("key ✓") : undefined,
  }));
  items.push({ value: "__custom", label: "+ custom API", desc: "any OpenAI-compatible URL" });

  const picker = new Picker(
    { title: "choose your provider", items, footer: "↑↓ move · type to filter · Enter select · Ctrl+C quit" },
    host,
  );
  picker.draw();
  const choice = await new Promise<string | null>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const k of decodeKeys(text)) {
        if (picker.key(k) === "done") {
          process.stdin.removeListener("data", onData);
          resolve(picker.result);
          return;
        }
      }
      picker.draw();
    };
    process.stdin.on("data", onData);
  });

  if (!choice) {
    restore();
    host.write(palette.faint("\ncancelled — run `Ria provider setup` whenever you like") + "\n");
    process.exit(1);
  }

  if (choice === "__custom") {
    const name = (await promptLine(host, "provider name (e.g. myapi)")).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    const url = await promptLine(host, "base URL (OpenAI-compatible, ends in /v1)", { initial: "https://" });
    if (!name || !url || !/^https?:\/\//i.test(url)) {
      restore();
      host.write(palette.err("cancelled — a name and http(s) URL are required") + "\n");
      process.exit(1);
    }
    const prov = addProvider(cfg, name, url);
    const key = await promptLine(host, `${name} — paste your API key`, { secret: true });
    if (!key) {
      restore();
      host.write(palette.err("cancelled — no key entered") + "\n");
      process.exit(1);
    }
    const { count, error } = await saveKeyAndModels(cfg, name, prov, key);
    host.write(error
      ? palette.warn(`  saved, but /models failed (${error}) — add models with Ria model add ${name} <id>`) + "\n"
      : palette.ok(`  ${count} models available`) + "\n");
    cfg.defaultProvider = name;
    cfg.onboarded = true;
    if (!prov.models[cfg.defaultModel]) cfg.defaultModel = Object.keys(prov.models)[0] ?? cfg.defaultModel;
    saveConfig(cfg);
    restore();
    host.write(palette.ok(`  ready — ${name}/${cfg.defaultModel}`) + "\n\n");
    return;
  }

  const prov = cfg.providers[choice];
  if (!hasKey(choice, prov)) {
    const key = await promptLine(host, `${choice} (${prov.name}) — paste your API key`, { secret: true });
    if (!key) {
      restore();
      host.write(palette.warn(`cancelled — set it later with: Ria provider setup ${choice}`) + "\n");
      process.exit(1);
    }
    host.write("  verifying… ");
    // Models are fetched (and kept) even if the verify ping is unsupported.
    const { count } = await saveKeyAndModels(cfg, choice, prov, key);
    try {
      if (prov.authMode === "none") await fetchProviderModels(prov, key);
      else await verifyProvider(prov, key);
      host.write(palette.ok("ok") + "\n");
    } catch (e) {
      host.write(palette.warn(`could not verify (${(e as Error).message})`) + "\n");
      host.write(palette.faint(`  key saved — fix it later with /provider key ${choice}`) + "\n");
    }
    if (count) host.write(palette.faint(`  ${count} models available`) + "\n");
  }

  cfg.defaultProvider = choice;
  cfg.onboarded = true;
  if (!prov.models[cfg.defaultModel]) cfg.defaultModel = Object.keys(prov.models)[0] ?? cfg.defaultModel;
  saveConfig(cfg);
  restore();
  host.write(palette.ok(`  ready — ${choice}/${cfg.defaultModel}`) + "\n\n");
}
