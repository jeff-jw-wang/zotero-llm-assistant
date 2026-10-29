# Architecture

## Overview

`zotero-llm-assistant` is a **bootstrapped XPI plugin** for Zotero 7/8. It registers a
collapsible chat panel in the PDF reader sidebar and connects it to configurable LLM providers.

```
Zotero Desktop App
└── LLM Assistant XPI
    ├── Reader sidebar panel  ← primary UI surface
    │   ├── Privacy toggle
    │   └── Chat interface (streaming)
    ├── Preference pane       ← Zotero > Settings > LLM Assistant
    └── IndexedDB             ← conversation history + privacy flags
```

---

## Plugin Bootstrap

Zotero 7/8 plugins use a `bootstrap.js` + `manifest.json` architecture (WebExtension-like).

```
Zotero starts
  → bootstrap.startup()
      → installs chrome URI for plugin content
      → loads compiled JS (addon/content/scripts/zotero-llm-assistant.js)
      → registers Addon instance as Zotero.ZoteroLLMAssistant
  → hooks.onStartup()
      → waits for Zotero.uiReadyPromise
      → initLocale()           — loads FTL files
      → registerReaderPanel()  — registers sidebar section
  → hooks.onMainWindowLoad()
      → creates ztoolkit instance
      → loads mainWindow.ftl
```

---

## Reader Panel Lifecycle

The panel is registered via `Zotero.ItemPaneManager.registerSection()`. Zotero calls the
registered callbacks as the user interacts with items:

```
onItemChange(tabType, item) → setEnabled(tabType === "reader")
                             → clearItemCache()  (pipeline extraction/chunk cache)
  ↓ (only fires for PDF reader tabs)
onRender(body, item) → renderPanel(body, item)
  ↓
  isOnboardingDone? → renderOnboarding (first run only)
               ↓ yes
  renderChatUI(container, doc, item)
    → load conversation from IndexedDB
    → render history: assistant messages through citation parser,
                      user messages as plain bubbles
    → attach send handler
    → handleQuestion() on each question
```

### handleQuestion() Flow

```
User submits question
  → createProvider()           — reads prefs, returns ILLMProvider
  → checkPrivacy()             — blocks cloud call if item/global restricted
  → buildRAGContext(item, q)   — pipeline: extract → chunk → score → select → build prompt
                               — returns { messages, chunkWhitelist, stats }
  → provider.chatStream()     — async generator yielding StreamChunk
  → renderResponseWithCitations() on each chunk
      → [c.ID] in whitelist   → <a> link showing [pp.X-Y], click → openPDFAtPage
      → [c.ID] not in list    → <span> strikethrough + "Citation not in source"
      → [p.N] (legacy)        → <span> styled text, not clickable
  → parseCitedChunkIds()       — extract cited IDs from response, deduplicated
  → appendMessage() to IndexedDB with sourceChunks (cited only)
```

---

## Data Flow Diagram

