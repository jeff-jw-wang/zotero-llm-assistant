# Zotero LLM Assistant — Development Roadmap

**Current stable**: `v0.1.0` (tag on `main`)
**Active development**: `develop` branch
**Branch strategy**: `main` = releases only · `develop` = integration · `fix/*` / `feat/*` = feature branches

---

## Version Control Convention

```
main        ← only tagged releases (v0.1.0, v0.2.0, …)
  └─ develop  ← integration branch; all PRs merge here
       ├─ fix/semantic-search-runtime
       ├─ fix/ollama-transport
       ├─ feat/conversation-persistence
       └─ …
```

- **Patch** (`0.1.x`): bug fixes only, no new features
- **Minor** (`0.x.0`): new features, backward-compatible
- **Major** (`x.0.0`): breaking changes or major architecture shifts

```bash
# Start a fix
git checkout -b fix/ollama-transport develop

# Start a feature
git checkout -b feat/conversation-persistence develop

# Merge back when done
git checkout develop && git merge --no-ff fix/ollama-transport

# Cut a release
git checkout main && git merge --no-ff develop
git tag v0.1.1 && git push origin main --tags
```

---

## Issue Tracker

### Severity

| Label | Meaning |
|-------|---------|
| 🔴 P0 | Plugin non-functional for this case |
| 🟠 P1 | Major feature broken or severe UX degradation |
| 🟡 P2 | Noticeable limitation, workaround exists |
| 🟢 P3 | Enhancement / nice-to-have |

| # | Issue | Severity |
|---|-------|----------|
| 1 | Semantic search fails on download | 🔴 P0 |
| 2 | OpenAI/Claude "streaming failed" flash before fallback | 🟠 P1 |
| 3 | Ollama (local) not connecting | 🔴 P0 |
| 4 | Conversations lost on Zotero restart | 🟠 P1 |
| 5 | Side panel height edge cases (scroll loss on re-render) | 🟡 P2 |
| 6 | Auto-scroll misses in specific edge cases | 🟡 P2 |
| 7 | Input field doesn't word-wrap | 🟡 P2 |
| 8 | Can't copy text from conversation | 🟡 P2 |
| 9 | Support ChatGPT/Claude subscription auth (OAuth) | 🟢 P3 |
| 10 | Free Gemini API hits quota on first message | 🟠 P1 |
| 11 | Full paper context sent on every follow-up message | 🟠 P1 |
| 12 | Citation links go to page only, not paragraph/sentence | 🟡 P2 |
| 13 | LLM can't access Zotero library | 🟠 P1 |
| 14 | Can't cross-reference or navigate to another paper | 🟢 P3 |
| 15 | Security gaps: log redaction, retention policy, endpoint policy | 🟡 P2 |

---

## Corrected Root Cause Analysis

### #1 — Semantic Search: download failure
**What was wrong in earlier analysis**: The error "console is not defined" was
incorrectly identified as the root cause. `embedder.ts` does not call `console` —
it uses `ztoolkit.log()` and a `progress_callback` pattern throughout. No `console`
calls exist in the file.

**Actual root causes** (three independent failure modes):

1. **Dynamic import resolution failure**: `MainThreadRunner.loadPipeline()` does:
   ```ts
   const { pipeline } = await import("@huggingface/transformers");
   ```
   In Zotero's XULRunner (a privileged chrome context), dynamic `import()` of npm
   packages may fail because the module specifier cannot be resolved against
   `chrome://` or `resource://` URLs. esbuild bundles the package at build time,
   but the import path inside the bundle may not match what XULRunner expects.
   This is the most likely cause of "Download failed: console is not defined"
   (the error comes *from inside* Transformers.js when it tries to use `console`
   internally — it's Transformers.js's own logging, not our code).

