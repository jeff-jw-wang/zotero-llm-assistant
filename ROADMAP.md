# Zotero LLM Assistant — Development Roadmap

**Current stable**: `v0.1.0` (tag on `main`)
**Active development**: `develop` branch
**Branch strategy**: `main` = releases only · `develop` = integration · `fix/*` / `feat/*` = feature branches

---

## Version Control Convention

```
main        ← only tagged releases (v0.1.0, v0.2.0, …)
  └─ develop  ← integration branch; all PRs merge here
       ├─ fix/streaming-fallback
       ├─ fix/ollama-fetch
       ├─ feat/conversation-persistence
       └─ …
```

- **Patch** (`0.1.x`): bug fixes only, no new features
- **Minor** (`0.x.0`): new features, backward-compatible
- **Major** (`x.0.0`): breaking changes or major architecture shifts

```bash
# Start a fix
git checkout -b fix/ollama-fetch develop

# Start a feature
git checkout -b feat/conversation-persistence develop

# Merge back when done
git checkout develop && git merge --no-ff fix/ollama-fetch

# Cut a release
git checkout main && git merge --no-ff develop
git tag v0.1.1 && git push origin main --tags
```

---

## Issue Tracker

### Severity Classification

| Label | Meaning |
|-------|---------|
| 🔴 P0 | Plugin non-functional for this case |
| 🟠 P1 | Major feature broken or severely poor UX |
| 🟡 P2 | Noticeable limitation, workaround exists |
| 🟢 P3 | Enhancement / nice-to-have |

| # | Issue | Severity | Root Cause |
|---|-------|----------|------------|
| 1 | Semantic search: "Download failed: console is not defined" | 🔴 P0 | `console` not available in Zotero's chrome context |
| 2 | OpenAI/Claude show "streaming failed" before succeeding | 🟠 P1 | `fetch()` Streams API unreliable in XULRunner; fallback works but flashes error |
| 3 | Ollama (local) not connecting | 🔴 P0 | `fetch()` to localhost HTTP may be blocked by Zotero's CSP; needs `Zotero.HTTP.request()` |
| 4 | Conversations lost on Zotero restart | 🟠 P1 | IndexedDB unavailable in reader panel context; writes fail silently |
| 5 | Side panel grows unbounded with chat history | 🟠 P1 | No fixed-height scroll container on chat area |
| 6 | Chat doesn't auto-scroll to latest message | 🟠 P1 | `scrollTop = scrollHeight` not called after message append |
| 7 | Input field doesn't word-wrap | 🟡 P2 | Uses `<input type="text">` instead of `<textarea>` |
| 8 | Can't copy text from conversation | 🟡 P2 | `user-select` disabled in chrome context by default |
| 9 | Support ChatGPT/Claude subscription (not just API) | 🟢 P3 | Would need OAuth or browser-cookie injection; violates ToS for scraping |
| 10 | Free Gemini API hits quota on first message | 🟠 P1 | All chunks sent regardless of provider; no per-provider token budget |
| 11 | Paper content sent on every message (expensive) | 🟠 P1 | No session context management; RAG rebuilt each request |
| 12 | Citation links only go to page, not paragraph/sentence | 🟡 P2 | Chunk→page mapping exists; sub-page offsets not tracked |
| 13 | LLM can't access Zotero library | 🟠 P1 | Library indexer not registering correctly; no Web API fallback |
| 14 | Can't cross-reference or navigate to another paper | 🟢 P3 | Not implemented; needs library indexer + `Zotero.Reader.open()` |
| 15 | Security concerns | 🟡 P2 | API keys stored plaintext; see details below |

---

## Root Cause Deep-Dives

### #1 — Semantic Search crash
`embedder.ts` calls `console.log/warn/error` during model download progress callbacks.
Zotero's privileged chrome context has no `console` object (unlike a normal browser tab).
**Fix**: Replace every `console.*` call with `Zotero.log()` / `Zotero.warn()`.

### #2 — Streaming error flash
`chatStream()` in cloud providers (OpenAI, Anthropic, Gemini) uses `fetch()` + `ReadableStream`.
The Streams API is not fully supported in Zotero's embedded XULRunner `fetch()`.
The user-implemented fallback to `chat()` (which uses `Zotero.HTTP.request()`) works,
but the UI shows the "streaming failed" message before the fallback result arrives.
**Fix option A** (quick): Catch the stream error silently, call `chat()`, show result as-is.
**Fix option B** (better): Remove streaming from cloud providers entirely; simulate streaming
by splitting the complete response into words and appending them one-by-one with `setTimeout`.
This gives a "typewriter" effect without needing real streaming, and is more reliable.

