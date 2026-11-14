#!/usr/bin/env node
import process from "node:process";
import {
  loadConfig,
  resolveModel,
  addProvider,
  addModel,
  fetchProviderModels,
  mergeProviderModels,
  describeFetchedAt,
  refreshAllModels,
  isFresh,
  listProviders,
  saveConfig,
  configPath,
  verifyProvider,
  setProviderKey,
  hasKey,
  isKeyless,
  apiKeySource,
  apiKeyEnvName,
  maskKey,
  BUILTIN_PROVIDERS,
  FIRST_PROVIDER,
  type Config,
  type Provider,
} from "./config.js";
import { discoverSkills, defaultSkillsDirs, loadSkillContent, expandSkillMentions } from "./skills.js";
import { bindModel, type LLMClient } from "./llm.js";
import { Agent, type AgentEvent } from "./agent.js";
import { expandAttachments } from "./attach.js";
import { decodeKeys, type Key } from "./ui/keys.ts";
import { Editor } from "./ui/editor.ts";
import { MarkdownRenderer } from "./ui/markdown.ts";
import { renderWelcome, toolLine, shortArg, indent, editSummary, clip } from "./ui/welcome.ts";
import { renderStatus, gitBranch } from "./ui/status.ts";
import { palette, sym } from "./ui/theme.ts";
import { Picker, type PickerItem } from "./ui/picker.ts";
import { promptLine } from "./ui/prompt.ts";
import { ensureReady, preferredModel } from "./onboard.js";
import { ensureRiaOnPath, riaBinDir } from "./pathinstall.js";
import { renderDoctorReport } from "./doctor.js";
import { splitModels, findJunkModels, classifyModel, summarizeModels } from "./models.js";
import { saveSession, newSessionId, titleFrom, listSessions, loadSession, latestSessionId, searchSessions, matchSessionId } from "./sessions.js";

const VERSION = "0.1.1";
const T0 = Date.now();

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") { args.p = true; positional.push(argv[++i] ?? ""); }
    else if (a === "-m" || a === "--model") args.model = argv[++i];
    else if (a === "--provider") args.provider = argv[++i];
    else if (a === "-c" || a === "--continue") args.continueLast = true;
    else if (a === "--resume") args.resume = argv[++i];
    else if (a === "--provider-add") { args.providerAdd = argv[++i]; args.providerBaseURL = argv[++i]; args.providerKey = argv[++i]; }
    else if (a === "-h" || a === "--help") args.help = true;
    else if (a === "-v" || a === "--version") args.version = true;
    else positional.push(a);
  }
  return { args, positional };
}

const HELP = `Ria — token-lean open-source AI coding agent

Usage:
  Ria                     interactive REPL (you choose provider + key)
  Ria -p "task"           one-shot: run a task and print the answer
  Ria -m <model>          override model (e.g. deepseek-chat)
  Ria --provider <name>   override provider (deepseek, qwen, glm, openai, …)
  Ria --version           print version

Sessions (saved automatically after every turn):
  Ria -c                  continue the newest chat for this directory
  Ria --resume <id>       resume a saved chat (short ids work: 2-3 chars)
  Ria                     then inside: /sessions list · /resume <id> · /search <text>

Providers (bring your own key — nothing is built in):
  Ria providers                              list providers + key status
  Ria provider setup [name]                  pick a provider and enter your key
  Ria provider key <name> [apiKey]           set a key (prompted if omitted)
  Ria provider add <name> <baseURL> [apiKey] add any OpenAI-compatible API
  Ria model add <provider> <modelId>         register a model
  Ria models [provider]                      live model list from the API
  Ria models --all | --stale                 refresh every keyed provider / only stale
  Ria models <name> --prune                  drop blank / duplicate model ids
  Ria doctor                                 check config, keys, PATH, skills

Config: ${configPath()} (chmod 600) — keys never leave your machine.
         portable install? set RIA_HOME=<dir> to relocate config + sessions.
Env keys also work: DEEPSEEK_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …

REPL commands:
  /help     show this help          /model         pick a model (↑↓)
  /provider pick a provider         /provider setup <name>
  /provider key <name>              /custom        add OpenAI-compatible API
  /sessions /resume /search         /save /clear
  /context  token + context usage   /compact       compress context now
  /tokens   usage so far            /models        live model list
  /doctor   health check            /models --all  refresh every provider
  /exit     quit (also Ctrl+D)
  /models --all-ids shows embeddings/speech too · /models --prune drops junk ids
Keys: Enter send · Alt+Enter or \\ then Enter = new line · ↑↓ history
  / opens command menu · Tab accepts · F12 or Ctrl+K model picker
  F1 help · Shift+Tab cycles provider · Ctrl+C interrupt · Ctrl+D exit
Drag & drop a file or folder into the terminal to attach it — small files
are inlined; big ones are read on demand, so a huge drop costs ~0 tokens.`;

// ---------------------------------------------------------------- one-shot

function streamHandler(md: MarkdownRenderer): (e: AgentEvent) => void {
  return (e: AgentEvent) => {
    if (e.type === "text") md.push(String(e.data));
    else if (e.type === "tool_start") {
      md.end();
      md.done();
      const d = e.data as any;
      console.log(toolLine(String(d.name), shortArg(d.target), "run"));
    } else if (e.type === "tool_end") {
      const d = e.data as any;
      const sum = editSummary(String(d.output ?? ""));
      if (sum.ok && d.ok !== false) {
        console.log(toolLine(String(d.name), shortArg(sum.file), "ok", sum.detail));
        if (sum.diff) console.log(indent(sum.diff));
      } else if (d.ok === false) {
        const first = String(d.output ?? "").split("\n")[0];
        console.log(toolLine(String(d.name), shortArg(d.target), "err", clip(first, 70)));
      } else {
        console.log(toolLine(String(d.name), "", "ok", `${String(d.output ?? "").length}b`));
      }
    }
  };
}

