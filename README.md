<img width="2048" height="2048" alt="0217945865392069f6cd41e8514911883ec9f138006f90f876e68" src="https://github.com/user-attachments/assets/b0aac5ee-4dd4-4d1f-b88e-ddc2fcdb82f8" />


# Ria — token-lean AI coding agent (open source)

A token-lean, fast AI coding harness in the style of Claude Code / Amp / OpenCode.
Zero runtime dependencies — a single bundled file, or a standalone `ria.exe`.

**Bring your own key.** Ria ships with no API key and no default provider
account: you pick a provider (deepseek, qwen, glm, gpt, claude, gemini, …),
paste *your* key, and it stays in `~/.ria/config.json` on your machine (chmod
600). Nothing is sent anywhere except the provider you chose.

<img width="1163" height="367" alt="Screenshot 2026-11-13 212458" src="https://github.com/user-attachments/assets/e3fee495-c702-428f-9845-f92db490d8f7" />


## Why it's cheap on tokens

| Technique | How |
|---|---|
| Tiny system prompt | ~15 lines. No persona essays, no tool essays. |
| Skills on demand | Only skill *names + one-line descriptions* ship in the prompt. The model pulls full skill text with the `skill` tool only when it actually needs it. |
| Output caps | Tool results are clipped at ~10 KB; old tool outputs in long sessions are collapsed to keep context small. |
| Terse tool schemas | Compact JSON schemas, no redundant descriptions. |

## Install / build

### Windows installer (recommended)

Download `ria-setup-windows.zip` from [Releases](../../releases), extract it, run
**`installer.exe`**. It will:

1. copy `ria.exe` to `%USERPROFILE%\.ria\bin`
2. add that folder to your **user PATH** (registry-based, no `setx` truncation,
   broadcast to open shells), so `ria` works in any new cmd / PowerShell window
3. register an **Uninstall Ria** entry under *Apps & features*

To remove Ria: run the `uninstaller.exe` that the installer puts in
`%USERPROFILE%\.ria\bin` (or *Apps & features → Uninstall Ria*). Your
`config.json` and saved sessions are kept unless you explicitly confirm
deletion; `uninstaller.exe --purge` removes everything without asking.

Unsigned builds may trigger SmartScreen — choose *More info → Run anyway*.

### Build from source

```
npm install          # dev deps only (esbuild, typescript)
npm run build        # -> dist/cli.cjs
npm run build:exe    # -> dist/ria.exe (Node Single Executable, ~80 MB)
```

Optional: copy `dist\ria.exe` anywhere on your `PATH` (e.g. `C:\Users\<you>\bin`).

**Or let it do it for you:** the packaged exe (`dist\ria.exe`) self-installs.
Copy it once to `%USERPROFILE%\.ria\bin\ria.exe` and run it — it adds
`%USERPROFILE%\.ria\bin` to your **user PATH** automatically (registry-based,
no `setx` truncation, broadcast to open shells), so typing `ria` in any new
cmd / PowerShell window just launches it. Set `RIA_NO_PATH=1` to opt out.

Build the installer / uninstaller yourself:

```
powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1
# -> release\installer.exe + release\uninstaller.exe + release\ria-setup-windows.zip
```

## Usage

```
Ria                                  interactive REPL
Ria -p "task"                        one-shot (like claude -p)
Ria -m <model>                       override model (e.g. deepseek-chat)
Ria --provider <name>                override provider (deepseek, glm, openai, …)
Ria -c / --resume <id>               continue a saved session

Ria providers                        list configured providers + key status
Ria provider setup [name]            interactive: pick a provider, paste a key
Ria provider key <name> [apiKey]     set a key (prompted & masked if omitted)
Ria provider add <name> <baseURL> [apiKey]
                                     add any OpenAI-compatible API
Ria model add <provider> <modelId>   register a model
Ria models [provider]                live model list from the API's /models
Ria models --all | --stale           refresh every keyed provider / only stale lists
Ria models <provider> --prune        drop blank and duplicate model ids
Ria doctor                           check config, keys, PATH, skills
```

## First run

On the first launch (or when no provider has a key) a small wizard appears:

1. **Pick a provider** — filterable list of the built-ins plus `+ custom API`
   for any OpenAI-compatible URL.