2. **Model cache via IndexedDB**: Transformers.js caches the ONNX model in IndexedDB.
   As established (Issue #4), IndexedDB is unavailable in the reader panel context.
   If the download succeeds but the cache write fails, the next session re-downloads.
   If `ensureModelReady()` is called from the reader panel, the cache write throws.

3. **Worker creation**: `WorkerRunner` is stubbed — `getRunner()` always falls back
   to `MainThreadRunner`. This is intentional but means heavy inference blocks
   the main thread, which can cause Zotero to appear frozen during download.

**Fix strategy**:
- Call `ensureModelReady()` only from the **main window** (hooks.ts startup), never
  from reader panel.
- Gate the download UI in Settings pane, which runs in the main window context.
- Configure esbuild to bundle Transformers.js as a single self-contained chunk
  accessible from a `resource://` URL.
- Add `env.allowLocalModels = false` and `env.backends.onnx.wasm.numThreads = 1`
  to Transformers.js env config before any pipeline call, to prevent it from
  trying to spawn workers or load from filesystem paths.

---

### #2 — "Streaming failed" flash before fallback
**Root cause**: `chatStream()` in cloud providers uses `fetch()` + `ReadableStream`.
The Streams API is not reliably supported in Zotero's XULRunner `fetch()`.
The user-implemented `withTimeout()` catches the failure and retries with `chat()`
(which uses `Zotero.HTTP.request()`), but the error message is displayed to the user
during the ~1s gap between the stream failure and the fallback result arriving.

This is an SSE transport instability issue, not a model or API failure.

**Fix strategy** (two-level):
- **Immediate** (v0.1.1): Catch streaming errors silently in the UI; show a neutral
  "Thinking…" indicator until the non-stream result is ready. Never show the
  "streaming failed" string to the user.
- **Long-term** (v0.2.0): Remove streaming from cloud providers entirely.
  Use `Zotero.HTTP.request()` for all API calls and simulate a typewriter effect
  by rendering the complete response word-by-word with `setTimeout`. Reliable,
  no streaming required, indistinguishable to the user.

Non-stream fallback is the **primary reliability path**; streaming is a future
enhancement, not a requirement.

---

### #3 — Ollama not connecting
**Root cause**: Ollama's `chat()` and `isAvailable()` use `fetch("http://localhost:11434/...")`.
In Zotero's privileged chrome context, `fetch()` to non-HTTPS localhost is subject
to Mozilla's CSP and mixed-content policies, which can block or silently fail the
request. `Zotero.HTTP.request()` uses `XMLHttpRequest` which is exempt from these
restrictions and properly routes through the system network stack.

**Fix**: Apply the same `httpPost/httpGet` from `src/utils/http.ts` that was already
applied to OpenAI, Gemini, Anthropic. For streaming, use XHR's `onprogress` event
to consume partial NDJSON responses from Ollama's `/api/chat` stream endpoint.

---

### #4 — Conversations lost on restart
**Root cause**: `getConversation()` and `dbAppendMessage()` call `getDB()`, which
opens IndexedDB via `(globalThis as any).indexedDB`. In the reader panel's privileged
chrome frame, `indexedDB` is `undefined`. The `withTimeout()` wrapper in
`renderChatUI()` swallows the failure silently — the UI degrades to empty state,
but nothing is ever written to disk.

**Fix**: Replace IndexedDB with `Zotero.DB.queryAsync()` as the storage backend.
SQLite via `Zotero.DB` is accessible from any Zotero context (main window, reader
panel, background tasks). Schema: two tables —
- `llm_conversations(id, itemID, createdAt, updatedAt)`
- `llm_messages(id, conversationID, role, content, chunkIDs, timestamp)`

Provide a migration path: on first load, if IndexedDB is available, migrate
existing conversations to SQLite and clear IndexedDB.

---

### #5 & #6 — Panel height and auto-scroll edge cases
**What was wrong in earlier analysis**: The panel already has correct flex layout
(`#llm-root: flex-direction:column; height:100%`, `#llm-body: flex:1; overflow:hidden`,
`#llm-messages: flex:1; overflow-y:auto`). `scrollTop = scrollHeight` is already
called in 6 locations after every message append. These are not structural absences.

**Actual edge cases that need fixing**:

1. **Re-render resets scroll position**: `onRender` calls `renderPanel()` which calls
   `renderChatUI()` which does `container.innerHTML = ""` — wiping the entire chat
   and rebuilding it from DB. If `onRender` fires while the user is mid-conversation
   (e.g. they switch tabs and switch back), scroll resets to top and in-progress
   responses are lost.
   **Fix**: Guard `renderChatUI` with a "already rendered" flag on the container;
   skip re-render if chat is already initialized for this item.

2. **Scroll timing**: `scrollTop = scrollHeight` is set synchronously during streaming
   token appends, but layout may not have updated yet. In some cases the measured
   `scrollHeight` is stale.
   **Fix**: Replace direct `scrollTop` assignment with
   `requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; })` to ensure
   layout has completed.

---

### #7 — Input doesn't wrap
**Root cause**: `<html:input type="text">` is inherently single-line.
**Fix**: Replace with `<html:textarea>` with `rows="2"`, styled to auto-grow
up to 5 rows. Ctrl+Enter sends; plain Enter adds a newline.

---

### #8 — Can't copy text
**Root cause**: XUL chrome windows apply `-moz-user-select: none` to most elements.
**Fix**: Add `user-select: text; -moz-user-select: text;` to `#llm-messages` CSS.
Add a 📋 icon button per assistant message bubble for one-click copy.

---

### #10 & #11 — Token budget and context cost
**Root cause**: The RAG pipeline rebuilds and sends the full top-K chunks on every
message, regardless of provider tier or whether this is a follow-up question.
On Gemini free tier (32K tokens/minute), a single request with 20 chunks × 512
tokens can consume the entire per-minute budget.

**Fix — per-provider token budget** (v0.1.1):
Add `maxContextTokens` per provider in `pipeline.ts`:
```
Ollama:            unlimited (local)
Gemini free:        8,000 tokens  (~16 chunks)
Gemini paid:      100,000 tokens
OpenAI gpt-4o-mini: 20,000 tokens
OpenAI gpt-4o:      50,000 tokens
Anthropic:          50,000 tokens
```
Reduce `topK` dynamically to fit within budget.

**Fix — adaptive context management** (v0.2.0):
Use a **rolling context** strategy with strict guardrails against grounding degradation:
- First message: run full RAG, cache the selected chunk set and compute a session
  centroid embedding from the selected chunks.
- Follow-up messages: reuse cached chunks **only if** all three conditions hold:
  1. Cosine similarity of new question embedding vs. session centroid ≥ 0.72
  2. Question does not contain explicit location/citation keywords
     ("where", "page", "section", "figure", "table", "cite", "reference", "according to")
  3. Fewer than 6 turns since last RAG run
  If any condition fails → re-run full RAG for the new question.
- After 4+ turns: generate a rolling summary of the oldest 2 turns to compress history.
  Keep the 2 most recent turns verbatim; summarize the rest.
- Expose a "New Topic" button to force an unconditional RAG reset.

Hard rule: **always prefer false negatives over false positives** on the reuse decision.
When in doubt, re-run RAG. The cost of a missed context is worse than a redundant retrieval.

---

### #12 — Imprecise citations
**Root cause**: Chunks store `pageNumber` but not sub-page location.

**What is and isn't achievable**:
- `Zotero.FullText.getItemContent()` returns raw text with form-feed page breaks.
  It does **not** expose PDF geometry (bounding boxes, line positions, rects).
- `Zotero.Reader` accepts `{ pageIndex, position: { rects } }` for rect-based
  navigation, but rects require PDF geometry data we do not have from the text extractor.
- Sentence-accurate navigation is therefore **not achievable** without a full PDF
  geometry pipeline (PDF.js position mapping), which is out of scope until v0.4.0+.

**Best-effort fix** (v0.3.0):
- Record approximate character offset (`charStart`) per chunk within the page's
  raw text string during extraction.
- On citation click: navigate to the correct page (`pageIndex`) and pass a
  text search hint (first 60 chars of chunk) to `reader.navigate()` using
  Zotero's find/highlight API if available, or scroll to page as fallback.
- Label citations in the UI as "~page N" to set correct user expectations.
  Do not imply sentence-level accuracy.

Guaranteed: correct page. Best-effort: approximate paragraph highlight.
Sentence-accurate rect navigation deferred to v0.4.0+ pending PDF geometry work.

---

### #13 — Library indexer not working
**What was wrong in earlier analysis**: The Zotero Web API fallback was proposed
as a first-line fix. This adds OAuth complexity, sync dependency, and a new
privacy surface (the API key, if used, grants broad read access to the library).
It should not be the primary fix.

**Actual root causes** (needs investigation):
- The `LibraryIndexer` registers a Zotero notifier on startup. The notifier
  `notify()` callback may not fire for items already in the library — only for
  changes after startup.
- Initial full-library scan may fail silently if `Zotero.Items.getAll()` is
  called before Zotero's database is fully loaded.

**Fix strategy** (v0.3.0):

**Surface distinction** — reader chat and library chat are different UX surfaces
and must handle "no library access" differently:
- **Reader panel**: The LLM should never claim it "cannot access your library".
  Instead, add an explicit action button **"Search my library for this topic"** which
  triggers a library search for the current question and injects matching item
  metadata into the next message context. The LLM has no ambient library access
  by default — it only receives library context when the user explicitly requests it.
- **Library panel**: Show a clear status badge: "Index ready (N items)" or
  "Library index unavailable — [Rebuild]". The panel is disabled with a
  descriptive message when the index is empty, rather than passing the empty
  index to the LLM and letting it confabulate.

1. **Immediate UX**: Status badge + "Rebuild Index" button in library panel header.
   Disable the library chat input when index is empty (not zero results — truly empty).
2. **Proper fix**: Wait for `Zotero.Schema.schemaUpdatePromise` before initial scan.
   Force a full scan on first startup; use notifier for incremental updates thereafter.
3. **Web API as optional enhancement** only (not fallback): let users optionally
   enter a Zotero API key in settings to supplement local search with cloud-synced items.

---

### #14 — Intra-library cross-paper navigation
**Prerequisite**: Library indexer (#13) must work first.
**Planned for v0.3.0**: Once the index is reliable, add:
- Cross-paper reference detection in LLM responses (match cited titles to library items)
- `Zotero.Reader.open(item)` + navigate to position
- "Open in Zotero" links in chat responses

---

### #15 — Security gaps
**Existing mitigations** (already implemented, sound):
- SSRF: HTTPS-only + private IP blocklist + DNS preflight in `url.ts`
- Prompt injection: `<document>` delimiters + "untrusted" system prompt marker
- Citation whitelist: only extractor-provided chunk IDs rendered as links

**Gaps to address** (v0.4.0):
- **Log redaction**: API keys must never appear in `Zotero.log()` output.
  Add a `redactKey(s: string): string` helper that masks all but the last 4 chars.
- **Data retention policy**: Document how long conversations are stored locally.
  Add a "Clear all conversations" button in settings.
- **Endpoint allowlist policy**: Custom endpoint validation currently only blocks
  private IPs. Should also warn when pointing to non-standard ports.
- **Shared-machine warning**: If Zotero profile is on a network drive or shared
  location, show a warning that API keys may be visible to other users.
- **Library-wide prompt threat model**: When library search sends metadata from
  many items to an LLM, an attacker could inject instructions via a paper title
  or abstract. Document this in `SECURITY.md` and add a metadata sanitization
  step before constructing library search prompts.

---

## Release Roadmap

---

### v0.1.1a — P0 Reliability Only
**Branch**: `fix/v0.1.1a` off `develop`
**Scope**: Three P0 crashes + free-tier quota blocker. No UX changes.
**Estimated effort**: 1–2 days

| Task | File(s) | Issue |
|------|---------|-------|
| Fix Transformers.js runtime: set `env` flags before pipeline; call `ensureModelReady()` only from main window | `embedder.ts`, `hooks.ts`, `settingsPane.ts` | #1 |
| Move Ollama `chat()` + `isAvailable()` to `httpPost/httpGet` | `ollama.ts` | #3 |
| Add XHR `onprogress` streaming for Ollama NDJSON | `ollama.ts` | #3 |
| Silent streaming fallback — replace "streaming failed" with neutral "Thinking…" | `readerPanel.ts` | #2 |
| Per-provider `maxContextTokens` + dynamic topK cap | `pipeline.ts`, `prefs.ts` | #10 |
| Provider diagnostics note in chat footer (provider · endpoint · mode) | `readerPanel.ts` | — |

**Provider diagnostics**: After each response, show a small collapsed footer:
`ℹ gpt-4o-mini · api.openai.com · non-stream · 4,231 tokens`
This makes debugging fast without cluttering the main UI.

**Release gate for v0.1.1a**:
- [ ] Semantic search download completes from Settings pane without error
- [ ] Ollama responds to a question about an open PDF
- [ ] OpenAI/Anthropic respond — zero error messages shown to user
- [ ] Free Gemini API does not hit quota on a 30-page PDF
- [ ] Diagnostics footer shows correct provider, endpoint, and mode
- [ ] `npm run build` passes with zero type errors

**Rollback criteria**: If any P0 check fails after merge to `develop`, revert the
specific commit (not the whole branch) and re-open the issue.

---

### v0.1.1b — P2 UX Bundle
**Branch**: `fix/v0.1.1b` off `develop` (requires v0.1.1a merged first)
**Scope**: Input, copy, scroll edge cases. No new features.
**Estimated effort**: 1 day

| Task | File(s) | Issue |
|------|---------|-------|
| Guard `renderChatUI` against re-render wipe during active session | `readerPanel.ts` | #5 |
| `requestAnimationFrame` for scroll-to-bottom | `readerPanel.ts` | #6 |
| Replace `<input>` with auto-grow `<textarea>` (Ctrl+Enter sends) | `readerPanel.ts` | #7 |
| Enable `user-select: text` + per-message copy button | `readerPanel.ts` | #8 |

**Release gate for v0.1.1b**:
- [ ] Chat area maintains state when user switches tabs and returns
- [ ] Textarea wraps and expands up to 5 rows; Ctrl+Enter sends; Enter adds newline
- [ ] Can select and copy assistant response text
- [ ] Scroll jumps to bottom after every message (including mid-stream tokens)
- [ ] All v0.1.1a gate criteria still pass

---

### v0.2.0 — Persistence + Smart Context
**Branch**: `feat/v0.2.0` off `develop`
**Scope**: Conversations survive restarts; API costs drop for multi-turn sessions
**Estimated effort**: 4–5 days

| Task | File(s) | Issue |
|------|---------|-------|
| `Zotero.DB` conversation storage — replace IndexedDB | `db.ts`, `storage/zoterodb.ts` | #4 |
| Migration: IndexedDB → SQLite on first load | `db.ts` | #4 |
| Adaptive rolling context (cache chunks, rolling summary after 4+ turns) | `pipeline.ts`, `readerPanel.ts` | #11 |
| "New Topic" button to force RAG reset | `readerPanel.ts` | #11 |
| Typewriter rendering for non-stream responses | `readerPanel.ts` | #2 |
| Conversation history view (collapsible past sessions per paper) | `readerPanel.ts` | #4 |

**Key metric**: API token cost for a 10-turn conversation should drop ≥70% vs v0.1.0.

---

### v0.3.0 — Library Integration + Best-Effort Citations
**Branch**: `feat/v0.3.0` off `develop`
**Scope**: Working library access; citations jump to correct page with highlight attempt
**Estimated effort**: 5–7 days

| Task | File(s) | Issue |
|------|---------|-------|
| Wait for `Zotero.Schema.schemaUpdatePromise` before initial library scan | `indexer.ts` | #13 |
| Index status badge + "Rebuild Index" button in library panel | `libraryPanel.ts` | #13 |
| Disable library chat input when index empty; show descriptive message | `libraryPanel.ts` | #13 |
| "Search my library for this topic" action button in reader panel | `readerPanel.ts` | #13 |
| Best-effort page+highlight citation: `charStart` hint → `reader.navigate()` page jump + text search | `chunker.ts`, `extractor.ts`, `readerPanel.ts` | #12 |
| Label citations as "~page N" in UI (set correct user expectations) | `readerPanel.ts` | #12 |
| Cross-paper reference detection + `Zotero.Reader.open()` | `searcher.ts`, `libraryPanel.ts` | #14 |
| Markdown rendering in chat (bold, inline code, lists) | `readerPanel.ts` | — |
| Zotero Web API as optional supplement (settings opt-in, not default) | `library/api.ts` | #13 |

---

### v0.4.0 — Provider Expansion + Security Hardening
**Branch**: `feat/v0.4.0` off `develop`
**Scope**: Broader auth options; security gaps closed
**Estimated effort**: 5–7 days

| Task | File(s) | Issue |
|------|---------|-------|
| Gemini OAuth via Google Sign-In PKCE flow | `providers/gemini-oauth.ts` | #9 |
| API key redaction in all log output | `prefs.ts`, all providers | #15 |
| "Clear all conversations" button | `settingsPane.ts` | #15 |
| Data retention policy UI + docs | `settingsPane.ts`, `SECURITY.md` | #15 |
| Shared-machine warning in settings | `settingsPane.ts` | #15 |
| Library prompt metadata sanitization | `searcher.ts` | #15 |
| Dark mode CSS for chat panel | `readerPanel.ts` | — |

**Note on #9 (ChatGPT/Claude subscription OAuth)**: OpenAI and Anthropic do not
expose OAuth flows for consumer subscription accounts. Using stored cookies or
web scraping violates their Terms of Service. This feature is limited to
Gemini OAuth (supported via Google Identity). ChatGPT/Claude require API keys.

---

### v1.0.0 — Public Release
**Gate criteria** (all must pass before merging `develop` → `main`):
- All P0 and P1 issues resolved
- Full test suite green (chunker, pipeline, providers, storage)
- `docs/` fully updated to reflect current architecture
- Security review complete with sign-off in `SECURITY.md`
- Zotero plugin registry submission PR open
