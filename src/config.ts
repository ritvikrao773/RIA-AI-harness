import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface ModelInfo {
  context?: number;
  output?: number;
}

export interface Provider {
  name: string;
  baseURL: string;
  apiKey?: string;
  models: Record<string, ModelInfo>;
  /**
   * Name of the env var to read the key from when `apiKey` is empty.
   * Defaults to `<NAME>_API_KEY` (e.g. DEEPSEEK_API_KEY).
   */
  apiKeyEnv?: string;
  /**
   * Shell command whose stdout is the API key (an "apiKeyHelper").
   * Used when no key is set in config or the environment; output is
   * cached for RIA_API_KEY_COMMAND_TTL_MS (default 5 minutes).
   * Only ever read from the user's own ~/.ria/config.json — never shipped.
   */
  apiKeyCommand?: string;
  /**
   * Short names for models: `/model fast` resolves through
   * `aliases.fast` to the real model id on this provider.
   */
  aliases?: Record<string, string>;
  /** ISO time the model list was last fetched from the API (absent = never). */
  modelsFetchedAt?: string;
  /** Informational only (e.g. "oauth"); never sent as a bearer token. */
  authMode?: "apiKey" | "oauth" | "none";
  /** True for user-added providers (kept when defaults are re-seeded). */
  custom?: boolean;
}

export interface Config {
  defaultProvider: string;
  defaultModel: string;
  providers: Record<string, Provider>;
  skillsDirs: string[];
  maxOutputTokens?: number;
  /** Ask which provider/model to use on start until a key is configured. */
  onboarded?: boolean;
}

/**
 * Root directory Ria keeps everything in — `~/.ria` by default, or the
 * `RIA_HOME` env var when set (portable installs). Evaluated lazily so the
 * env var can be set at runtime (tests, portable launchers).
 */
export function riaHome(): string {
  const env = process.env.RIA_HOME?.trim();
  return env ? env : join(homedir(), ".ria");
}

/** Config file location — follows riaHome() (and thus RIA_HOME). */
export function configPath(): string {
  return join(riaHome(), "config.json");
}

const M = (context: number, output = 32_768): ModelInfo => ({ context, output });

/**
 * Built-in providers. Every entry is a plain OpenAI-compatible endpoint, so
 * users only need to paste their own key — no key ships with Ria. `apiKey`
 * is intentionally empty; keys come from ~/.ria/config.json (written by
 * `/provider setup` or `Ria provider add`) or from `<NAME>_API_KEY` env vars.
 */