async function runOneShot(cfg: Config, providerName?: string, modelName?: string, prompt?: string, resumeId?: string) {
  const { provider, modelKey, model, apiKey } = resolveModel(cfg, providerName, modelName);
  const client = bindModel(provider.baseURL, apiKey, modelKey);
  const skills = discoverSkills(cfg.skillsDirs ?? defaultSkillsDirs());
  const md = new MarkdownRenderer();
  const agent = new Agent(client, skills, (e) => {
    streamHandler(md)(e);
    if (e.type === "status") {
      const d = e.data as any;
      if (d.kind === "trim") console.error(palette.faint(`  · released ${d.reclaimed} tokens of old context`));
      else if (d.kind === "compacting") console.error(palette.faint(`  · compacting context (~${d.before} tokens)…`));
      else if (d.kind === "compact_failed") console.error(palette.warn(`  · compaction failed: ${d.error}`));
    } else if (e.type === "compacted") {
      const d = e.data as any;
      console.error(palette.faint(`  · compacted ${d.before} → ${d.after} tokens`));
    }
  }, { contextWindow: model?.context });

  // Resume: inject stored history — costs no API calls, the messages are
  // already token-budgeted from the session's last state.
  let saved: ReturnType<typeof loadSession> = null;
  if (resumeId) {
    const id = resumeId === "latest" ? latestSessionId(process.cwd()) : matchSessionId(process.cwd(), resumeId);
    saved = id ? loadSession(process.cwd(), id) : null;
    if (!saved) {
      console.error(palette.warn(`no saved session "${resumeId}" for this directory — starting fresh`));
    } else {
      agent.loadHistory(saved.messages);
      console.error(palette.faint(`resumed ${saved.id} — ${saved.messages.length} messages in context`));
    }
  }

  console.error(palette.faint(`[${modelKey}] working...`));
  try {
    await agent.run(prompt!);
  } catch (e) {
    md.end();
    console.log("");
    console.error(palette.err("error: " + (e as Error).message));
    process.exit(1);
  }
  md.end();
  console.log("");
  // Persist (append to the resumed session, or start a new one).
  if (agent.exportMessages.length) {
    try {
      const id = saved?.id ?? newSessionId();
      saveSession({
        id,
        title: saved?.title ?? titleFrom(agent.exportMessages.find((m) => m.role === "user")?.content ?? ""),
        cwd: process.cwd(),
        provider: provider.name,
        model: modelKey,
        created: saved?.created ?? new Date().toISOString(),
        messages: agent.exportMessages,
        stats: saved?.stats ?? { in: 0, out: 0 },
      });
    } catch { /* never fail the task because of saving */ }
  }
  if (process.env.RIA_STATS || process.env.RIA_DEBUG) {
    console.error(
      palette.faint(
        `requests: ${agent.stats.requests}  ·  tools: ${agent.stats.toolCalls}  ·  ` +
          `tokens: ${agent.cumulativeUsage.prompt_tokens} in / ${agent.cumulativeUsage.completion_tokens} out  ·  ` +
          `${(Date.now() - T0) / 1000}s`,
      ),
    );
  } else {
    console.error(palette.faint(`tokens: ${agent.cumulativeUsage.prompt_tokens} in / ${agent.cumulativeUsage.completion_tokens} out`));
  }
}

// ---------------------------------------------------------------- REPL

const MODEL_HELP: Array<[string, string]> = [
  ["/help", "commands"],
  ["/model", "model picker"],
  ["/provider", "provider"],
  ["/context", "tokens"],
  ["F1", "help"],
];

