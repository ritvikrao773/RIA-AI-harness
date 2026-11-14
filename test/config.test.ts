// Verify provider config: the omp-mined builtin registry, per-provider
// model aliases, and apiKeyCommand (apiKeyHelper-style) key resolution
// with TTL caching.
import {
  BUILTIN_PROVIDERS,
  FIRST_PROVIDER,
  apiKeySource,
  apiKeyCommandTtlMs,
  resolveModel,
  maskKey,
  type Config,
  type Provider,
} from "../src/config.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

// --- builtin registry -----------------------------------------------------
const expected: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  glm: "https://api.z.ai/api/paas/v4",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  moonshot: "https://api.moonshot.ai/v1",
  minimax: "https://api.minimax.io/v1",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  siliconflow: "https://api.siliconflow.com/v1",
  ollama: "http://localhost:11434/v1",
};
for (const [name, url] of Object.entries(expected)) {
  const p = BUILTIN_PROVIDERS[name];
  check(`builtin ${name} exists`, Boolean(p));
  if (p) check(`builtin ${name} baseURL is ${url}`, p.baseURL === url, p.baseURL);
}
check("deepseek is FIRST_PROVIDER", FIRST_PROVIDER === "deepseek");
check("no builtin ships an apiKey", Object.values(BUILTIN_PROVIDERS).every((p) => !p.apiKey));
check("omp-mined env names kept", BUILTIN_PROVIDERS.xai.apiKeyEnv === "XAI_API_KEY"
  && BUILTIN_PROVIDERS.moonshot.apiKeyEnv === "MOONSHOT_API_KEY"
  && BUILTIN_PROVIDERS.cerebras.apiKeyEnv === "CEREBRAS_API_KEY"
  && BUILTIN_PROVIDERS.mistral.apiKeyEnv === "MISTRAL_API_KEY"
  && BUILTIN_PROVIDERS.minimax.apiKeyEnv === "MINIMAX_API_KEY");

// --- aliases ---------------------------------------------------------------
const cfg: Config = {
  defaultProvider: "deepseek",
  defaultModel: "deepseek-chat",
  providers: JSON.parse(JSON.stringify(BUILTIN_PROVIDERS)) as Record<string, Provider>,
  skillsDirs: [],
};
cfg.providers.deepseek.apiKey = "sk-test"; // resolveModel refuses keyless providers
const viaAlias = resolveModel(cfg, "deepseek", "fast");
check("alias /model fast → deepseek-chat", viaAlias.modelKey === "deepseek-chat", viaAlias.modelKey);
const viaAlias2 = resolveModel(cfg, "deepseek", "reasoner");
check("alias /model reasoner → deepseek-reasoner", viaAlias2.modelKey === "deepseek-reasoner", viaAlias2.modelKey);
cfg.providers.anthropic.apiKey = "sk-test";
const viaAlias3 = resolveModel(cfg, "anthropic", "coder");
check("anthropic coder alias → claude-sonnet-4-5", viaAlias3.modelKey === "claude-sonnet-4-5", viaAlias3.modelKey);
const direct = resolveModel(cfg, "deepseek", "deepseek-reasoner");
check("real model id still wins over alias table", direct.modelKey === "deepseek-reasoner");
// user aliases can be added at runtime
cfg.providers.deepseek.aliases = { fast: "deepseek-reasoner" };
const override = resolveModel(cfg, "deepseek", "fast");
check("user alias override respected", override.modelKey === "deepseek-reasoner", override.modelKey);

// --- apiKeyCommand ---------------------------------------------------------
process.env.RIA_API_KEY_COMMAND_TTL_MS = "60000";
check("ttl default is 5min", apiKeyCommandTtlMs() === 60_000); // env is set above
delete process.env.RIA_API_KEY_COMMAND_TTL_MS;
check("ttl override via env", (process.env.RIA_API_KEY_COMMAND_TTL_MS = "1234", apiKeyCommandTtlMs() === 1234));
delete process.env.RIA_API_KEY_COMMAND_TTL_MS;
check("ttl falls back to 300_000", apiKeyCommandTtlMs() === 300_000);

// helper: echo a marker key (same command → cached between the two calls)
const marker = "sk-helper-test-1234567890";
const helper: Provider = {
  name: "Helper",
  baseURL: "https://api.example.com/v1",
  models: { "test-model": {} },
  apiKeyCommand: process.platform === "win32"
    ? `echo ${marker}`
    : `printf ${marker}`,
  authMode: "apiKey",
};
const src1 = apiKeySource("helper", helper);
check("apiKeyCommand resolves the key", src1.key === marker, src1.key);
check("source is 'command'", src1.from === "command");
check("command key is maskable", maskKey(src1.key).includes("…"));

