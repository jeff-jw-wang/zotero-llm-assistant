# Zotero LLM Assistant

AI-powered research assistant for Zotero — chat with papers, search your library, and jump to cited pages.

## Features

- **Chat with papers** — Ask questions about any PDF open in the reader; get streaming answers grounded in the document
- **Chunk-based RAG** — Papers are split into semantically meaningful chunks (~512 tokens); only the most relevant chunks are sent to the LLM
- **Clickable citations** — The LLM cites chunk IDs that resolve to page links; click to jump directly to the source page in the PDF
- **Library search** — Search your entire Zotero library by metadata (title, authors, tags, abstract) and ask questions across papers
- **Multi-provider LLM support** — Ollama (local, default), Google Gemini, OpenAI, Anthropic, or any OpenAI-compatible endpoint
- **Automatic model discovery** — model names and context windows are read from the provider at runtime, so defaults don't go stale between releases. Leave the model field empty for "use the best available"
- **Privacy-first** — Cloud sharing is OFF by default; per-item privacy flags let you protect sensitive papers from being sent to cloud APIs
- **Conversation history** — Stored locally in IndexedDB; conversations are per-paper and persist across sessions

## Requirements

- **Zotero 7** or newer (Zotero 6 is not supported)
- **An LLM provider** — either a local [Ollama](https://ollama.com/) instance or an API key for a cloud provider

## Download

> **[⬇ Download zotero-llm-assistant.xpi — v0.1.1b (latest release)](https://github.com/jeff-jw-wang/zotero-llm-assistant/releases/latest/download/zotero-llm-assistant.xpi)**

## Installation

1. Download the latest `.xpi` from the link above or from [Releases](https://github.com/jeff-jw-wang/zotero-llm-assistant/releases)
2. In Zotero: `Tools → Add-ons → ⚙️ → Install Add-on From File…`
3. Select the `.xpi` file and restart Zotero

## Quick Start

1. **Configure a provider** — Go to `Zotero → Settings → LLM Assistant` and select a provider:
   - **Ollama** (default): Install [Ollama](https://ollama.com/), pull a model (`ollama pull qwen3.5:4b` is a good fit for an 8 GB machine), and the plugin auto-detects it at `localhost:11434`
   - **Gemini**: Enter your [Google AI Studio](https://aistudio.google.com/apikey) API key
   - **OpenAI**: Enter your OpenAI API key
   - **Anthropic**: Enter your Anthropic API key
   - **Custom**: Enter any OpenAI-compatible endpoint URL and API key
2. **Pick a model** (optional) — Leave the Model field empty to auto-select the best available one, or press **Detect** to see what the provider offers and pin a specific model
3. **Open a paper** — Double-click any PDF in your library to open the reader
4. **Open the chat panel** — Click the LLM Assistant icon in the reader sidebar
5. **Ask a question** — Type a question and press Enter

## Building from Source

```bash
# Clone the repository
git clone https://github.com/jeff-jw-wang/zotero-llm-assistant.git
cd zotero-llm-assistant

# Install dependencies
npm install

# Build the XPI
npm run build
# Output: .scaffold/build/zotero-llm-assistant.xpi

# Development with hot-reload (requires Zotero path)
npm start
```

## Project Structure

```
src/
├── hooks.ts                    # Zotero lifecycle hooks (startup/shutdown)
├── prefs.ts                    # Preference getters/setters for all providers
├── modules/
│   ├── llm/
│   │   ├── client.ts           # Provider factory + message builder
│   │   ├── types.ts            # ILLMProvider interface, LLMMessage, etc.
│   │   └── providers/
│   │       ├── ollama.ts       # Ollama (local)
│   │       ├── gemini.ts       # Google Gemini
│   │       ├── openai.ts       # OpenAI + custom endpoints
│   │       └── anthropic.ts    # Anthropic Claude
│   ├── rag/
│   │   ├── extractor.ts        # PDF text extraction via Zotero FullText API
│   │   ├── chunker.ts          # Section-aware text chunking
│   │   └── pipeline.ts         # RAG orchestrator: extract → chunk → select → prompt
│   ├── library/
│   │   ├── indexer.ts          # In-memory metadata index + Zotero notifier
│   │   └── searcher.ts         # Keyword scoring + privacy-aware context builder
│   ├── storage/
│   │   └── db.ts               # IndexedDB: conversations, privacy flags
│   └── ui/
│       ├── readerPanel.ts      # PDF reader chat panel
│       ├── libraryPanel.ts     # Library search + chat panel
│       ├── settingsPane.ts     # Settings pane bindings
│       ├── onboarding.ts       # First-run setup flow
│       └── privacyToggle.ts    # Per-item privacy toggle
├── utils/
│   ├── http.ts                 # Zotero.HTTP.request wrapper with fetch fallback
│   ├── url.ts                  # SSRF validator for custom endpoints
│   ├── tokens.ts               # Token estimation utilities
│   └── locale.ts               # i18n helpers
addon/
├── bootstrap.js                # XPI bootstrap (startup/shutdown/install)
├── manifest.json               # Zotero addon manifest
├── content/preferences.xhtml   # Settings pane UI
└── locale/en-US/               # Localization strings
```

## Security

- **SSRF protection** — Custom endpoints are validated: HTTPS-only, private IP ranges blocked, hostname blocklist, DNS preflight check
- **Prompt injection defense** — Paper text is wrapped in `<document>` delimiters and marked as untrusted in the system prompt
- **Citation whitelisting** — Only chunk IDs/page numbers from the extractor are rendered as clickable links; the LLM cannot inject arbitrary links
- **API key storage** — Keys are stored in Zotero's preference system (plaintext); this is stated clearly in the UI as not suitable for shared machines

See [docs/SECURITY.md](docs/SECURITY.md) for the full threat model.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — System design, data flow, module map
- [Modernization plan](docs/MODERNIZATION_PLAN_2026.md) — October 2026 review and staged update plan
- [Development](docs/DEVELOPMENT.md) — Dev setup, build system, testing
- [Security](docs/SECURITY.md) — Threat model, SSRF policy, prompt injection defense
- [Zotero API](docs/ZOTERO_API.md) — Spike outcomes, undocumented APIs used
- [Contributing](docs/CONTRIBUTING.md) — How to contribute

## License

[AGPL-3.0-or-later](LICENSE)