export const BUILTIN_PROVIDERS: Record<string, Provider> = {
  deepseek: {
    name: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    authMode: "apiKey",
    aliases: { fast: "deepseek-chat", reasoner: "deepseek-reasoner", flagship: "deepseek-reasoner" },
    models: {
      "deepseek-chat": M(131_072, 8_192),
      "deepseek-reasoner": M(131_072, 65_536),
    },
  },
  qwen: {
    name: "Qwen (DashScope)",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    authMode: "apiKey",
    aliases: { fast: "qwen3-coder-flash", coder: "qwen3-coder-plus", flagship: "qwen3-coder-plus" },
    models: {
      "qwen3-coder-plus": M(1_000_000, 32_768),
      "qwen3-coder-flash": M(1_000_000, 32_768),
      "qwen-plus": M(1_000_000, 32_768),
    },
  },
  glm: {
    name: "GLM (Z.ai)",
    baseURL: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    authMode: "apiKey",
    aliases: { fast: "glm-4.5-air", flagship: "glm-4.6" },
    models: {
      "glm-4.6": M(204_800, 131_072),
      "glm-4.5-air": M(131_072, 98_304),
    },
  },
  openai: {
    name: "OpenAI (GPT)",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    authMode: "apiKey",
    aliases: { fast: "gpt-5-mini", flagship: "gpt-5" },
    models: {
      "gpt-5": M(400_000, 128_000),
      "gpt-5-mini": M(400_000, 128_000),
    },
  },
  anthropic: {
    name: "Anthropic (Claude)",
    baseURL: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    // Claude's native API is not OpenAI-shaped; it works through its
    // OpenAI-compatible layer, or point this at any compatible gateway.
    authMode: "apiKey",
    aliases: { fast: "claude-haiku-4-5", coder: "claude-sonnet-4-5", flagship: "claude-opus-4-1" },
    models: {
      "claude-sonnet-4-5": M(200_000, 64_000),
      "claude-opus-4-1": M(200_000, 32_000),
      "claude-haiku-4-5": M(200_000, 64_000),
    },
  },
  gemini: {
    name: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    authMode: "apiKey",
    aliases: { fast: "gemini-2.5-flash", flagship: "gemini-2.5-pro" },
    models: {
      "gemini-2.5-pro": M(1_048_576, 65_536),
      "gemini-2.5-flash": M(1_048_576, 65_536),
    },
  },
  groq: {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  openrouter: {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  // The providers below mirror the registry observed in the omp agent
  // (byte-level scan, omp.exe 18.18.8): same hosts, same env-var names
  // where omp documents them. `apiKeyEnv` is omitted where no env name
  // was observed — the key then auto-derives to <NAME>_API_KEY, and
  // users can always set a custom name in ~/.ria/config.json.
  xai: {
    name: "xAI (Grok)",
    baseURL: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  moonshot: {
    name: "Moonshot (Kimi)",
    baseURL: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  minimax: {
    name: "MiniMax",
    baseURL: "https://api.minimax.io/v1",
    apiKeyEnv: "MINIMAX_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  cerebras: {
    name: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  mistral: {
    name: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    authMode: "apiKey",
    models: {},
  },
  together: {
    name: "Together AI",
    baseURL: "https://api.together.xyz/v1",
    authMode: "apiKey",
    models: {},
  },
  fireworks: {
    name: "Fireworks AI",
    baseURL: "https://api.fireworks.ai/inference/v1",
    authMode: "apiKey",
    models: {},
  },
  siliconflow: {
    name: "SiliconFlow",
    baseURL: "https://api.siliconflow.com/v1",
    authMode: "apiKey",
    models: {},
  },
  ollama: {
    name: "Ollama (local)",
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    authMode: "apiKey",
    models: { "qwen3-coder:30b": M(262_144, 16_384) },
  },
};

/** Provider selected on a fresh install. */
export const FIRST_PROVIDER = "deepseek";

function cloneProviders(src: Record<string, Provider>): Record<string, Provider> {
  return JSON.parse(JSON.stringify(src)) as Record<string, Provider>;
}

/** Deep-merge built-ins with stored providers so new built-ins appear on upgrade. */
function mergeProviders(stored: Record<string, Provider> | undefined): Record<string, Provider> {
  const out = cloneProviders(BUILTIN_PROVIDERS);
  for (const [name, p] of Object.entries(stored ?? {})) {
    if (!p || typeof p !== "object") continue;
    const base = out[name] ?? { name, baseURL: "", models: {} };
    out[name] = {
      ...base,
      ...p,
      models: { ...(base.models ?? {}), ...(p.models ?? {}) },
    };
  }
  return out;
}

function defaultConfig(): Config {
  return {
    defaultProvider: FIRST_PROVIDER,
    defaultModel: "deepseek-chat",
    providers: cloneProviders(BUILTIN_PROVIDERS),
    skillsDirs: [
      join(homedir(), ".config", "opencode", "skills"),
      join(homedir(), ".claude", "skills"),
    ],
  };
}

export function loadConfig(): Config {
  const path = configPath();
  if (existsSync(path)) {
    try {
      const user = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
      const def = defaultConfig();
      return {
        ...def,
        ...user,
        providers: mergeProviders(user.providers),
        skillsDirs: user.skillsDirs?.length ? user.skillsDirs : def.skillsDirs,
      };
    } catch {
      console.error(`Warning: ${path} is invalid JSON, using defaults.`);
    }
  }
  const def = defaultConfig();
  saveConfig(def);
  return def;
}

export function saveConfig(cfg: Config): void {
  const dir = riaHome();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Env var a provider's key is read from: explicit `apiKeyEnv`, else `<NAME>_API_KEY`. */
export function apiKeyEnvName(pname: string, provider?: Provider): string {
  if (provider?.apiKeyEnv) return provider.apiKeyEnv;
  return `${pname.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/**
 * TTL (ms) for cached `apiKeyCommand` output. Mirrors Claude Code's
 * `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` pattern: a helper command may rotate
 * keys, so results are cached only briefly. Set RIA_API_KEY_COMMAND_TTL_MS
 * to override; 0 disables caching entirely.
 */
export function apiKeyCommandTtlMs(): number {
  const v = Number(process.env.RIA_API_KEY_COMMAND_TTL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 300_000;
}

const keyCommandCache = new Map<string, { value: string; expires: number }>();

function runApiKeyCommand(command: string): string {
  const now = Date.now();
  const hit = keyCommandCache.get(command);
  if (hit && hit.expires > now) return hit.value;
  let value = "";
  try {
    value = execFileSync(command, {
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      windowsHide: true,
    }).trim();
  } catch {
    value = ""; // helper failed — treat as "no key from command"
  }
  const ttl = apiKeyCommandTtlMs();
  if (ttl > 0) keyCommandCache.set(command, { value, expires: now + ttl });
  return value;
}

/** Where the key came from, for `/provider` status. */
export function apiKeySource(pname: string, provider: Provider): { key: string; from: "config" | "env" | "command" | null; envVar: string } {
  const envVar = apiKeyEnvName(pname, provider);
  const env = process.env[envVar];
  if (env) return { key: env, from: "env", envVar };
  if (provider.apiKey) return { key: provider.apiKey, from: "config", envVar };
  if (provider.apiKeyCommand) {
    const key = runApiKeyCommand(provider.apiKeyCommand);
    if (key) return { key, from: "command", envVar };
  }
  return { key: "", from: null, envVar };
}

export function providerKey(pname: string, provider: Provider): string {
  return apiKeySource(pname, provider).key;
}

/**
 * True when the provider needs no key at all (local inference, or authMode
 * "none"). A provider with a key is never keyless — even at localhost, where
 * gateways such as llama.cpp/Ollama often do require a token.
 */
export function isKeyless(pname: string, provider: Provider): boolean {
  if (provider.authMode === "none") return true;
  if (provider.apiKey || provider.apiKeyCommand) return false;
  if (process.env[apiKeyEnvName(pname, provider)]) return false;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(provider.baseURL);
}

export function hasKey(pname: string, provider: Provider): boolean {
  return isKeyless(pname, provider) || Boolean(providerKey(pname, provider));
}

/** Mask a key for display: sk-abcd…wxyz */
export function maskKey(key: string): string {
  if (!key) return "(none)";
  if (key.length <= 10) return key.slice(0, 2) + "…";
  return key.slice(0, 6) + "…" + key.slice(-4);
}

export function resolveModel(cfg: Config, providerName?: string, modelName?: string) {
  const pname = providerName || cfg.defaultProvider;
  const provider = cfg.providers[pname];
  if (!provider) throw new Error(`Unknown provider "${pname}". Known: ${Object.keys(cfg.providers).join(", ")}`);
  // Resolve short alias names (`/model fast`) to the real model id.
  const requested = modelName ? (provider.aliases?.[modelName] ?? modelName) : undefined;
  // Keep the requested model when the provider has it; otherwise fall back to
  // the provider's first model (but never invent one when it has none).
  const fallback = Object.keys(provider.models)[0] ?? "";
  const mkey = requested && provider.models[requested] ? requested : fallback || requested || "";
  const model = provider.models[mkey] ?? {};
  const apiKey = providerKey(pname, provider);
  if (!apiKey && !isKeyless(pname, provider)) {
    throw new Error(
      `No API key for provider "${pname}". Run: Ria provider setup ${pname}  (or set ${apiKeyEnvName(pname, provider)}).`,
    );
  }
  // Testing/override hook: force a smaller window to exercise compaction.
  const override = Number(process.env.RIA_CONTEXT_OVERRIDE || 0);
  const effective = override > 0 ? { ...model, context: override } : model;
  return { provider, providerName: pname, modelKey: mkey, model: effective, apiKey: apiKey || "local" };
}

/** Add a custom OpenAI-compatible provider (the "custom API" option). */
export function addProvider(cfg: Config, name: string, baseURL: string, apiKey?: string, models?: string[]): Provider {
  const p: Provider = {
    name: name,
    baseURL: baseURL.replace(/\/+$/, ""),
    apiKey,
    custom: true,
    authMode: "apiKey",
    models: {},
  };
  for (const m of models && models.length ? models : ["default"]) p.models[m] = {};
  cfg.providers[name] = p;
  saveConfig(cfg);
  return p;
}

/** Register a model under an existing provider. */
export function addModel(cfg: Config, providerName: string, modelId: string, info: ModelInfo = {}): Provider {
  const p = cfg.providers[providerName];
  if (!p) throw new Error(`Unknown provider "${providerName}". Known: ${Object.keys(cfg.providers).join(", ")}`);
  p.models[modelId] = { ...(p.models[modelId] ?? {}), ...info };
  saveConfig(cfg);
  return p;
}

/** Store (or clear) a key for a provider without touching anything else. */
export function setProviderKey(cfg: Config, providerName: string, apiKey: string): Provider {
  const p = cfg.providers[providerName];
  if (!p) throw new Error(`Unknown provider "${providerName}". Known: ${Object.keys(cfg.providers).join(", ")}`);
  p.apiKey = apiKey.trim() || undefined;
  saveConfig(cfg);
  return p;
}

/** Query an OpenAI-compatible endpoint's /models list. */
export async function fetchProviderModels(p: Provider, apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  const key = apiKey ?? p.apiKey;
  if (key && p.authMode !== "none") headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${p.baseURL.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${p.baseURL}/models`);
  const j = await res.json() as unknown;
  // OpenAI: {data:[{id}]} · bare array [{id,name}] · {models:[...]}
  const raw = Array.isArray(j)
    ? j as Array<{ id?: string; name?: string }>
    : ((j as { data?: Array<{ id?: string; name?: string }>; models?: Array<{ id?: string; name?: string }> }).data ??
       (j as { models?: Array<{ id?: string; name?: string }> }).models ?? []);
  return raw.map((m) => m.id ?? m.name ?? "").filter(Boolean);
}

/**
 * Merge a fetched model list into a provider and stamp when it happened.
 * Returns the number of *newly* discovered models. Every caller goes through
 * here so `modelsFetchedAt` is never missed.
 */
export function mergeProviderModels(p: Provider, ids: readonly string[], now: Date = new Date()): number {
  let added = 0;
  for (const id of ids) {
    if (!id || p.models[id]) continue;
    p.models[id] = {};
    added++;
  }
  p.modelsFetchedAt = now.toISOString();
  return added;
}

/** True when a model list was fetched within `maxAgeMs` (default 24h). */export function isFresh(iso: string | undefined, now: Date = new Date(), maxAgeMs = 24 * 60 * 60 * 1000): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t <= maxAgeMs;
}

/** "3m ago" / "2d ago" for a stored ISO timestamp; "" when never fetched. */
export function describeFetchedAt(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export interface RefreshResult {
  name: string;
  ok: boolean;
  /** Models discovered by this refresh. */
  added: number;
  /** Total models known afterwards. */
  total: number;
  /** Why it failed, when ok is false. */
  error?: string;
}

/**
 * Refresh model lists for every keyed provider (optionally only those whose
 * list is missing or older than `maxAgeMs`). Failures are per provider and
 * never abort the sweep — one dead endpoint must not block the rest.
 * Calls `save` after each success so a long sweep survives a Ctrl+C.
 */
export async function refreshAllModels(
  cfg: Config,
  opts: {
    keyOf: (name: string, p: Provider) => string;
    fetchList?: (p: Provider, key?: string) => Promise<string[]>;
    onlyStale?: boolean;
    maxAgeMs?: number;
    now?: Date;
    save?: (cfg: Config) => void;
    onResult?: (r: RefreshResult) => void;
  },
): Promise<RefreshResult[]> {
  const fetchList = opts.fetchList ?? fetchProviderModels;
  const save = opts.save ?? saveConfig;
  const now = opts.now ?? new Date();
  const results: RefreshResult[] = [];
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (isKeyless(name, p)) continue;
    const key = opts.keyOf(name, p);
    if (!key) continue;
    if (opts.onlyStale && p.modelsFetchedAt && isFresh(p.modelsFetchedAt, now, opts.maxAgeMs)) continue;
    let r: RefreshResult;
    try {
      const ids = await fetchList(p, key);
      const added = mergeProviderModels(p, ids, now);
      save(cfg);
      r = { name, ok: true, added, total: Object.keys(p.models).length };
    } catch (e) {
      r = { name, ok: false, added: 0, total: Object.keys(p.models).length, error: (e as Error).message };
    }
    results.push(r);
    opts.onResult?.(r);
  }
  return results;
}

/** One cheap non-streaming call to prove a key + base URL work. */
export async function verifyProvider(p: Provider, apiKey: string, model?: string): Promise<void> {
  const m = model || Object.keys(p.models)[0];
  if (!m) return; // nothing to call; /models check is enough
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${p.baseURL.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: m, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
}

export function listProviders(cfg: Config): Array<[string, Provider]> {
  return Object.entries(cfg.providers);
}
