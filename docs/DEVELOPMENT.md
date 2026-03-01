# Development Guide

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 18 | LTS recommended |
| npm | ≥ 9 | bundled with Node |
| Zotero | 7.x or 8.x | desktop app, not Zotero Web |
| Ollama | any | optional, for local-only testing |

## Quick Start

```bash
# 1. Clone and install dependencies
git clone <repo-url>
cd zotero-llm-assistant
npm install

# 2. Build the XPI
npm run build
# → .scaffold/build/zotero-llm-assistant.xpi

# 3. Install in Zotero
# Zotero > Tools > Add-ons > (gear icon) > Install Add-on From File
# Select .scaffold/build/zotero-llm-assistant.xpi
```

## Hot-Reload Development

Requires a running Zotero instance with the `zotero-plugin-scaffold` watcher:

```bash
npm start
```

This watches `src/` and `addon/` for changes, rebuilds, and triggers a hot-reload in Zotero.
You must set the `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` environment variable (or pass via `.env`) pointing to your Zotero binary.

Create a `.env` file (see `.env.example`):
```
ZOTERO_PLUGIN_ZOTERO_BIN_PATH=/Applications/Zotero.app/Contents/MacOS/zotero
ZOTERO_PLUGIN_DATA_DIR=~/Zotero
ZOTERO_PLUGIN_PROFILE_PATH=~/Zotero/Profiles/dev.profile
```

## Build Output

```
.scaffold/build/
├── addon/                     # Unpacked addon (mirrors addon/ with substitutions)
│   ├── bootstrap.js
│   ├── manifest.json          # with version, addonID, etc. substituted
│   ├── prefs.js
│   ├── content/
│   │   ├── preferences.xhtml  # with __addonRef__ substituted
│   │   └── scripts/
│   │       └── zotero-llm-assistant.js   # esbuild bundle of src/
│   └── locale/
└── zotero-llm-assistant.xpi   # zip of addon/
```

## TypeScript

The project uses TypeScript 5.x with `zotero-types` providing Zotero API type definitions.

```bash
# Type-check only (no emit)
npx tsc --noEmit

# The build runs this automatically; a failed type-check fails the build
npm run build
```

Key tsconfig notes:
- `"extends": "zotero-types/entries/sandbox/"` — provides Zotero globals (`Zotero`, `ztoolkit`, etc.)
- `"lib": ["ESNext"]` — no DOM lib; use `(globalThis as any).indexedDB`, `(reader as ReadableStreamDefaultReader<T>)`, etc. for browser APIs
- `"strict": true` (inherited) — all strict TypeScript checks enabled

## Directory Structure

```
src/
├── index.ts                   # Plugin entry point — singleton init
├── addon.ts                   # Addon class (data, hooks, api)
├── hooks.ts                   # Zotero lifecycle: startup, shutdown, window load
├── prefs.ts                   # Typed Zotero.Prefs wrappers (all plugin settings)
│
├── modules/
│   ├── llm/
│   │   ├── types.ts           # ILLMProvider, LLMMessage, StreamChunk interfaces
│   │   ├── client.ts          # Provider factory, privacy enforcement, message builder
│   │   └── providers/
│   │       ├── ollama.ts      # Ollama (local) — OpenAI-compatible ndjson streaming
│   │       ├── gemini.ts      # Google Gemini — REST + SSE streaming
│   │       ├── openai.ts      # OpenAI + custom OpenAI-compatible endpoints (Phase C)
│   │       └── anthropic.ts   # Anthropic Claude (Phase C)
│   │
│   ├── rag/
│   │   └── extractor.ts       # PDF text extraction via Zotero.FullText; page markers; token cap
│   │
│   ├── storage/
│   │   └── db.ts              # IndexedDB wrapper: conversations, privacy flags
│   │
│   └── ui/
│       ├── readerPanel.ts     # Main chat panel (registered in PDF reader sidebar)
│       ├── onboarding.ts      # First-run privacy consent modal
│       ├── privacyToggle.ts   # Per-item cloud/private toggle in panel header
│       └── settingsPane.ts    # Preference pane behavior (show/hide, save, validate)
│
└── utils/
    ├── locale.ts              # FTL localization helpers
    ├── tokens.ts              # Token estimation and model caps
    ├── url.ts                 # SSRF validator (HTTPS, IP blocklists, DNS preflight)
    └── ztoolkit.ts            # ztoolkit factory
```

## Adding a New LLM Provider

See `docs/LLM_PROVIDERS.md` (coming in Phase C) for the step-by-step guide.
Short version: implement `ILLMProvider` in `src/modules/llm/providers/`, register it in
`client.ts:createProvider()`, add prefs in `prefs.ts` and `addon/prefs.js`, and add
UI fields in `preferences.xhtml` / `settingsPane.ts`.

## Release Process

Releases are tagged commits. GitHub Actions (Phase D) will build the XPI and attach it
to the release automatically. Until then:

```bash
# Bump version in package.json, then:
npm run build
# Attach .scaffold/build/zotero-llm-assistant.xpi to the GitHub release
```

## Debugging

Open Zotero's developer tools: **Tools > Developer > Run JavaScript** or
**Tools > Developer > Error Console**.

The plugin logs to the Zotero console under `[LLM Assistant]`:
```javascript
// In Zotero's Run JavaScript console:
Zotero.ZoteroLLMAssistant
// → the plugin instance (confirms it loaded)
```

All `ztoolkit.log(...)` calls appear in the error console.