```
PDF Item
  │
  ▼
extractPDF(item)                         Zotero.FullText
  → pages: [{ page, text }]
  → totalPages: N
  → attachmentKey: string
  │
  ▼                                     ┌──────────────────────────────┐
chunkPages(pages, attachmentKey)        │ Per-item cache in pipeline   │
  → chunks: [{ id, text,               │ (extract+chunk cached by     │
  │   pageStart, pageEnd }]             │  itemId; cleared on change)  │
  │                                     └──────────────────────────────┘
  ▼
scoreChunks(chunks, question)
  → keyword overlap: +10 per matching word (>3 chars)
  → structural boost: abstract +80, introduction +80,
    conclusion +60, discussion +40, methods +20
  → position: first chunk +100, last chunk +50
  │
  ▼
selectChunks(scored, tokenBudget)
  → greedy fill: top-scoring chunks within budget
  → guard: if nothing fits, truncate top chunk
  → re-sort by page order for coherent reading
  │
  ▼
chunkWhitelist = Map<chunkId, { pageStart, pageEnd, excerpt }>
context = "[c.ID pp.X-Y]\ntext\n[/c.ID]\n..."
  │
  ▼
buildMessages(context, question, history)
  → [system]    You are a research assistant... cite [c.ID]...
  → [user]      <document>context</document>
  → [assistant] I have read the paper...
  → [user/asst] history...
  → [user]      current question
  │
  ▼
provider.chatStream(messages, options)   Ollama / Gemini
  → AsyncGenerator<StreamChunk>
  │
  ▼
renderResponseWithCitations(bubble, doc, text, chunkWhitelist)
  → combined regex for [c.ID] + [p.N] (legacy)
  → ID ∈ chunkWhitelist  → <a href="#"> [pp.X-Y] with excerpt tooltip
  → ID ∉ chunkWhitelist  → <span strikethrough> "Citation not in source"
  → [p.N] (Phase A)      → <span> styled, non-clickable, "Legacy page citation"
  │
  ▼
parseCitedChunkIds(fullResponse)
  → unique chunk IDs in order of first appearance
  → filter against chunkWhitelist → sourceChunks array
  │
  ▼
appendMessage(itemId, { role, content, sourceChunks })   IndexedDB
```

---

## Module Map

| Module | Responsibility |
|--------|---------------|
| `src/index.ts` | Plugin singleton; attaches to `Zotero.ZoteroLLMAssistant` |
| `src/addon.ts` | `Addon` class holding runtime data (config, ztoolkit, initialized flag) |
| `src/hooks.ts` | Zotero lifecycle events (startup, shutdown, window load/unload, prefs) |
| `src/prefs.ts` | All `Zotero.Prefs` reads/writes; single source of truth for setting keys |
| `src/utils/tokens.ts` | Token estimation (4 chars ≈ 1 token); topK derivation |
| `src/utils/url.ts` | SSRF validator for custom endpoints |
| `src/utils/locale.ts` | FTL localization helpers |
| `src/modules/llm/types.ts` | `ILLMProvider`, `LLMMessage`, `StreamChunk`, `ChatOptions` interfaces |
| `src/modules/llm/models.ts` | Model discovery + context-window/input-budget resolution |
| `src/modules/llm/client.ts` | Provider factory; model resolution; privacy enforcement; message builder; system prompt |
| `src/modules/llm/providers/ollama.ts` | Ollama (local, ndjson streaming) |
| `src/modules/llm/providers/gemini.ts` | Google Gemini (SSE streaming) |
| `src/modules/rag/extractor.ts` | PDF text extraction via Zotero.FullText; page splitting; attachment key |
| `src/modules/rag/chunker.ts` | Paragraph/window text chunking; FNV-1a content-hashed IDs; chunk ID regex |
| `src/modules/rag/pipeline.ts` | Context orchestrator: whole-paper mode when the text fits the budget, else chunk-RAG; per-item cache |
| `src/modules/storage/db.ts` | IndexedDB: conversations, privacy flags, embeddings (Phase D) |
| `src/modules/ui/readerPanel.ts` | Panel registration + full chat UI wiring; citation parsing; history rendering |
| `src/modules/ui/onboarding.ts` | First-run consent modal |
| `src/modules/ui/privacyToggle.ts` | Per-item cloud/private toggle |
| `src/modules/ui/settingsPane.ts` | Prefs pane: load/save, provider sections |
| `test/chunker.test.ts` | Deterministic tests for chunker, citation parsing, whitelist filtering |

---

## Storage Schema

All plugin data lives in IndexedDB database `zotero-llm-assistant` (version 1).

### `conversations` store (keyPath: `itemId`)