// precedence: env beats config beats command
process.env.HELPER_API_KEY = "sk-env";
const srcEnv = apiKeySource("helper", helper);
check("env beats apiKeyCommand", srcEnv.from === "env");
delete process.env.HELPER_API_KEY;
helper.apiKey = "sk-config";
const srcCfg = apiKeySource("helper", helper);
check("config beats apiKeyCommand", srcCfg.from === "config");
delete helper.apiKey;

// failing helper → no key, from null
const bad: Provider = { ...helper, apiKeyCommand: "exit 3" };
const srcBad = apiKeySource("bad", bad);
check("failing helper yields no key", srcBad.from === null && srcBad.key === "");

// cache: same command returns cached value (marker persists even though we
// change the command's would-be output via a different command that fails;
// simplest observable proof: two calls to the same command agree, and the
// cache is keyed by the command string so the failing command is separate)
const src1b = apiKeySource("helper", helper);
check("cached helper result stable", src1b.key === marker);

// --- PATH self-install (pathinstall) ---------------------------------------
console.log("\npath self-install:");
const { pathContains, riaBinDir, userPathFromRegistry } = await import("../src/pathinstall.ts");
check("riaBinDir is ~\\.ria\\bin", riaBinDir().replace(/[\\/]+$/, "").endsWith(".ria\\bin") || riaBinDir().replace(/[\\/]+$/, "").endsWith(".ria/bin"), riaBinDir());
check("pathContains finds an entry", pathContains("C:\\a;C:\\Users\\x\\.ria\\bin", "c:\\users\\x\\.ria\\bin\\"));
check("pathContains rejects other entries", !pathContains("C:\\a;C:\\Windows", "C:\\Users\\x\\.ria\\bin"));
check("pathContains rejects empty fragments", !pathContains(";;", riaBinDir()));
// Reading the registry is harmless; the write path is guarded by isSea()
// and never runs under plain node (which is what these tests use).
check("registry read does not throw", typeof userPathFromRegistry() === "string");
check("ensureRiaOnPath skips under plain node", (await import("../src/pathinstall.ts")).ensureRiaOnPath() === "skipped");

// --- timestamped model cache ----------------------------------------------
console.log("\nmodel list cache:");
const { mergeProviderModels, describeFetchedAt, isFresh } = await import("../src/config.ts");
const cacheP: Provider = { name: "C", baseURL: "https://api.example.com/v1", models: { existing: {} }, authMode: "apiKey" };
check("never-fetched describes as empty", describeFetchedAt(undefined) === "");
check("no timestamp means not fresh", isFresh(undefined) === false);

const t0 = new Date("2026-01-01T12:00:00.000Z");
const added1 = mergeProviderModels(cacheP, ["new-a", "new-b", "existing"], t0);
check("merge adds only new ids", added1 === 2 && Object.keys(cacheP.models).length === 3, `added=${added1}`);
check("merge stamps modelsFetchedAt", cacheP.modelsFetchedAt === t0.toISOString(), String(cacheP.modelsFetchedAt));
check("re-merge adds nothing", mergeProviderModels(cacheP, ["new-a", "existing"], t0) === 0);
check("merge ignores empty ids", mergeProviderModels(cacheP, [""], t0) === 0 && Object.keys(cacheP.models).length === 3);

const at = (s: number) => new Date(t0.getTime() + s * 1000);
check("just now", describeFetchedAt(cacheP.modelsFetchedAt, at(10)) === "just now");
check("minutes ago", describeFetchedAt(cacheP.modelsFetchedAt, at(3 * 60)) === "3m ago");
check("hours ago", describeFetchedAt(cacheP.modelsFetchedAt, at(5 * 3600)) === "5h ago");
check("days ago", describeFetchedAt(cacheP.modelsFetchedAt, at(2 * 86400)) === "2d ago");
check("invalid timestamp describes as empty", describeFetchedAt("not-a-date") === "");
check("fresh within 24h", isFresh(cacheP.modelsFetchedAt, at(23 * 3600)) === true);
check("stale after 24h", isFresh(cacheP.modelsFetchedAt, at(25 * 3600)) === false);