### #3 — Ollama not connecting
Ollama uses `fetch("http://localhost:11434/...")`. In Zotero's privileged context,
`fetch()` to a non-HTTPS localhost URL may be blocked by Content Security Policy
or the Mozilla network stack's mixed-content rules.
`Zotero.HTTP.request()` uses `XMLHttpRequest` which bypasses these restrictions.
**Fix**: Move Ollama's `chat()` and `isAvailable()` to `httpPost/httpGet` from `src/utils/http.ts`.
For streaming, use XHR `onprogress` events to process partial NDJSON responses.

### #4 — Conversations lost
`getDB()` opens IndexedDB via `(globalThis as any).indexedDB`. In the PDF reader panel
context (which runs in a privileged chrome frame, not a content frame), IndexedDB is
undefined. All `dbAppendMessage()` calls are fire-and-forget via `withTimeout()`, so
failures are swallowed. Nothing is ever persisted to disk.
**Fix**: Replace IndexedDB with `Zotero.DB.queryAsync()` as the storage backend.
Zotero's built-in SQLite database is accessible from any context.
Schema: one table for conversations (itemID, role, content, timestamp, chunkIDs).

### #5 & #6 — Panel height / auto-scroll
The `#llm-messages` div receives appended children but has no `overflow: hidden` +
fixed height. Each message makes the whole side panel taller. `scrollTop` is never
updated after append.
**Fix**: Wrap in a flex layout where `#llm-messages` has `flex: 1; overflow-y: auto;
min-height: 0;`. After every append: `el.scrollTop = el.scrollHeight`.

### #7 — Input wrapping
`<html:input type="text">` is single-line by specification.
**Fix**: Replace with `<html:textarea rows="2">` styled to grow up to 5 rows
using the `input` event + `scrollHeight` measurement. Ctrl+Enter sends; Enter adds newline.

### #8 — Text selection
XUL chrome windows apply `-moz-user-select: none` to most elements by default.
**Fix**: Add explicit `user-select: text; -moz-user-select: text;` to `#llm-messages` CSS.
Also add a small 📋 copy button per assistant message bubble.

### #10 & #11 — Token waste
Every request rebuilds the full RAG pipeline and sends up to `MAX_TOP_K=20` chunks
(~10,000 tokens). On the Gemini free tier (32K tokens/minute limit), a single query
easily hits the cap.
**Fix (context management)**: Track whether this is the first message in the session.
- First message: build RAG, store selected chunks in session state, send with full context.
- Subsequent messages: send only conversation history + new question (no RAG rebuild).
- Expose a "New Session / Change Topic" button to reset context.
**Fix (per-provider budget)**: Add `maxContextTokens` config per provider:
- Ollama: unlimited
- Gemini free: 8,000 tokens
- Gemini paid: 100,000 tokens
- OpenAI gpt-4o-mini: 20,000 tokens
- OpenAI gpt-4o: 50,000 tokens
- Anthropic: 50,000 tokens

### #12 — Imprecise citations
Chunks track `pageNumber` but not character offsets within the page.
`Zotero.Reader` can navigate to `{ pageIndex, position: { rects } }` for exact locations.
**Fix (v0.3)**: During extraction, record character start/end per chunk. Pass these to the
reader via `reader.navigate({ pageIndex, charRange })`.

### #13 — Library access
The `LibraryIndexer` registers a Zotero notifier on startup but the notifier callback
may not fire correctly for the initial library scan.
**Quick fix**: Add Zotero Web API support (`api.zotero.org/users/{userID}/items`)
as a fallback for users who have sync enabled and a Zotero API key.
**Proper fix (v0.3)**: Debug the notifier registration and force a full re-index on startup.

### #14 — Intra-library navigation
Requires: (1) working library indexer, (2) LLM responses that reference other items by
Zotero key, (3) `Zotero.Reader.open(item)` + navigate to position.
Planned for v0.3.0 after library indexer is fixed.

### #15 — Security
No critical vulnerabilities found. Existing mitigations (SSRF, prompt injection, citation
whitelist) are sound. Areas for improvement:
- API keys should be masked in `Zotero.log()` output (add redaction helper)
- Add a warning in settings if the Zotero profile is on a shared/network drive
- Document that Zotero's own preference system has the same plaintext limitation

---

## Release Roadmap

---