```typescript
{
  itemId: number,          // Zotero item ID
  messages: Array<{
    role: "system" | "user" | "assistant",
    content: string,
    timestamp: string,     // ISO 8601
    sourceChunks?: Array<{
      chunkId: string,     // FNV-1a content hash (8-char hex or hex-N)
      pageStart: number,   // 1-based
      pageEnd: number,
      excerpt: string      // first ~80 chars of chunk text
    }>
  }>
}
```

`sourceChunks` is populated on assistant messages only, and only when the LLM
actually cited chunks from the whitelist. Old messages from Phase A (without
`sourceChunks`) continue to work — the history renderer falls back to the
legacy `[p.N]` regex for styled (non-clickable) display.

### `privacy` store (keyPath: `itemId`)

```typescript
{ itemId: number, isPrivate: boolean, updatedAt: string }
```

### `embeddings` store (Phase D, keyPath: `chunkId`)

```typescript
{ chunkId: string, itemId: number, vector: Float32Array, updatedAt: string }
```

---

## Library Retrieval

Library questions send **metadata only** — title, authors, year, abstract and a
`zotero://` link per match. Full texts are never sent on this path.

Retrieval is hybrid. Keyword and semantic ranking run **independently over the
whole library**, then fuse by Reciprocal Rank Fusion:

```
score(item) = Σ over lists  1 / (60 + rank_in_that_list)
```

This replaced a design where keyword score was a *gate*: only items with
`score > 0` entered a shortlist, and semantic similarity merely re-ranked those
survivors. An item sharing no literal word with the query was therefore
eliminated before embeddings were consulted — so conceptual questions, the
whole reason the feature exists, returned little. Keyword matching is now a
contributor, not a filter.

RRF is used rather than a weighted sum because keyword scores (unbounded
integers) and cosine similarities (−1..1) are on incomparable scales, while
ranks are comparable by construction.

Semantic coverage grows in the background (`startBackgroundEmbedding`), so a
fresh library starts keyword-only and improves as indexing proceeds;
`SearchDiagnostics.semanticCovered` reports progress.

### Embedding method versioning

Vectors are comparable only within one embedding *method*. `EMBEDDING_METHOD_VERSION`
in `embedder.ts` is bumped whenever the text→vector transformation changes, and
the cache is cleared and rebuilt — mixing methods in one cosine ranking
degrades retrieval silently. Method v2 windows long inputs and mean-pools them,
fixing a bug where chunks (~512 tokens) were silently truncated to the model's
256-token limit, so roughly half of every chunk never reached the encoder.

### Answer grounding

The model is instructed to keep metadata-grounded claims separate from claims
it recalls about papers it recognises, using a fixed section heading. The UI
renders the recalled section in a distinct block labelled "not verified against
your library". A missing heading degrades safely — the text renders as grounded,
as it did before the contract existed. `zotero://` links stay whitelisted to
keys actually sent, in both sections.

## Privacy Model

Default state: **paper content is never sent to cloud APIs**.

```
Global toggle (Zotero Prefs)
  privacy.cloudSharingEnabled = false (default)

Per-item flag (IndexedDB)
  isPrivate: true → override: block cloud even when global=true

checkPrivacy(provider, itemId):
  if provider.isCloud === false → always allowed (Ollama)
  if global == false → block with "Cloud sharing is disabled"
  if itemPrivate == true → block with "This paper is marked private"
  → null (allowed)
```

---

## Prompt Caching and Context Modes

The plugin picks one of two context modes per request, in `pipeline.ts`:

| | whole-paper | chunk-rag |
|---|---|---|
| When | full text + overhead fits the input budget | it does not |
| Document block | entire paper, page-marked `[p.N]` | selected chunks, `[c.ID pp.X-Y]` |
| Stable across turns? | **yes** — question-independent | no — selection depends on the question |
| Citations | `[p.N]`, validated against page count | `[c.ID]`, validated against the chunk whitelist |

Whole-paper mode exists because the previous design could never hit a prompt
cache. Chunk scoring depends on the question, so the document block changed
every turn, so the cacheable prefix changed every turn, and every question
re-paid full input price for its context. Making the document block
question-independent is what unlocks caching.