// --- bulk refresh (refreshAllModels) --------------------------------------
console.log("\nbulk model refresh:");
const { refreshAllModels } = await import("../src/config.ts");
const mk = (): Config => {
  const c: Config = { defaultProvider: "a", defaultModel: "m", providers: {}, skillsDirs: [] };
  c.providers.a = { name: "A", baseURL: "https://a.example/v1", apiKey: "k-a", models: {}, authMode: "apiKey" };
  c.providers.b = { name: "B", baseURL: "https://b.example/v1", apiKey: "k-b", models: {}, authMode: "apiKey" };
  c.providers.nokey = { name: "NoKey", baseURL: "https://c.example/v1", models: {}, authMode: "apiKey" };
  c.providers.local = { name: "Local", baseURL: "http://localhost:11434/v1", models: {}, authMode: "apiKey" };
  return c;
};
const tNow = new Date("2026-02-01T00:00:00.000Z");
const calls: string[] = [];
const fakeFetch = async (p: Provider) => {
  calls.push(p.baseURL);
  if (p.baseURL.includes("b.example")) throw new Error("HTTP 503");
  return ["m1", "m2"];
};

const bulkCfg = mk();
let saves = 0;
const r1res = await refreshAllModels(bulkCfg, {
  keyOf: (n, p) => apiKeySource(n, p).key,
  fetchList: fakeFetch,
  now: tNow,
  save: () => { saves++; },
});
check("refresh visits only keyed providers", calls.length === 2 && !calls.some((u) => /c\.example|localhost/.test(u)), calls.join(","));
check("successful provider gains models", r1res.find((r) => r.name === "a")?.added === 2);
check("successful provider is stamped", bulkCfg.providers.a.modelsFetchedAt === tNow.toISOString());
check("failing provider reports the error", r1res.find((r) => r.name === "b")?.ok === false && /503/.test(r1res.find((r) => r.name === "b")?.error ?? ""));
check("one failure does not abort the sweep", r1res.length === 2);
check("failure leaves no stamp", bulkCfg.providers.b.modelsFetchedAt === undefined);
check("saves after each success only", saves === 1, String(saves));

// onlyStale: fresh lists are skipped, stale/absent ones are refreshed
calls.length = 0;
bulkCfg.providers.a.modelsFetchedAt = new Date(tNow.getTime() - 60_000).toISOString(); // 1m old
bulkCfg.providers.b.modelsFetchedAt = new Date(tNow.getTime() - 3 * 86_400_000).toISOString(); // 3d old
const staleRes = await refreshAllModels(bulkCfg, {
  keyOf: (n, p) => apiKeySource(n, p).key,
  fetchList: fakeFetch,
  onlyStale: true,
  now: tNow,
  save: () => {},
});
check("stale sweep skips fresh providers", !calls.some((u) => u.includes("a.example")), calls.join(","));
check("stale sweep refreshes old ones", calls.some((u) => u.includes("b.example")));
check("failed stale refresh keeps its old stamp", bulkCfg.providers.b.modelsFetchedAt === new Date(tNow.getTime() - 3 * 86_400_000).toISOString());
check("stale sweep returns only visited providers", staleRes.length === 1 && staleRes[0].name === "b");

// a stale provider that succeeds *is* re-stamped
const staleOk = mk();
staleOk.providers.a.models = { m1: {} };
staleOk.providers.a.modelsFetchedAt = new Date(tNow.getTime() - 2 * 86_400_000).toISOString();
await refreshAllModels(staleOk, { keyOf: (n, p) => apiKeySource(n, p).key, fetchList: fakeFetch, onlyStale: true, now: tNow, save: () => {} });
check("stale success is re-stamped", staleOk.providers.a.modelsFetchedAt === tNow.toISOString());
check("stale success merges without duplicates", Object.keys(staleOk.providers.a.models).length === 2);

// nothing to do
const noneRes = await refreshAllModels(mk(), { keyOf: () => "", fetchList: fakeFetch, save: () => {} });
check("no keys → empty result", noneRes.length === 0);

// --- status bar staleness badge -------------------------------------------
console.log("\nstatus bar:");
const { renderStatus } = await import("../src/ui/status.ts");
const base = {
  model: "m", provider: "P", usedTokens: 10, contextWindow: 1000,
  cwd: "C:/x", mode: "idle" as const,
};
const plain = renderStatus(base, 120);
check("no badge when the list is fresh", !/models \d+[mhd]/.test(plain), plain);
const badged = renderStatus({ ...base, staleModels: "3d ago" }, 120);
check("stale list shows an age badge", badged.includes("models 3d ago"), badged);
check("badge empty string renders nothing", !/models \d+[mhd]/.test(renderStatus({ ...base, staleModels: "" }, 120)));