async function runRepl(cfg: Config, providerName?: string, modelName?: string, resumeId?: string) {
  const out = process.stdout;
  const host = { cols: () => out.columns || 80, write: (s: string) => out.write(s) };

  // Provider + model for the session. If the provider is usable and a model is
  // known, start silently; otherwise the caller (main) already ran the setup
  // wizard, so this only covers edge cases.
  let providerNameCur = providerName ?? cfg.defaultProvider;
  if (!cfg.providers[providerNameCur]) providerNameCur = Object.keys(cfg.providers)[0] ?? FIRST_PROVIDER;
  let { provider, model, apiKey, modelKey } = resolveModel(cfg, providerNameCur, modelName ?? cfg.defaultModel);
  let client: LLMClient = bindModel(provider.baseURL, apiKey, modelKey);
  const skills = discoverSkills(cfg.skillsDirs ?? defaultSkillsDirs());
  let emit: (e: AgentEvent) => void = () => {};
  let agent = new Agent(client, skills, (e) => emit(e), { contextWindow: model?.context });

  const editor = new Editor({ cols: () => out.columns || 80, write: (s) => out.write(s) });
  editor.completions = [
    ...skills.map((s) => ({ name: `@${s.name}`, desc: s.description.slice(0, 60) || "skill", insert: `@${s.name} ` })),
    { name: "/help", desc: "commands", insert: "/help" },
    { name: "/model", desc: "model picker", insert: "/model" },
    { name: "/models", desc: "live model list", insert: "/models" },    { name: "/provider", desc: "provider picker", insert: "/provider" },
    { name: "/providers", desc: "list providers + keys", insert: "/providers" },
    { name: "/custom", desc: "add OpenAI-compatible API", insert: "/custom " },
    { name: "/sessions", desc: "saved chats", insert: "/sessions" },
    { name: "/resume", desc: "continue a chat", insert: "/resume " },
    { name: "/search", desc: "search old chats", insert: "/search " },
    { name: "/compact", desc: "compress context now", insert: "/compact" },
    { name: "/context", desc: "context usage", insert: "/context" },
    { name: "/clear", desc: "wipe history", insert: "/clear" },
    { name: "/tokens", desc: "usage so far", insert: "/tokens" },
    { name: "/save", desc: "save session now", insert: "/save" },
    { name: "/init", desc: "write AGENTS.md", insert: "/init" },
    { name: "/exit", desc: "quit", insert: "/exit" },
  ];

  /** Age badge for the status bar when the current model list is stale (24h+). */
  const staleBadge = () => {
    const p = cfg.providers[providerNameCur];
    const age = describeFetchedAt(p?.modelsFetchedAt);
    return age && !isFresh(p?.modelsFetchedAt) ? age : "";
  };

  const footer = () =>
    renderStatus({
      model: modelKey,
      provider: provider.name,
      usedTokens: agent.estimatedTokens,
      contextWindow: model?.context,
      cwd: process.cwd(),
      branch: gitBranch(process.cwd()),
      busy: false,
      mode: "idle",
      staleModels: staleBadge(),
    });

  // ------------------------------------------------------------- sessions
  const sessionState: {
    id: string | null;
    title: string | null;
    created: string | null;
    in: number;
    out: number;
  } = { id: null, title: null, created: null, in: 0, out: 0 };

  const autoSave = () => {
    const msgs = agent.exportMessages;
    if (!msgs.length) return;
    try {
      saveSession({
        id: sessionState.id ?? (sessionState.id = newSessionId()),
        title: sessionState.title ?? (sessionState.title = titleFrom(msgs.find((m) => m.role === "user")?.content ?? "")),
        cwd: process.cwd(),
        provider: providerNameCur,
        model: modelKey,
        created: sessionState.created ?? (sessionState.created = new Date().toISOString()),
        messages: msgs,
        stats: { in: sessionState.in + agent.cumulativeUsage.prompt_tokens, out: sessionState.out + agent.cumulativeUsage.completion_tokens },
      });
    } catch { /* saving must never break the session */ }
  };

  // Flag-driven resume (ria --continue / ria --resume <id>): restore the
  // conversation before the first prompt — costs no API calls.
  if (resumeId) {
    const id = resumeId === "latest" ? latestSessionId(process.cwd()) : matchSessionId(process.cwd(), resumeId);
    const s = id ? loadSession(process.cwd(), id) : null;
    if (s) {
      agent.loadHistory(s.messages);
      sessionState.id = s.id;
      sessionState.title = s.title;
      sessionState.created = s.created;
      sessionState.in = s.stats?.in ?? 0;
      sessionState.out = s.stats?.out ?? 0;
      console.log(palette.ok(`resumed ${s.id} — ${s.messages.length} messages (~${Math.round(agent.estimatedTokens)} tokens in context)`));
      console.log(palette.faint(`"${s.title}"`));
      console.log("");
    } else {
      console.log(palette.warn(`no saved session "${resumeId}" for this directory — starting fresh`));
    }
  }

  let md = new MarkdownRenderer();
  let busy = false;
  let abort: AbortController | null = null;
  /** The editor is unfocused while the picker/key prompt owns the screen. */
  let suspended = false;
  /**
   * Keys typed while the editor is suspended. They belong to whatever UI is
   * on screen (picker, key prompt) or, between two async steps of one
   * command, to the next prompt — never to the editor behind a picker.
   */
  let held: Key[] = [];

  console.log(renderWelcome({
    model: modelKey,
    provider: provider.name,
    cwd: process.cwd(),
    skills: skills.length,
    context: model?.context,
    version: VERSION,
    hints: MODEL_HELP,
  }));

  const startEdit = () => {
    suspended = false;
    editor.focused = true;
    editor.reset();
    editor.draw(footer());
    // Keys typed while a picker/prompt/verify owned the screen replay now.
    if (held.length) {
      const next = held;
      held = [];
      feed(next);
    }
  };

  const hideEditor = () => {
    editor.erase();
    editor.focused = false;
    suspended = true;
  };

  const finishSegment = () => {
    md.end();
    md.done();
  };

  const handleEvent = (e: AgentEvent) => {
    if (e.type === "text") md.push(String(e.data));
    else if (e.type === "tool_start") {
      finishSegment();
      md = new MarkdownRenderer();
      const d = e.data as any;
      console.log(toolLine(String(d.name), shortArg(d.target), "run"));
    } else if (e.type === "tool_end") {
      const d = e.data as any;
      const sum = editSummary(String(d.output ?? ""));
      if (sum.ok && d.ok !== false) {
        console.log(toolLine(String(d.name), shortArg(sum.file), "ok", sum.detail));
        if (sum.diff) console.log(indent(sum.diff));
      } else if (d.ok === false) {
        // Failures name the file too, so you can see what was attempted.
        const first = String(d.output ?? "").split("\n")[0];
        console.log(toolLine(String(d.name), shortArg(d.target), "err", clip(first, 70)));
      } else {
        console.log(toolLine(String(d.name), "", "ok", `${String(d.output ?? "").length}b`));
      }
    } else if (e.type === "status") {
      const d = e.data as any;
      finishSegment();
      md = new MarkdownRenderer();
      if (d.kind === "trim") console.log(palette.faint(`  · released ${d.reclaimed} tokens of old context`));
      else if (d.kind === "compacting") console.log(palette.faint(`  · compacting context (~${d.before} tokens)…`));
      else if (d.kind === "compact_failed") console.log(palette.warn(`  · compaction failed: ${d.error}`));
      else if (d.kind === "compact_skipped") console.log(palette.faint(`  · compaction would not save space (${d.before} → ${d.after}); skipped`));
      else if (d.kind === "api_error") console.log(palette.err(`  · api error: ${d.error}`));
    } else if (e.type === "compacted") {
      const d = e.data as any;
      finishSegment();
      md = new MarkdownRenderer();
      if (d.grew) {
        console.log(palette.warn(`  ✓ compacted ${d.before} → ${d.after} tokens`) + palette.faint(" — session summarised (was already small)"));
      } else {
        console.log(palette.ok(`  ✓ compacted ${d.before} → ${d.after} tokens`) + palette.faint(" — session continues"));
      }
    }
  };
  emit = handleEvent;

  const rebuild = () => {
    ({ provider, model, apiKey, modelKey } = resolveModel(cfg, providerNameCur, cfg.defaultModel));
    client = bindModel(provider.baseURL, apiKey, modelKey);
    agent = new Agent(client, skills, (e) => emit(e), { contextWindow: model?.context });
  };

  const useModel = (name: string) => {
    const next = resolveModel(cfg, providerNameCur, name);
    ({ modelKey, provider, model, apiKey } = next);
    client = bindModel(provider.baseURL, apiKey, modelKey);
    agent = new Agent(client, skills, (e) => emit(e), { contextWindow: model?.context });
    cfg.defaultModel = modelKey;
    saveConfig(cfg);
    console.log(palette.ok(`model → ${modelKey}`) + palette.faint(`  (${provider.name} · history cleared)`));
  };

  const useProvider = (name: string) => {
    providerNameCur = name;
    cfg.defaultProvider = name;
    const first = Object.keys(cfg.providers[name]?.models ?? {})[0];
    if (first) cfg.defaultModel = first; // keep the old model when the target has none yet
    saveConfig(cfg);
    rebuild();
    console.log(palette.ok(`provider → ${name}`) + palette.faint(`  model ${modelKey} · history cleared`));
    // Keyed provider with no model list yet (e.g. the key was set while the
    // network/API was down): pull the live list in the background so the
    // provider is immediately usable, without blocking the prompt.
    const p = cfg.providers[name];
    if (p && !Object.keys(p.models).length && hasKey(name, p)) {
      void fetchProviderModels(p, apiKeySource(name, p).key || undefined)
        .then((ids) => {
          if (!ids.length || providerNameCur !== name) return;
          mergeProviderModels(p, ids);
          const better = preferredModel(ids);
          if (better && !p.models[modelKey]) {
            cfg.defaultModel = better;
            saveConfig(cfg);
            rebuild(); // adopt a real model id (same semantics as /model)
          }
          const wasFocused = editor.focused;
          if (wasFocused) editor.erase();
          console.log(palette.faint(`  ${ids.length} models fetched for ${name}`));
          if (wasFocused) editor.draw(footer());
        })
        .catch(() => { /* still unreachable — /models will fetch later */ });
    }
  };

  // ------------------------------------------------------------- pickers
  /** Run a picker and return the chosen value (null = cancelled). */
  const pick = (spec: { title: string; items: PickerItem[]; footer?: string }): Promise<string | null> =>
    new Promise((resolve) => {
      hideEditor();
      const picker = new Picker(spec, host);
      currentPicker = picker;
      pickResolve = (v) => {
        picker.erase();
        currentPicker = null;
        pickResolve = null;
        resolve(v);
        startEdit();
      };
      picker.draw();
    });
  let currentPicker: Picker | null = null;
  let pickResolve: ((v: string | null) => void) | null = null;
  /** True while promptLine owns stdin — the dispatcher stands down. */
  let promptActive = false;

  /**
   * Feed keys through the central dispatcher, one key at a time, so state
   * changes mid-batch (picker closes, prompt starts) are respected.
   */
  let feed: (keys: Key[]) => void = () => {};

  /**
   * Read one line for a command. Keys typed while the command was setting up
   * (or after Enter inside the prompt itself — a fast typist) are replayed
   * first, so they land in the right prompt instead of the editor behind it.
   */
  const ask = async (label: string, opts: { secret?: boolean; initial?: string; validate?: (v: string) => string | null } = {}): Promise<string> => {
    hideEditor();
    const pre = held;
    held = [];
    promptActive = true;
    const onLeftover = (keys: Key[]) => { held.push(...keys); };
    process.stdin.addListener("ria:leftover", onLeftover);
    try {
      return await promptLine(host, label, { ...opts, initialKeys: pre });
    } finally {
      promptActive = false;
      process.stdin.removeListener("ria:leftover", onLeftover);
    }
  };

  /** Masked key entry with optional live verification. */
  const askForKey = async (pname: string, p: Provider, title: string): Promise<boolean> => {
    const key = await ask(`${title} — paste your API key`, { secret: true });
    if (!key) {
      console.log(palette.faint("cancelled — key not saved"));
      startEdit();
      return false;
    }
    setProviderKey(cfg, pname, key);
    out.write(palette.faint("  verifying… "));
    try {
      if (p.authMode === "none") await fetchProviderModels(p, key);
      else await verifyProvider(p, key);
      out.write(palette.ok("key works ✓") + "\n");
    } catch (e) {
      out.write(palette.warn(`could not verify (${(e as Error).message})`) + "\n");
      console.log(palette.faint(`  saved anyway to ${configPath()} — fix it with /provider key ${pname}`));
    }
    // Pull the live model list so the new provider is immediately usable.
    try {
      const ids = await fetchProviderModels(p, key);
      const known = Object.keys(p.models);
      mergeProviderModels(p, ids);
      if (!known.length && ids.length) {
        cfg.defaultModel = ids.find((i) => /coder|chat/i.test(i)) ?? ids[0];
      }
      saveConfig(cfg);
      out.write(palette.faint(`  ${ids.length} models available`) + "\n");
    } catch { /* /models may be unsupported; configured models still work */ }
    startEdit();
    return true;
  };

  /** Add a custom OpenAI-compatible provider interactively. */
  const setupCustom = async (presetName?: string): Promise<string | null> => {
    const name = (presetName || await ask("provider name (e.g. myapi)")).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!name) { console.log(palette.faint("cancelled")); startEdit(); return null; }
    const url = await ask("base URL (OpenAI-compatible, ends in /v1)", { initial: "https://" });
    if (!url || !/^https?:\/\//i.test(url)) { console.log(palette.err("cancelled — a http(s) base URL is required")); startEdit(); return null; }
    const p = addProvider(cfg, name, url);
    const ok = await askForKey(name, p, name);
    startEdit();
    if (!ok) { console.log(palette.warn(`provider "${name}" saved without a key — set one with /provider key ${name}`)); return name; }
    console.log(palette.ok(`provider "${name}" ready`) + palette.faint("  /model to pick one of its models"));
    return name;
  };
  void 0;

  const providerPicker = async () => {
    const items: PickerItem[] = listProviders(cfg).map(([key, p]) => ({
      value: key,
      label: key,
      desc: p.name,
      note: hasKey(key, p) ? palette.ok("key ✓") : p.authMode === "none" ? palette.faint("no key") : palette.warn("key needed"),
    }));
    items.push({ value: "__custom", label: "+ custom API", desc: "any OpenAI-compatible URL" });
    const choice = await pick({
      title: "provider",
      items: items.map((i) => (i.value === providerNameCur ? { ...i, note: (i.note ? i.note + "  " : "") + palette.brand("· current") } : i)),
      footer: "↑↓ move · type to filter · Enter select · Esc back",
    });
    if (!choice) return;
    if (choice === "__custom") {
      const name = await setupCustom();
      if (name) useProvider(name);
      return;
    }
    if (choice === providerNameCur) { console.log(palette.faint(`already on ${choice}`)); return; }
    const p = cfg.providers[choice];
    if (!hasKey(choice, p)) {
      const ok = await askForKey(choice, p, `${choice} (${p.name})`);
      if (!ok) return;
    }
    useProvider(choice);
  };

  const modelPicker = async () => {
    const p = provider;
    const fetched = describeFetchedAt(p.modelsFetchedAt);
    const all = Object.keys(p.models);
    const { chat, other } = splitModels(all);
    const row = (id: string): PickerItem => {
      const info = p.models[id] ?? {};
      return {
        value: id,
        label: id,
        note: id === modelKey ? palette.brand("· current") : info.context ? palette.faint(`${Math.round(info.context / 1000)}k ctx`) : undefined,
      };
    };
    const configured = chat.map(row);
    const items: PickerItem[] = [
      ...configured,
      ...(other.length
        ? [{ value: "__other", label: `… ${other.length} non-chat model${other.length === 1 ? "" : "s"}`, desc: "embeddings · speech · rerank" }]
        : []),
      {
        value: "__live",
        label: fetched ? "… refresh from API" : "… live list from API",
        desc: fetched ? `fetched ${fetched}` : "fetch every model from /models",
      },
      { value: "__provider", label: "… switch provider", desc: `${providerNameCur} → others` },
    ];
    const chatNote = other.length ? `${chat.length} chat + ${other.length} other` : `${chat.length} models`;
    const choice = await pick({
      title: `model · ${p.name}`,
      items,
      footer: `${chatNote}${fetched ? ` · updated ${fetched}` : ""} · type to filter · Enter select · Esc back · --prune cleans ids`,
    });
    if (!choice) return;
    if (choice === "__provider") return providerPicker();
    if (choice === "__other") {
      // Non-chat endpoints stay reachable, just out of the way.
      const pickOne = await pick({
        title: `non-chat models · ${p.name}`,
        items: other.map(row),
        footer: `${other.length} models · these usually cannot chat — Enter select anyway · Esc back`,
      });
      if (pickOne) useModel(pickOne);
      return;
    }
    if (choice === "__live") {
      try {
        const ids = await fetchProviderModels(p, apiKeySource(providerNameCur, p).key || undefined);
        const added = mergeProviderModels(p, ids);
        saveConfig(cfg);
        const live = splitModels(ids);
        const liveOther = live.other.length ? ` · ${live.other.length} non-chat hidden` : "";
        const fresh = added ? `+${added} new · ` : "";
        const livePick = await pick({
          title: `live models · ${p.name}`,
          items: live.chat.map(row),
          footer: `${fresh}${live.chat.length} chat models${liveOther} · ↑↓ move · type to filter · Enter select · Esc back`,
        });
        if (livePick) useModel(livePick);
      } catch (e) {
        console.log(palette.err(`could not list models: ${(e as Error).message}`));
      }
      return;
    }
    useModel(choice);
  };

  const sessionPicker = async () => {
    const all = listSessions(process.cwd(), 30);
    if (!all.length) { console.log(palette.faint("no saved sessions for this directory yet")); return; }
    const choice = await pick({
      title: "resume session",
      items: all.map((s) => ({
        value: s.id,
        label: s.id,
        desc: s.title,
        note: palette.faint(`${s.messages} msgs · ~${s.tokensEst} tok`),
      })),
    });
    if (!choice) return;
    const s = loadSession(process.cwd(), choice);
    if (!s) { console.log(palette.err(`session "${choice}" not found`)); return; }
    agent.loadHistory(s.messages);
    sessionState.id = s.id;
    sessionState.title = s.title;
    sessionState.created = s.created;
    sessionState.in = s.stats?.in ?? 0;
    sessionState.out = s.stats?.out ?? 0;
    console.log(palette.ok(`resumed ${s.id} — ${s.messages.length} messages (~${Math.round(agent.estimatedTokens)} tokens in context)`));
  };

  const cycleProvider = () => {
    const names = Object.keys(cfg.providers).filter((n) => hasKey(n, cfg.providers[n]));
    if (names.length < 2) {
      void providerPicker();
      return;
    }
    const i = names.indexOf(providerNameCur);
    useProvider(names[(i + 1) % names.length]);
  };

  const showProviders = async (details = false) => {
    for (const [name, p] of listProviders(cfg)) {
      const cur = name === providerNameCur ? palette.brand(" ← current") : "";
      const src = apiKeySource(name, p);
      const keyInfo = src.from === "env"
        ? palette.ok(`key from ${src.envVar}`)
        : src.from === "config"
          ? palette.ok(`key ${maskKey(src.key)}`)
          : src.from === "command"
            ? palette.ok(`key ${maskKey(src.key)} via apiKeyCommand`)
            : isKeyless(name, p) ? palette.faint("no key needed") : palette.warn(`no key — /provider key ${name}`);
      console.log(`${palette.boldWhite(name)}${cur}  ${palette.faint("·")} ${p.name}`);
      console.log(`  ${palette.faint(p.baseURL)}  ${keyInfo}`);
      if (details || name === providerNameCur) {
        const fetched = describeFetchedAt(p.modelsFetchedAt);
        const summary = summarizeModels(Object.keys(p.models));
        console.log(`  ${palette.faint("models:")} ${summary || palette.faint("(none — /models to fetch)")}${fetched ? palette.faint(`  · updated ${fetched}`) : ""}`);
      }
    }
    console.log(palette.faint(`add any OpenAI-compatible API: /custom   ·   config: ${configPath()}`));
  };

  const runTurn = async (text: string): Promise<void> => {
    if (text.startsWith("/")) {
      const [cmd, ...rest] = text.split(/\s+/);
      const known = new Set(["/exit", "/quit", "/q", "/help", "/clear", "/tokens", "/context", "/model", "/init", "/models", "/providers", "/provider", "/custom", "/compact", "/sessions", "/resume", "/search", "/save", "/key", "/doctor"]);
      if (!known.has(cmd)) {
        await runAgent(expandAttachments(expandSkillMentions(text, skills))); // not a command — send to the model as-is
        return;
      }
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "/exit": case "/quit": case "/q": cleanup(); return;
        case "/help": console.log(HELP); break;
        case "/clear":
          agent.reset();
          sessionState.id = null; sessionState.title = null; sessionState.created = null;
          sessionState.in = 0; sessionState.out = 0;
          console.log(palette.ok("history cleared (new session on next message)"));
          break;
        case "/sessions": {
          const all = listSessions(process.cwd(), 20);
          if (!all.length) { console.log(palette.faint("no saved sessions for this directory yet")); break; }
          console.log(palette.boldWhite("sessions here (newest first):"));
          for (const s of all) {
            console.log(`  ${palette.brand(s.id)}  ${palette.faint(s.updated.slice(0, 16).replace("T", " "))}  ${s.messages} msgs ~${s.tokensEst} tok`);
            console.log(`    ${s.title}`);
          }
          console.log(palette.faint("resume: /resume (picker) or /resume <id>"));
          break;
        }
        case "/resume": {
          if (!arg) { await sessionPicker(); break; }
          const id = arg === "latest" ? latestSessionId(process.cwd()) : matchSessionId(process.cwd(), arg) ?? arg;
          if (!id) { console.log(palette.warn("no saved sessions for this directory")); break; }
          const s = loadSession(process.cwd(), id);
          if (!s) { console.log(palette.err(`session "${id}" not found — see /sessions`)); break; }
          agent.loadHistory(s.messages);
          sessionState.id = s.id;
          sessionState.title = s.title;
          sessionState.created = s.created;
          sessionState.in = s.stats?.in ?? 0;
          sessionState.out = s.stats?.out ?? 0;
          console.log(palette.ok(`resumed ${s.id} — ${s.messages.length} messages (~${Math.round(agent.estimatedTokens)} tokens in context)`));
          console.log(palette.faint(`"${s.title}"`));
          break;
        }
        case "/search": {
          if (!arg) { console.log("usage: /search <text or /regex/>"); break; }
          const rx = arg.startsWith("/") && arg.endsWith("/") && arg.length > 2 ? arg.slice(1, -1) : arg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const hits = searchSessions(process.cwd(), rx, 12);
          if (!hits.length) { console.log(palette.faint("no matches in saved sessions")); break; }
          for (const h of hits) {
            console.log(`${palette.brand(h.id)} ${palette.faint(h.updated.slice(0, 16).replace("T", " "))} ${h.title}`);
            console.log(`  ${palette.faint(h.snippet.slice(0, 110))}`);
          }
          break;
        }
        case "/save": {
          autoSave();
          console.log(palette.ok(`saved as ${sessionState.id}`));
          break;
        }
        case "/tokens":
          console.log(`in: ${agent.cumulativeUsage.prompt_tokens}  out: ${agent.cumulativeUsage.completion_tokens}`);
          break;
        case "/context": {
          const ctx = model?.context ?? 0;
          const est = agent.estimatedTokens;
          const pct = ctx ? ((est / ctx) * 100).toFixed(1) : "?";
          const cd = agent.compactCount ? palette.faint(`  · ${agent.compactCount} compaction(s)`) : "";
          console.log(`context: ~${est} / ${ctx} tokens (${pct}%)${cd}`);
          console.log(palette.faint(`session total: ${agent.cumulativeUsage.prompt_tokens} in / ${agent.cumulativeUsage.completion_tokens} out`));
          if (ctx) console.log(palette.faint(`auto-compacts at 72% (~${Math.round(ctx * 0.72)} tokens)`));
          break;
        }
        case "/compact": {
          busy = true;
          abort = new AbortController();
          try {
            const ok = await agent.compactNow(abort.signal);
            if (!ok) console.log(palette.warn("nothing to compact yet"));
          } catch (e) {
            console.log(palette.err(`compaction failed: ${(e as Error).message}`));
          } finally {
            busy = false;
            abort = null;
          }
          break;
        }
        case "/models": {
          // /models              → this provider (chat models only)
          // /models --all-ids    → also show embeddings/speech/rerank, tagged
          // /models --prune      → drop blank/duplicate ids, then show the list
          // /models --all        → every keyed provider
          // /models --stale      → only keyed providers with a stale/absent list
          const flag = arg.replace(/^--?/, "").toLowerCase();
          if (flag === "all" || flag === "stale") {
            console.log(palette.faint(`refreshing model lists (${flag === "all" ? "all keyed providers" : "stale only"})…`));
            const results = await refreshAllModels(cfg, {
              keyOf: (n, p) => apiKeySource(n, p).key,
              onlyStale: flag === "stale",
              onResult: (r) => {
                if (!r.ok) console.log(`  ${palette.err("✗")} ${palette.text(r.name.padEnd(14))} ${palette.faint(r.error ?? "")}`);
                else if (r.added) console.log(`  ${palette.ok("✓")} ${palette.text(r.name.padEnd(14))} +${r.added} new · ${r.total} total`);
                else console.log(`  ${palette.ok("✓")} ${palette.text(r.name.padEnd(14))} ${palette.faint(`${r.total} models · up to date`)}`);
              },
            });
            if (!results.length) console.log(palette.faint("nothing to refresh — no keyed providers (or all lists are fresh)"));
            else {
              const okN = results.filter((r) => r.ok).length;
              console.log(palette.faint(`${okN}/${results.length} refreshed · /model to pick`));
            }
            break;
          }
          if (flag === "prune") {
            const junk = findJunkModels(Object.keys(provider.models));
            const drop = new Set<string>([...junk.blank, ...junk.duplicates]);
            for (const id of drop) delete provider.models[id];
            if (drop.size) saveConfig(cfg);
            const after = splitModels(Object.keys(provider.models));
            console.log(drop.size
              ? palette.ok(`pruned ${drop.size} junk id${drop.size === 1 ? "" : "s"} from ${providerNameCur}`)
              : palette.faint(`nothing to prune in ${providerNameCur} — no blank or duplicate ids`));
            console.log(palette.faint(`  kept ${after.chat.length} chat + ${after.other.length} non-chat · /model to pick`));
            break;
          }
          try {
            const ids = await fetchProviderModels(provider, apiKeySource(providerNameCur, provider).key || undefined);
            const split = splitModels(ids);
            console.log(`${provider.name} live models:`);
            for (const id of split.chat) console.log(`  ${id}`);
            if (flag === "allids" || flag === "all-ids") {
              for (const id of split.other) console.log(`  ${id}  ${palette.faint(`(${classifyModel(id)})`)}`);
            } else if (split.other.length) {
              console.log(palette.faint(`  (${split.other.length} non-chat model${split.other.length === 1 ? "" : "s"} hidden — /models --all-ids to show)`));
            }
            const added = mergeProviderModels(provider, ids);
            if (added) {
              saveConfig(cfg);
              console.log(palette.faint(`registered ${added} new model(s) — /model to switch`));
            }
          } catch (e) {
            console.log(palette.err(`could not list models: ${(e as Error).message}`));
            console.log(palette.faint(`configured: ${Object.keys(provider.models).join(", ") || "(none)"}`));
          }
          break;
        }
        case "/providers":
          await showProviders(arg === "all");
          break;
        case "/doctor":
          console.log(renderDoctorReport(cfg, { version: VERSION }).text);
          break;
        case "/custom": {
          const name = await setupCustom(arg.split(/\s+/)[0]);
          if (name) useProvider(name);
          break;
        }
        case "/provider": {
          const [sub2, ...tail] = rest;
          if (!sub2) { await providerPicker(); break; }
          if (sub2 === "setup" || sub2 === "key" || sub2 === "login") {
            const pname = tail[0];
            if (!pname) { await providerPicker(); break; }
            const p = cfg.providers[pname];
            if (!p) { console.log(palette.err(`unknown provider "${pname}" — /providers to list`)); break; }
            if (sub2 === "key" && tail[1]) {
              setProviderKey(cfg, pname, tail.slice(1).join(" "));
              console.log(palette.ok(`key saved for ${pname}`));
              break;
            }
            const ok = await askForKey(pname, p, `${pname} (${p.name})`);
            if (ok && pname !== providerNameCur) useProvider(pname);
            break;
          }
          if (!cfg.providers[sub2]) { console.log(palette.err(`unknown provider "${sub2}" — see /providers`)); break; }
          if (!hasKey(sub2, cfg.providers[sub2]) && sub2 !== providerNameCur) {
            const ok = await askForKey(sub2, cfg.providers[sub2], `${sub2} (${cfg.providers[sub2].name})`);
            if (!ok) break;
          }
          useProvider(sub2);
          break;
        }
        case "/model":
          if (!arg) await modelPicker();
          else useModel(arg);
          break;
        case "/init": {
          busy = true; abort = new AbortController();
          await runAgent("Write an AGENTS.md file in the current directory: a concise guide to this project (purpose, layout, build/test commands, conventions). Read key files first. Keep it under 60 lines.");
          break;
        }
        default:
          console.log(palette.warn(`unknown command ${cmd} — try /help`));
      }
      return;
    }
    busy = true;
    abort = new AbortController();
    await runAgent(expandAttachments(expandSkillMentions(text, skills)));
  };

  const runAgent = async (text: string) => {
    try {
      await agent.run(text, abort?.signal);
    } catch (e) {
      finishSegment();
      console.log(palette.err("error: " + (e as Error).message));
    } finally {
      finishSegment();
      autoSave();
      console.log("");
      console.log(renderStatus({
        model: modelKey,
        provider: provider.name,
        usedTokens: agent.cumulativeUsage.prompt_tokens,
        contextWindow: model?.context,
        cwd: process.cwd(),
        branch: gitBranch(process.cwd()),
        busy: false,
        mode: "idle",
        staleModels: staleBadge(),
      }));
      console.log("");
      busy = false;
      abort = null;
      md = new MarkdownRenderer();
      startEdit();
    }
  };

  function cleanup() {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    out.write("\n");
    process.exit(0);
  }

  const onInputLine = async (text: string) => {
    editor.addHistory(text);
    editor.erase();
    console.log(palette.brand(sym.user) + " " + text);
    await runTurn(text);
    if (!busy && !suspended) startEdit();
    drain();
  };

  // wire stdin
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();

  let pendingKeys: Key[] = [];

  const handleKeys = (keys: Key[]) => {
    let submitting: string | null = null;
    for (let i = 0; i < keys.length; i++) {
      const action = editor.handle(keys[i]);
      if (action === "submit") {
        submitting = editor.value.trim();
        pendingKeys.push(...keys.slice(i + 1));
        break;
      } else if (action === "eof") { cleanup(); return; }
      else if (action === "clear-screen") { out.write("\x1b[2J\x1b[H"); editor.draw(footer()); }
      else if (action === "help") { editor.erase(); console.log(HELP); editor.draw(footer()); }
      else if (action === "picker") { editor.reset(); void modelPicker().then(() => editor.draw(footer())); return; }
      else if (action === "interrupt") {
        if (editor.value) { editor.reset(); editor.draw(footer()); }
        else cleanup();
      }
    }
    if (submitting) void onInputLine(submitting);
    else if (!busy && !suspended) editor.draw(footer());
  };

  const drain = () => {
    if (!busy && !suspended && pendingKeys.length) {
      const next = pendingKeys;
      pendingKeys = [];
      feed(next);
    }
  };

  /** Central input dispatcher: everything stdin decodes into lands here. */
  feed = (keys: Key[]) => {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      // An open key prompt reads stdin itself; the dispatcher must not
      // double-deliver the same bytes to held/editor.
      if (promptActive) continue;
      // A picker owns input while it is open.
      if (currentPicker) {
        if (currentPicker.key(k) === "done") {
          // Keys after the confirming Enter belong to the next prompt.
          held.push(...keys.slice(i + 1));
          const done = pickResolve;
          done?.(currentPicker.result);
          return;
        }
        currentPicker.draw();
        continue;
      }
      // Between prompts (or before one starts): hold, don't leak into the editor.
      if (suspended) {
        held.push(k);
        continue;
      }
      // Shift+Tab cycles providers from an empty prompt.
      if (k.t === "shiftTab" && !editor.value) {
        cycleProvider();
        editor.draw(footer());
        continue;
      }
      if (k.t !== "shiftTab") handleKeys([k]);
    }
  };

  process.stdin.on("data", (chunk: string) => {
    if (busy) {
      // ESC or Ctrl+C interrupts the running turn
      if (chunk.includes("\x1b") || chunk.includes("\x03")) {
        abort?.abort();
        console.log(palette.warn("  interrupted"));
      }
      return;
    }
    feed(decodeKeys(chunk));
  });

  startEdit();
}