Message order is therefore stable-first:

```
[system]     guardrails + citation scheme    ─┐ cache breakpoint
[user]       <document> … paper text …       ─┘ cache breakpoint
[assistant]  fixed acknowledgement
[history]    grows each turn
[user]       the current question              volatile
```

`LLMMessage.cacheable` marks a breakpoint. Providers interpret it differently:

| Provider | Mechanism |
|---|---|
| Anthropic | explicit `cache_control: {type: "ephemeral", ttl: "1h"}`; reads ≈0.1x, writes ≈1.25x |
| OpenAI | automatic prefix caching — no flag, just needs the prefix to be stable |
| Gemini | implicit caching, on by default for 2.5+ models |
| Ollama | no token cost, but llama.cpp reuses the KV cache, so follow-ups are faster |

The diagnostics footer reports `cache N read / M written` when the provider
supplies it. **If `read` stays at 0 across turns of one conversation, caching
is not working** — something is invalidating the prefix. `test/caching.test.ts`
guards the prefix-stability property directly.

## Citation Safety

Citations use a **chunk-based whitelist** system. The `chunkWhitelist` is a
`Map<string, ChunkMeta>` built from the chunks **actually included in the
prompt sent to the LLM**. It is the only authoritative source for verifying
citations.

### How it works

1. **Pipeline** extracts PDF, chunks it, selects top chunks for the prompt
2. Each selected chunk gets a content-hashed ID (FNV-1a of attachment key +
   page range + full text) — deterministic but resilient to chunker changes
3. The LLM receives chunks wrapped as `[c.ID pp.X-Y]\ntext\n[/c.ID]`
4. The system prompt instructs the LLM to cite using `[c.ID]` markers
5. Response parser checks each `[c.ID]` against `chunkWhitelist`:
   - **In whitelist** → clickable `[pp.X-Y]` link, opens PDF at that page;
     tooltip shows chunk excerpt
   - **Not in whitelist** → strikethrough `<span>` with "Citation not in source"
6. Only **cited** chunk IDs (those appearing in the response AND in the
   whitelist) are persisted in `sourceChunks` — accurate provenance

### Backward compatibility (Phase A → B)

- Old assistant messages with `[p.N]` markers and no `sourceChunks` are
  rendered through the citation parser with an empty chunk whitelist
- The combined regex matches both `[c.ID]` and `[p.N]` patterns
- Legacy `[p.N]` markers appear as styled text (blue, smaller font) with
  "Legacy page citation" tooltip — not clickable (no original whitelist)
- This is safe: showing `[p.5]` as styled text is better than hiding it

### Chunk ID stability

- IDs are content-hashed (FNV-1a of full text), not positional
- If the chunker algorithm changes, new queries get new IDs
- Old `sourceChunks` in stored messages carry their own `pageStart`/`pageEnd`
  — the UI does not need to re-resolve IDs against the current chunker output
- Collision handling: if two chunks hash to the same ID, suffixes are appended
  (`a3f7c012`, `a3f7c012-1`, etc.)

---

## Open Spikes (to be resolved during development)

| ID | Question | Current approach | If fails |
|----|----------|-----------------|----------|
| S1 | Can pdfjs-dist v4 bundle in Zotero's XULRunner? | Zotero.FullText (native) — already used | N/A, already on fallback |
| S2 | Is IndexedDB shared across main window + reader panel + Web Workers? | Using IndexedDB from panel body context | Migrate to Zotero.DB.queryAsync() |
| S3 | Does Zotero 7/8 support Web Workers? | Not used in Phase A | Phase D: main-thread async fallback |
| S4 | Does `reader.navigate({pageNumber})` work reliably? | Used with `as any` cast + deep link fallback | Document limitations |

Record spike outcomes in this file and in `docs/ZOTERO_API.md`.