### v0.1.1 — Critical Bug Fixes
**Branch**: `fix/v0.1.1` off `develop`
**Scope**: Make the plugin reliably functional with at least Ollama + one cloud provider
**Estimated effort**: 1–2 days

| Task | File(s) | Issue |
|------|---------|-------|
| Replace `console.*` with `Zotero.log()` in embedder | `embedder.ts` | #1 |
| Move Ollama `chat()` + `isAvailable()` to `httpPost/httpGet` | `ollama.ts` | #3 |
| Silent streaming fallback (no error flash) | `readerPanel.ts` | #2 |
| Fixed-height chat area with `overflow-y: auto` | `readerPanel.ts` | #5 |
| Auto-scroll `scrollTop = scrollHeight` on message append | `readerPanel.ts` | #6 |
| Replace `<input>` with auto-grow `<textarea>` | `readerPanel.ts` | #7 |
| Enable `user-select: text` + per-message copy button | `readerPanel.ts` | #8 |

**Test checklist before release**:
- [ ] Semantic search download completes without crash
- [ ] Ollama responds to a question about an open PDF
- [ ] OpenAI responds without error flash
- [ ] Chat area stays fixed height and auto-scrolls
- [ ] Can select and copy assistant text
- [ ] Textarea wraps and expands up to 5 rows

---

### v0.2.0 — Conversations & Smart Context
**Branch**: `feat/v0.2.0` off `develop`
**Scope**: Persistent conversations + stop re-sending paper every message
**Estimated effort**: 3–5 days

| Task | File(s) | Issue |
|------|---------|-------|
| `Zotero.DB` conversation storage (replace IndexedDB) | `db.ts`, `storage/zoterodb.ts` | #4 |
| Session context management (send paper once per session) | `pipeline.ts`, `readerPanel.ts` | #11 |
| Per-provider token budget (Gemini free = 8K, etc.) | `pipeline.ts`, `prefs.ts` | #10 |
| "New conversation" button resets context | `readerPanel.ts` | — |
| Conversation history view (collapsible past sessions) | `readerPanel.ts` | — |
| Typewriter-effect response rendering (replaces broken streaming) | `readerPanel.ts` | #2 |

**Deliverable**: Conversations survive Zotero restarts. API costs drop 80%+ for multi-turn conversations.

---

### v0.3.0 — Library Integration & Precise Citations
**Branch**: `feat/v0.3.0` off `develop`
**Scope**: Real library access and sub-page citation links
**Estimated effort**: 5–7 days

| Task | File(s) | Issue |
|------|---------|-------|
| Fix library indexer notifier + force full scan on startup | `indexer.ts` | #13 |
| Zotero Web API fallback for library search | `library/api.ts` (new) | #13 |
| Cross-paper reference detection + `Zotero.Reader.open()` | `searcher.ts`, `libraryPanel.ts` | #14 |
| Paragraph-level citations (char offset → reader position) | `chunker.ts`, `extractor.ts`, `readerPanel.ts` | #12 |
| Markdown rendering in chat (bold, code, lists, tables) | `readerPanel.ts` | — |

**Deliverable**: "Find papers about X in my library" works. Citations jump to exact paragraph.

---

### v0.4.0 — Provider Expansion & Polish
**Branch**: `feat/v0.4.0` off `develop`
**Scope**: Broader provider support, dark mode, security hardening
**Estimated effort**: 5–7 days

| Task | File(s) | Issue |
|------|---------|-------|
| Gemini OAuth (Google Sign-In, no API key needed) | `providers/gemini-oauth.ts` (new) | #9 |
| Gemini paid vs free tier auto-detection | `gemini.ts`, `prefs.ts` | #10 |
| API key redaction in logs | `prefs.ts`, `settingsPane.ts` | #15 |
| Shared-machine warning in settings | `settingsPane.ts` | #15 |
| Dark mode CSS for chat panel | `readerPanel.ts` | — |

**Note on #9 (ChatGPT/Claude subscriptions)**: OpenAI and Anthropic do not provide
OAuth flows for their web products. Using stored cookies or screen-scraping violates
their Terms of Service and is not implemented. Gemini OAuth is feasible via the
standard Google Identity OAuth 2.0 PKCE flow.

---

### v1.0.0 — Public Release
**Branch**: `release/1.0.0` off `develop`
**Scope**: Stable, tested, documented, submitted to Zotero plugin registry
**Gate criteria**:
- All P0 and P1 issues resolved
- Full test suite green
- `docs/` up to date
- Security review complete
- Zotero plugin registry submission PR open