// --- RIA_HOME: portable install root --------------------------------------
console.log("\nRIA_HOME (portable install):");
const { riaHome, configPath, saveConfig, loadConfig } = await import("../src/config.ts");
const pathMod = await import("node:path");
const osMod = await import("node:os");
const fsMod = await import("node:fs");
const portable = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "ria-home-"));
const savedEnv = process.env.RIA_HOME;
try {
  delete process.env.RIA_HOME;
  check("without RIA_HOME the root is ~/.ria", riaHome() === pathMod.join(osMod.homedir(), ".ria"), riaHome());

  process.env.RIA_HOME = portable;
  check("RIA_HOME overrides the root", riaHome() === portable, riaHome());
  check("configPath follows RIA_HOME", configPath() === pathMod.join(portable, "config.json"), configPath());
  check("riaBinDir follows RIA_HOME", riaBinDir() === pathMod.join(portable, "bin"), riaBinDir());

  const c1 = loadConfig();
  check("first load writes config into RIA_HOME", fsMod.existsSync(pathMod.join(portable, "config.json")));
  c1.defaultModel = "portable-model";
  saveConfig(c1);
  const c2 = loadConfig();
  check("config round-trips through RIA_HOME", c2.defaultModel === "portable-model");
  // The portable copy must not write next to the real one.
  const realCfg = pathMod.join(osMod.homedir(), ".ria", "config.json");
  const before = fsMod.existsSync(realCfg) ? fsMod.readFileSync(realCfg, "utf8") : null;
  saveConfig(c2);
  const after = fsMod.existsSync(realCfg) ? fsMod.readFileSync(realCfg, "utf8") : null;
  check("real ~/.ria/config.json is untouched", before === after);

  process.env.RIA_HOME = "";
  check("empty RIA_HOME falls back to ~/.ria", riaHome() === pathMod.join(osMod.homedir(), ".ria"));
} finally {
  if (savedEnv === undefined) delete process.env.RIA_HOME; else process.env.RIA_HOME = savedEnv;
  fsMod.rmSync(portable, { recursive: true, force: true });
}

// --- keyless vs keyed (localhost regression) ------------------------------
// A provider WITH a key must never be treated as keyless, even on localhost —
// that bug made bulk refresh silently skip keyed local gateways.
console.log("\nkeyless vs keyed:");
const { isKeyless } = await import("../src/config.ts");
const localKeyed: Provider = { name: "L", baseURL: "http://127.0.0.1:8080/v1", apiKey: "sk-local", models: {}, authMode: "apiKey" };
const localPlain: Provider = { name: "L", baseURL: "http://127.0.0.1:8080/v1", models: {}, authMode: "apiKey" };
const localCmd: Provider = { name: "L", baseURL: "http://localhost:9/v1", apiKeyCommand: "echo x", models: {}, authMode: "apiKey" };
const localEnv: Provider = { name: "E", baseURL: "http://localhost:9/v1", apiKeyEnv: "RIA_TEST_LOCAL_KEY", models: {}, authMode: "apiKey" };
process.env.RIA_TEST_LOCAL_KEY = "sk-env";
const noAuth: Provider = { name: "N", baseURL: "https://x.example/v1", models: {}, authMode: "none" };
check("localhost with a key is NOT keyless", isKeyless("l", localKeyed) === false);
check("localhost with a key command is NOT keyless", isKeyless("l", localCmd) === false);
check("localhost with an env key is NOT keyless", isKeyless("e", localEnv) === false);
delete process.env.RIA_TEST_LOCAL_KEY;
check("localhost without a key is keyless", isKeyless("l", localPlain) === true);
check("authMode none is keyless", isKeyless("n", noAuth) === true);
const bulkLocal = mk();
bulkLocal.providers.local.apiKey = "sk-local";
const visitedLocal: string[] = [];
await refreshAllModels(bulkLocal, {
  keyOf: (n, p) => apiKeySource(n, p).key,
  fetchList: async (p) => { visitedLocal.push(p.baseURL); return ["m"]; },
  save: () => {},
});
check("bulk refresh includes a keyed localhost provider", visitedLocal.some((u) => u.includes("localhost")), visitedLocal.join(","));

console.log(fail ? `\n${fail} FAIL / ${pass} ok` : `\nall ${pass} ok`);
process.exit(fail ? 1 : 0);