2. **Paste your key** — masked input; it is saved only to `~/.ria/config.json`
   (or read later from `<PROVIDER>_API_KEY` env vars).
3. Ria verifies the key with one cheap call and pulls the live model list, so
   `/model` immediately shows every model your account can use.

## Built-in providers

| name | provider | models |
|---|---|---|
| `deepseek` | DeepSeek | deepseek-chat, deepseek-reasoner |
| `qwen` | Qwen (DashScope) | qwen3-coder-plus/flash, qwen-plus |
| `glm` | GLM (Z.ai) | glm-4.6, glm-4.5-air |
| `openai` | OpenAI (GPT) | gpt-5, gpt-5-mini |
| `anthropic` | Anthropic (Claude) | claude-sonnet-4-5, claude-opus-4-1, claude-haiku-4-5 |
| `gemini` | Google Gemini | gemini-2.5-pro, gemini-2.5-flash |
| `groq` | Groq | fetched live from /models |
| `openrouter` | OpenRouter | fetched live from /models |
| `xai` | xAI (Grok) | fetched live from /models |
| `moonshot` | Moonshot (Kimi) | fetched live from /models |
| `minimax` | MiniMax | fetched live from /models |
| `cerebras` | Cerebras | fetched live from /models |
| `mistral` | Mistral | fetched live from /models |
| `together` | Together AI | fetched live from /models |
| `fireworks` | Fireworks AI | fetched live from /models |
| `siliconflow` | SiliconFlow | fetched live from /models |
| `ollama` | Ollama (local) | no key needed |

Env keys also work and take precedence: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `ZAI_API_KEY`, `DASHSCOPE_API_KEY`,
`XAI_API_KEY`, `MOONSHOT_API_KEY`, `MINIMAX_API_KEY`, `CEREBRAS_API_KEY`,
`MISTRAL_API_KEY`, …

### Model aliases

Every built-in defines short names so `/model fast` works without typing a
full model id (pattern borrowed from Claude Code's per-provider model
aliases): `fast` / `coder` / `reasoner` / `flagship` resolve to that
provider's models — deepseek `fast`→`deepseek-chat`, anthropic
`coder`→`claude-sonnet-4-5`, and so on. Real model ids always win over
aliases, and you can override the map per provider in `~/.ria/config.json`:

```json
"deepseek": { "aliases": { "fast": "deepseek-reasoner" } }
```

### Key from a command (`apiKeyCommand`)

If you don't want the key on disk or in an env var, any provider can pull it
from a shell command — Claude Code's `apiKeyHelper` pattern:

```json
"deepseek": { "apiKeyCommand": "op read 'Private Vault/deepseek' --field credential" }
```

The command's stdout (trimmed) is used as the key whenever no config key or
env var is set, and cached for 5 minutes so a fast typist doesn't spawn a
process per turn. Tune the cache with `RIA_API_KEY_COMMAND_TTL_MS` (0
disables caching). Config key → env var → `apiKeyCommand`, in that fallback
order.

Not sure what's set up? `ria doctor` gives a one-screen health report —
config file, provider key sources, default-provider usability, PATH
registration (Windows), and skills directories — offline, no network calls.
Setting a key from the CLI (`Ria provider key <name>`) now also pulls the
provider's live model list right away, so the provider is usable without a
separate `Ria models` step.

## Keys / REPL commands

`/` opens a filterable command menu (type `pro` → Enter runs `/providers`).

| command | what it does |
|---|---|
| `/provider` | pick a provider (asks for a key when missing) |
| `/provider setup <name>` / `/provider key <name>` | set or replace a key |
| `/providers` | list providers + masked keys / env vars |
| `/doctor` | health check: config, key sources, PATH, skills |
| `/custom` | add any OpenAI-compatible URL + key |
| `/model` | model picker (configured models, live list, switch provider) |
| `/models` | fetch the provider's live model list (chat models only) |
| `/models --all-ids` | also show embeddings/speech/rerank, tagged by kind |
| `/models --prune` | drop blank and duplicate model ids |
| `/models --all` `/models --stale` | refresh every keyed provider / only stale lists |
| `/sessions` `/resume` `/search` | saved chats |
| `/context` `/compact` `/tokens` | context + usage control |
| `/save` `/clear` `/init` `/exit` | session & housekeeping |