// ---------------------------------------------------------------- main

async function main() {
  const { args, positional } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  // Packaged exe: make sure `ria` is launchable from any terminal.
  const pathState = ensureRiaOnPath();
  if (pathState === "added") {
    console.log(
      palette.ok(`✓ added ${riaBinDir()} to your PATH`) +
        palette.faint(" — open a new terminal; `ria` now works everywhere"),
    );
  }

  if (args.version) { console.log(`ria ${VERSION}`); return; }
  if (args.help) { console.log(HELP); return; }

  // ---- provider/model management subcommands ----
  const [sub, subArg, ...rest] = positional;

  if (sub === "provider" && (subArg === "setup" || subArg === "key")) {
    const name = rest[0];
    if (!name) {
      // No provider named: run the interactive wizard.
      cfg.onboarded = false;
      await ensureReady(cfg);
      return;
    }
    const p = cfg.providers[name];
    if (!p) { console.error(`Unknown provider "${name}". Known: ${Object.keys(cfg.providers).join(", ")}`); process.exit(1); }
    const given = rest.slice(1).join(" ").trim();
    const key = given || (await promptLine(
      { cols: () => process.stdout.columns || 80, write: (s) => process.stdout.write(s) },
      `${name} (${p.name}) — paste your API key`,
      { secret: true },
    ));
    if (!key) { console.error("cancelled — no key saved"); process.exit(1); }
    setProviderKey(cfg, name, key);
    console.log(palette.ok(`key saved for ${name}`) + palette.faint(`  → ${configPath()}`));
    if (!given) {
      try { await verifyProvider(p, key); console.log(palette.ok("verified ✓")); }
      catch (e) { console.log(palette.warn(`could not verify: ${(e as Error).message}`)); }
    }
    // Pull the live model list so the provider is immediately usable —
    // the same thing the setup wizard does after a key is entered.
    try {
      const ids = await fetchProviderModels(p, key);
      const known = Object.keys(p.models);
      mergeProviderModels(p, ids);
      if (!known.length && ids.length && name === cfg.defaultProvider) {
        cfg.defaultModel = preferredModel(ids) ?? cfg.defaultModel;
      }
      saveConfig(cfg);
      console.log(palette.faint(`  ${ids.length} models available — pick with: Ria -m <id> --provider ${name}`));
    } catch (e) {
      console.log(palette.faint(`  could not list models yet (${(e as Error).message}) — run: Ria models ${name}`));
    }
    return;
  }

  if (sub === "doctor") {
    const { text, ok } = renderDoctorReport(cfg, { version: VERSION });
    console.log(text);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (sub === "provider" && subArg === "add") {
    const [, , name, baseURL, apiKey] = [sub, subArg, ...rest] as string[];
    if (!name || !baseURL) {
      console.error('Usage: Ria provider add <name> <baseURL> [apiKey]\nExample: Ria provider add groq https://api.groq.com/openai/v1 gsk_...');
      process.exit(1);
    }
    const p = addProvider(cfg, name, baseURL, apiKey);
    console.log(`Added OpenAI-compatible provider "${name}" → ${p.baseURL}`);
    if (apiKey) {
      try {
        const ids = await fetchProviderModels(p);
        mergeProviderModels(p, ids);
        saveConfig(cfg);
        console.log(`  ${ids.length} models available — Ria model add ${name} <id>`);
      } catch (e) {
        console.log(`  could not list models yet (${(e as Error).message})`);
      }
    } else {
      console.log(`Next: Ria provider key ${name}   then: Ria models ${name}`);
    }
    return;
  }
  if (sub === "model" && subArg === "add") {
    const [, , prov, id] = [sub, subArg, ...rest] as string[];
    if (!prov || !id) { console.error("Usage: Ria model add <provider> <modelId>"); process.exit(1); }
    addModel(cfg, prov, id);
    console.log(`Added "${id}" to ${prov}. Run: Ria -m ${id} --provider ${prov}`);
    return;
  }
  if (sub === "providers") {
    for (const [name, p] of listProviders(cfg)) {
      const def = name === cfg.defaultProvider ? palette.faint("  ← default") : "";
      const src = apiKeySource(name, p);
      const keyInfo = src.from === "env"
        ? palette.ok(`key from ${src.envVar}`)
        : src.from === "config"
          ? palette.ok(`key ${maskKey(src.key)}`)
          : src.from === "command"
            ? palette.ok(`key ${maskKey(src.key)} via apiKeyCommand`)
            : isKeyless(name, p) ? palette.faint("no key needed") : palette.warn("no key");
      console.log(`${palette.boldWhite(name)}${def}  ${palette.faint("·")} ${p.name}`);
      const fetchedAt = describeFetchedAt(p.modelsFetchedAt);
      const summary = summarizeModels(Object.keys(p.models)) || "(none)";
      console.log(`  ${p.baseURL}  ${keyInfo}  models: ${summary}${fetchedAt ? `  · updated ${fetchedAt}` : ""}`);
    }
    console.log(palette.faint(`set a key: Ria provider setup <name>   ·   config: ${configPath()}`));
    return;
  }
  if (sub === "models") {
    // `Ria models <name> --prune` / `Ria models --prune --all`
    const pruneFlag = subArg === "--prune" || rest.includes("--prune");
    if (pruneFlag) {
      const targetAll = subArg === "--all" || rest.includes("--all");
      const targets = targetAll
        ? Object.keys(cfg.providers)
        : [(subArg && subArg !== "--prune" ? subArg : cfg.defaultProvider)];
      let removedTotal = 0;
      for (const n of targets) {
        const p = cfg.providers[n];
        if (!p) { console.error(`unknown provider "${n}"`); process.exitCode = 1; continue; }
        const ids = Object.keys(p.models);
        const junk = findJunkModels(ids);
        const drop = new Set(junk.blank);
        for (const d of junk.duplicates) drop.add(d);
        for (const id of drop) delete p.models[id];
        removedTotal += drop.size;
        const { chat, other } = splitModels(Object.keys(p.models));
        console.log(`  ${n.padEnd(14)} removed ${drop.size} · kept ${chat.length} chat + ${other.length} non-chat`);
      }
      saveConfig(cfg);
      console.log(removedTotal ? `${removedTotal} junk entr${removedTotal === 1 ? "y" : "ies"} removed` : "nothing to prune — no blank or duplicate ids");
      return;
    }
    if (subArg === "--all" || subArg === "--stale") {
      const onlyStale = subArg === "--stale";
      const results = await refreshAllModels(cfg, {
        keyOf: (n, p) => apiKeySource(n, p).key,
        onlyStale,
        onResult: (r) => console.log(r.ok
          ? `  ✓ ${r.name.padEnd(14)} ${r.added ? `+${r.added} new · ` : ""}${r.total} models`
          : `  ✗ ${r.name.padEnd(14)} ${r.error ?? ""}`),
      });
      if (!results.length) console.log("nothing to refresh — no keyed providers (or all lists are fresh)");
      else console.log(`${results.filter((r) => r.ok).length}/${results.length} refreshed`);
      process.exitCode = results.some((r) => !r.ok) ? 1 : 0;
      return;
    }
    const pname = subArg || cfg.defaultProvider;
    const p = cfg.providers[pname];
    if (!p) { console.error(`Unknown provider "${pname}". Known: ${Object.keys(cfg.providers).join(", ")}`); process.exit(1); }
    // `--all-ids` also lists embeddings/speech/rerank, with their kind.
    const showAllIds = rest.includes("--all-ids");
    try {
      const ids = await fetchProviderModels(p, apiKeySource(pname, p).key || undefined);
      const split = splitModels(ids);
      console.log(`${pname} live models:`);
      for (const id of split.chat) console.log(`  ${id}`);
      if (showAllIds) {
        for (const id of split.other) console.log(`  ${id}  ${palette.faint(`(${classifyModel(id)})`)}`);
      } else if (split.other.length) {
        console.log(palette.faint(`  (${split.other.length} non-chat model${split.other.length === 1 ? "" : "s"} hidden: embeddings/speech/rerank — see Ria models ${pname} --all-ids)`));
      }
      console.log(palette.faint(`add one: Ria model add ${pname} <modelId>`));
    } catch (e) {
      console.error(`could not list models: ${(e as Error).message}`);
      console.error(`configured models: ${Object.keys(p.models).join(", ") || "(none)"}`);
      process.exit(1);
    }
    return;
  }

  if (args.providerAdd) {
    const p: Provider = addProvider(cfg, args.providerAdd as string, args.providerBaseURL as string, (args.providerKey as string) || undefined);
    console.log(`Added provider "${p.name}" → ${p.baseURL}`);
    try {
      const ids = await fetchProviderModels(p, apiKeySource(p.name, p).key || undefined);
      mergeProviderModels(p, ids);
      saveConfig(cfg);
      console.log(`  ${ids.length} models available — run with --provider ${p.name}`);
    } catch {
      console.log(`  no model list yet — set a key with: Ria provider key ${p.name}`);
    }
    return;
  }

  // First-run / missing-key setup. Only when there is no usable provider at
  // all — an explicit --provider/-m never triggers the wizard.
  const usable = listProviders(cfg).filter(([n, p]) => hasKey(n, p));
  if (!args.provider && !args.model && !args.p && !positional.length) {
    if (!usable.length || !cfg.onboarded) await ensureReady(cfg);
  }

  const resumeId = args.resume as string | undefined ?? (args.continueLast ? "latest" : undefined);
  if (args.p || positional.length) {
    const oneShotSkills = discoverSkills(cfg.skillsDirs ?? defaultSkillsDirs());
    const prompt = expandAttachments(expandSkillMentions(positional.join(" ").trim(), oneShotSkills));
    if (!prompt) { console.error('Usage: Ria -p "task"'); process.exit(1); }
    await runOneShot(cfg, args.provider as string, args.model as string, prompt, resumeId);
    return;
  }

  await runRepl(cfg, args.provider as string, args.model as string, resumeId);
}

main().catch((e) => { console.error(e); process.exit(1); });