Keys: **Enter** send · **Alt+Enter** (or `\`+Enter) new line ·
**↑↓** history · **Tab** complete · `/` command menu · **F12** or
**Ctrl+K** model picker · **F1** help · **Shift+Tab** cycle provider ·
**Ctrl+C** interrupt/clear · **Ctrl+D** exit.

Install: `dist\ria.exe` is copied to `~\.ria\bin` and that folder is added
to your user PATH, so `Ria` works in any new cmd/PowerShell window.

## Context management (compaction)

Long sessions stay usable without a giant bill. Three tiers, cheapest first:

1. **Bounded tool output** — a single tool result is capped at ~4k tokens
   (head + tail + a notice). A 100 KB file read costs ~4k, not 25k, and the
   model can re-read a narrower range if it needs more.
2. **Free release** — when context still crosses ~72% of the model's window,
   old tool outputs and skill bodies are replaced by short markers. No API call.
3. **Compaction ("compact skill")** — if that isn't enough, the older half of
   the conversation is summarised into a dense state block:

   ```
   ## Goal / ## Done / ## Verified / ## In progress / ## Constraints
   ```

   The session continues from that block; the system prompt and recent turns are
   kept verbatim. A 6-turn cooldown prevents re-summarising every message, and a
   compaction that wouldn't save space is skipped unless the session is badly
   over the window.

Context size the model actually sees is tracked by estimation, calibrated
against the provider's reported `prompt_tokens` (clamped, so fixed per-request
overhead can't fake a large context). `/context` shows the live figure and the
auto-compact threshold; `/compact` does it on demand.

Env: `RIA_CONTEXT_OVERRIDE=<tokens>` forces a smaller window (testing).

## Drag & drop

Drop a file or folder into the terminal and it's attached to your message:

- Small files (≤6 KB) are inlined into the prompt
- Larger files get a marker line — the agent reads them on demand with
  `read_file`, so dropping a huge file costs ~0 tokens upfront
- Folders get a contents listing; the agent explores with glob/grep/bash

## Providers (custom APIs)

Config lives at `~/.ria/config.json`. Add any OpenAI-compatible endpoint:

```
Ria provider add myapi https://api.example.com/v1 sk-...
Ria model add myapi their-model-id
```

**Portable installs:** set `RIA_HOME=<dir>` and config, saved sessions and the
`bin` folder all move under `<dir>` — a USB stick or a shared machine keeps
its own keys and history, untouched by the default install:

```
set RIA_HOME=D:\ria-data
ria doctor          # shows the active config path
```

or edit the config directly:

```json
"myapi": {
  "name": "My API",
  "baseURL": "https://api.example.com/v1",
  "apiKey": "sk-...",
  "models": { "model-id": { "context": 200000, "output": 8192 } }
}
```

API keys can also come from env: `MYAPI_API_KEY`.

Your providers survive upgrades: stored providers are merged with the
built-in list on every launch, so new built-ins appear without touching
your own entries.

## Tests

```
npm test          # unit suite (tools, tty UI, sessions, compaction, …)
npm run test:e2e  # drives the real built REPL through 18 end-to-end checks
```

## Skills

Skills are discovered from:

- `~/.config/opencode/skills/*/SKILL.md`
- `~/.claude/skills/*/SKILL.md`

(or override `skillsDirs` in the config). Your pre-installed skills
(`ai-video-editor`, `faceless-shorts`, `reverse-engineer-anything`) are
available automatically — the model loads their full text on demand via the
`skill` tool.

## Tools

`bash` (PowerShell on Windows) · `read_file` · `write_file` · `edit_file` ·
`glob` · `grep` · `skill`

Editing is verified, not assumed:

- `edit_file` matches exact text, then falls back to newline-normalised and
  whitespace-trimmed matching — so Windows CRLF files and LF from the model
  no longer fail silently.
- Failures are returned as failures and shown in red `✗`, so the model has to
  retry instead of claiming success.
- `write_file` creates parent directories.
- `glob` supports `**`, `*`, `?`, `{a,b}` and is separator-agnostic.


