# Modernization Plan — re-evaluated 12 November 2026

This document replaces the October 2026 review. It is written to be picked up
cold: it says what is on the branch, what is wrong with it, what the first
review got wrong, and what to do next, in order.

**If you read only one section, read §1.**

---

## 1. Start here

**State of the code.** Branch `claude/confident-bardeen-j2v7eq` is four feature
commits ahead of `develop` and is **not merged**. It contains three phases of
changes (v0.2.0 → v0.4.0) on top of the released v0.1.1b.

**Do not merge or release it yet.** A second, critical read of the branch found
four defects that break default behaviour (§4, P0), including one that makes
the OpenAI and Gemini providers pick an unusable model out of the box. In
v0.1.1b those providers worked.

**What has been verified:** TypeScript compiles, 212 unit tests pass, the XPI
builds. **What has not:** the plugin has never been run inside Zotero since
these changes, and no request has been sent to any provider. Every statement
about runtime behaviour below is from reading code and documentation.

**Next steps, in order:**

1. Fix the P0 defects (§4.1). Pure code plus unit tests; needs no Zotero.
2. Build the XPI and run the 15-minute runtime checklist in Zotero (§7). Only
   the repository owner can do this — a cloud session has no Zotero.
3. Fix the P1 defects and adopt the revised context policy (§5.2).
4. Rebuild library search on a real semantic signal (§5.3). The current one is
   not semantic in practice (§3, correction 3).

**Three things the first review told you that were wrong** (details in §3):

- "The whole PDF is not being re-sent." For a normal-length paper on a cloud
  provider, v0.1.1b *did* re-send essentially the whole paper on every
  question. Your original intuition was right.
- "Caching is worth ~10×." For ten questions it is about 3.4×. The larger
  saving is the model's price: Haiku 5.5 costs 1/30th of the old default per
  input token.
- "Library search is now semantic." In the shipped plugin the embedding model
  most likely never loads, and the fallback is word-and-trigram hashing. The
  retrieval restructuring is sound; the semantic signal feeding it is not there.

**Commands.**

```bash
npm ci
```

```bash
npm test
```

```bash
npx tsc --noEmit
```

```bash
npm run build
```

The build writes `.scaffold/build/zotero-llm-assistant.xpi`. Install it in
Zotero with Tools → Add-ons → gear → Install Add-on From File.

---

## 2. What is on the branch

| Commit | Version | Contents |
|---|---|---|
| `de6d813` | — | First review document (superseded by this file). |
| `a42b0b6` | 0.2.0 | Model discovery (`src/modules/llm/models.ts`), input budgets from the provider's context window instead of a hardcoded table, "auto" model selection, Anthropic request-shape updates, settings controls (Detect button, Ollama context size, Anthropic effort). |
| `904ef9d` | 0.3.0 | Whole-paper context mode with a stable prompt prefix, Anthropic `cache_control`, page citations `[p.N]`, token/cache counts in the footer (Anthropic only). |
| `98b21a0` | 0.4.0 | Library search by rank fusion of keyword and embedding rankings, windowed embedding of long text, 1500-character abstracts, "from general knowledge" answer section. |

New tests: `test/models.test.ts`, `test/caching.test.ts`,
`test/library-retrieval.test.ts`. They cover pure functions only. Nothing tests
model auto-selection, a full library search, or any UI flow.

Dependencies took safe bumps only. Held back: `zotero-plugin-toolkit` 5.2+/6
(dropped the `ZoteroToolkit` export this plugin uses), TypeScript 6/7,
`@huggingface/transformers` 4.

### What still stands from the first review

These findings were re-checked and hold:

- **The 8K cap bug was real and is fixed.** The old `MODEL_TOKEN_CAPS` table
  returned 8,000 tokens for any model ID it did not list.
- **The keyword gate was real and is removed.** Old `searchLibrary()` dropped
  every item with no literal keyword match before any other ranking ran.
- **Anthropic does not permit subscription login in third-party tools** (§5.4).
- **Keep:** the provider interface, citation whitelisting, the fail-closed
  privacy model, the endpoint (SSRF) validator, the untrusted-document prompt
  framing, the lazy library index.

---

## 3. Corrections to the first review

Each item states what was claimed, what is actually true, and what it changes.

**1. "The whole PDF is not being re-sent every question."**
Wrong for typical papers. v0.1.1b selected chunks up to a cap (32K tokens for
OpenAI and Anthropic, 16K for Gemini, 8K for Ollama). A typical paper is
8–15K tokens, which is under the cloud caps, so *every* chunk was selected and
re-sorted into page order: the full text went out on every question. The
selection only varied by question for documents larger than the cap.
*Consequence:* the fix that mattered for Anthropic was adding `cache_control`,
not restructuring; OpenAI's automatic caching may already have been discounting
these requests.

**2. "Roughly 10–12× cheaper."**
Overstated. The comparison used a 32K-token request against a 12K-token paper.
Like for like, with a paper of size D and n questions inside the cache
lifetime, input cost in units of D is:

| Questions | No cache | 5-minute cache | 1-hour cache (what the branch uses) |
|---|---|---|---|
| 1 | 1.0 | 1.25 | **2.0** |
| 2 | 2.0 | 1.35 | 2.1 |
| 3 | 3.0 | 1.45 | 2.2 |
| 5 | 5.0 | 1.65 | 2.4 |
| 10 | 10.0 | 2.15 | 2.9 |

(Cache writes cost 1.25× for a 5-minute lifetime and 2× for 1 hour; reads cost
0.1×. The 5-minute column applies only if questions start less than five
minutes apart.) So ten questions are 3.4× cheaper, a single question is 2×
*more* expensive, and 10× is the limit for very long sessions.

The dominant saving is the model. Input cost for ten questions on a 12K-token
paper:

| Setup | Input cost |
|---|---|
| v0.1.1b default, `claude-sonnet-4-6` at $3/MTok, no cache | ~$0.36 |
| `claude-sonnet-5-5` at $2/MTok, 1-hour cache | ~$0.07 |
| `claude-haiku-5-5` at $0.10/MTok, no cache | ~$0.016 |
| `claude-haiku-5-5`, 1-hour cache | ~$0.005 |

(Haiku figures include its tokenizer counting about 30% more tokens for the
same text.) On Haiku 5.5 the input side is already fractions of a cent, and
output — which includes thinking tokens, on by default — is probably the larger
share. The effort setting is therefore the next cost lever after model choice.

**3. "Chunks are truncated at 256 tokens; the windowing fix restores semantic
quality."**
True only for the Transformers.js backend, and that backend most likely does
not run in Zotero. Evidence: commit `d3acbf6` (v0.1.1a) added the hashing
fallback after observing `ONNX 'no available backend'` and `Dynamic require of
node:os` failures in real Zotero, and nothing since has changed how the ONNX
runtime loads. The XPI contains the library's JavaScript but no ONNX `.wasm`
runtime files. The fallback (`HashingRunner` in `src/modules/rag/embedder.ts`)
hashes words and character trigrams into a 384-number vector: it measures
shared spelling, not shared meaning.
*Consequence:* the windowing fix is correct but probably changes nothing a user
can see; and see correction 4.
*How to confirm in one minute:* in Zotero's Config Editor, look up
`extensions.zotero.zotero-llm-assistant.embeddings.modelRevision`. The value
`local-hash-v1` means the hashing fallback is in use.

**4. "A paper that matches your meaning but shares no literal word can now
surface."**
Not in practice, because of correction 3. Rank fusion combines keyword ranking
with a ranking that is itself lexical. Removing the keyword gate helps with
spelling variants and partial overlaps, but a conceptual query in your own
words is still not matched by meaning. This is the main reason library search
needs more work (§5.3).

**5. "No whole-paper threshold is needed; 'fits the budget' is the whole
condition."**
Right for capacity, wrong for cost and for local speed. See defects D5 and D6.

**6. "8K of chunks against a 16K Ollama context was waste."**
It was the safety margin for conversation history, the question, the reply and
tokenizer error. Phase 1 removed most of it. See D5.

**7. "Question-dependent chunk selection is fine locally because local tokens
are free."**
This ignored time. On a laptop without a capable GPU, reading the prompt
dominates the wait. If the prompt prefix is unchanged, Ollama reuses its
internal state and a follow-up starts quickly; if the chunk selection changes
every question, the whole context is re-read every time. Prefix stability
matters *more* locally, not less (§5.2).

**8. "Phase 2 is done."**
Partly. Cache breakpoints and usage reporting exist for Anthropic only. For
OpenAI, Gemini and Ollama nothing reports cache or token counts, so the claim
that the stable prefix helps them is an untested assumption (D9).

**9. A code comment says "the system prompt still caches" in chunk mode**
(`src/modules/llm/client.ts:484`). It does not: the system prompt is about 120
tokens and the minimum cacheable prefix is 512 tokens on current Claude models.
The breakpoint on it is harmless but does nothing by itself.

---

## 4. Defects found on the branch

Priorities: **P0** breaks default behaviour; **P1** is wrong behaviour or
unbounded cost under plausible use; **P2** is minor. Line numbers are as of
commit `98b21a0`.

### 4.1 P0 — fix before anyone installs this build

**D1. Automatic model selection picks non-chat or retired models.**
- *Where:* `src/modules/llm/client.ts:202` (`MODEL_PREFERENCE`), `:216`
  (`versionScore`), `:234` (`resolveModelId`); `src/modules/llm/models.ts:312`
  (`listOllamaModels`).
- *Why it is P0:* Phase 1 changed the OpenAI, Gemini and Ollama model settings
  to default to empty, meaning "choose automatically". This is the default
  path for three of four providers.
- *Evidence:* running the selection logic over realistic model lists
  (illustrative lists, not live API output):

  | Provider | Selected | Problem |
  |---|---|---|
  | OpenAI | `gpt-realtime-mini-2025-12-15` | realtime audio model |
  | Gemini | `gemini-3.1-flash-image-preview` | image model |
  | Anthropic, if the pinned default is cleared | `claude-3-haiku-20240307` | retired |
  | Ollama without a Qwen3.5 model | `qwen3-embedding:0.6b` | embedding model |

- *Causes:* `versionScore` reads the first two numbers in the ID, so a date
  stamp outranks a version; the patterns (`/mini/`, `/flash/`, `/qwen3/`) are
  unanchored; nothing filters by what a model can do.
- *Fix:* match only anchored chat-model families (for example
  `^gpt-\d+(\.\d+)?-mini$`), read the version from that match alone, prefer
  undated aliases, and exclude IDs containing modality words (embed, tts,
  transcribe, realtime, audio, image, live). For Ollama, exclude embedding
  models — by the capabilities reported by `/api/show` if available, otherwise
  by name. Keep one pinned last-resort default per provider for when discovery
  returns nothing.
- *Test:* extract a pure `pickModel(provider, ids)` and add fixture lists,
  including the four cases above.

**D2. The Ollama context-size setting is never sent to Ollama.**
- *Where:* `src/modules/llm/providers/ollama.ts:26`, `:63`, `:112` hardcode
  `num_ctx: 16384`. `getOllamaNumCtx()` is read only for the budget
  (`client.ts:326`) and the settings field.
- *Effect:* raising the setting makes the plugin build prompts larger than the
  context Ollama allocated, and Ollama silently truncates them. Lowering it
  saves no memory.
- *Fix:* pass the setting into `OllamaProvider` and send it. Assert on the
  request body in a test.

**D3. The new Detect buttons have no label.**
- *Where:* `addon/locale/en-US/preferences.ftl:5` defines
  `pref-detect-models = Detect`. Buttons in this file use the attribute form
  (see lines 13–16): `pref-detect-models =` followed by `.label = Detect`.
- *Effect:* four blank buttons, very likely. Confirm at runtime.

**D4. The Anthropic non-streaming path returns an empty answer.**
- *Where:* `src/modules/llm/providers/anthropic.ts:162` returns
  `content[0].text`.
- *Why:* Haiku 5.5, the new default, has thinking on by default, so the first
  content block is a thinking block with no `text`. The non-streaming path is
  the fallback used whenever streaming fails.
- *Fix:* concatenate every block whose `type` is `"text"`.

### 4.2 P1 — wrong behaviour or unbounded cost

**D5. Local prompts can exceed the Ollama context.**
`resolveInputBudget` (`models.ts:203`) subtracts only an output reserve, and
chunk mode fills the entire budget (`src/modules/rag/pipeline.ts:309`) without
subtracting the system prompt, up to six history messages
(`readerPanel.ts:62`) or the question. With defaults that is about 12,300
estimated tokens of chunks in a 16,384-token context, where v0.1.1b used 8,000.
The estimate itself (4 characters per token) runs low on academic text.
*Fix:* document budget = window − output reserve − measured history − question
− a margin of at least 15%.

**D6. Neither context mode has a cost ceiling.**
Whole-paper mode accepts anything up to the window (`pipeline.ts:237`). Chunk
mode fills the whole budget — on a 1M-token model, up to about 990K tokens per
question, uncached, where v0.1.1b capped at 32K. On Haiku this is hidden by the
100K price-band cap and the low price. On other models it is real: a single
question about an 80K-token thesis costs about $0.32 on Sonnet 5.5 with the
1-hour cache write, versus about $0.10 before.
*Fix:* two explicit settings independent of the window — a maximum size for
whole-paper mode and a maximum for retrieved chunks (§5.2).

**D7. The token estimate can push Haiku requests over its price band.**
Haiku 5.5 is billed 5× more per token above 100K prompt tokens. The band cap
(`models.ts:96`) is applied to the 4-characters-per-token estimate, but Haiku's
tokenizer counts about 30% more, so an estimated 88K can be a real 115K. This
only affects documents above roughly 300K characters.
*Fix:* apply a tokenizer factor of 1.35 for current Claude models, or call
Anthropic's free token-counting endpoint.

**D8. The "analysing paper…" note disappears before any text arrives.**
`readerPanel.ts:526` treats the first stream event as the first text, but the
first event is now a usage report. With a thinking model the user sees an empty
bubble during the thinking pause. *Fix:* only a chunk with text counts.

**D9. Token and cache reporting exists for Anthropic only.**
Needed: OpenAI — request `stream_options: {include_usage: true}` and read
`usage.prompt_tokens_details.cached_tokens`; Gemini — read
`usageMetadata.cachedContentTokenCount`; Ollama — read `prompt_eval_count` and
`eval_count` from the final stream object (a small `prompt_eval_count` on a
follow-up shows the prefix was reused). Field names are from memory of each
API; verify against a live response.

**D10. `max_tokens` is not clamped to the model's limit.** The defaults (16K
non-streaming, 64K streaming, `anthropic.ts:40`) are rejected by older models a
user may pin. Discovery already returns `maxOutputTokens`; nothing uses it.

**D11. Refusals and empty completions render as a blank bubble.** Current
Claude models can stop with `stop_reason: "refusal"`. Show a message instead.

**D12. Vectors from different embedding backends can mix.** Stored vectors
carry no record of what produced them. If one session uses Transformers.js and
the next falls back to hashing, both kinds are ranked together. *Fix:* store an
identifier for backend, model, dimensions and method version, and clear the
cache when it changes. `EMBEDDING_METHOD_VERSION` covers only the last of
these.

### 4.3 P2 — minor

- **D13.** The Detect button and discovery send the API key to the configured
  endpoint without running `validateEndpointURL` first
  (`models.ts:400`, `settingsPane.ts:240`).
- **D14.** Two discovery requests run concurrently on a cold cache (the comment
  at `readerPanel.ts:432` says one), and an 8-second discovery timeout
  (`models.ts:83`) sits on the path of the first question.
- **D15.** With Ollama not running, auto mode reports "No Ollama models found"
  (`client.ts:270`) rather than "Ollama is not running".
- **D16.** Once items are embedded, library search always returns ten results,
  however irrelevant; there is no minimum similarity.
- **D17.** Misleading text: `preferences.ftl:28` promises a 25 MB model
  download that probably never succeeds; `src/utils/tokens.ts:7` says the
  estimate errs high (it errs low); the comment in correction 9.
- **D18.** The Gemini key is sent in the URL query string (existing behaviour,
  and now also in discovery). A header is safer against logging.
- **D19.** When Zotero's text has no page separators, pages are approximated by
  dividing the text evenly (`src/modules/rag/extractor.ts`), so `[p.N]`
  citations can point at the wrong page. Existing behaviour; more visible now
  that page citations are the default.

---

## 5. Revised design

### 5.1 Cost levers, in the right order

1. **Model price.** Haiku 5.5 is 30× cheaper per input token than the old
   default. This alone makes ordinary use cost about a cent per paper.
2. **Reasoning effort.** With thinking on by default, output dominates on
   Haiku. Default the effort setting to `low` for paper Q&A unless testing
   shows answers suffer.
3. **Prompt caching.** 2–5× on the input side for multi-question sessions.
   Worth keeping; not the headline.
4. **Local model.** Free per token, paid for in waiting time (§5.5).

**Cache lifetime.** The branch uses the 1-hour lifetime. That is defensible for
reading — gaps between questions usually exceed five minutes — but it doubles
the cost of a one-question session. On Haiku the difference is a tenth of a
cent. Recommendation: keep 1 hour, and skip the cache marker entirely when the
paper is small enough that caching cannot matter.

### 5.2 Context policy v2

Replace "send whatever fits the window" with explicit limits and one retrieval
policy for all providers.

**Limits (new settings, with defaults to tune at runtime):**

| Setting | Cloud default | Ollama default |
|---|---|---|
| Largest document sent whole | ~60K tokens | ~40% of the context size |
| Largest retrieved-chunk context | ~24K tokens | ~40% of the context size |

Both are then reduced by history, question, output reserve and the tokenizer
margin (D5, D7).

**Retrieval: stable core plus small supplement.** When a document is too large
to send whole:

- *Core* — chosen once per conversation (abstract, introduction, conclusion,
  plus the best matches for the first question), placed in the cached document
  message, never changed afterwards.
- *Supplement* — up to a few chunks specific to the current question that are
  not in the core, attached to the question message, replaced every turn.

The prefix stays byte-identical, so cloud caching works on large documents and
Ollama reuses its state on follow-ups, while each question still gets targeted
evidence. Citations validate against core and supplement together.

**Ollama request settings to add and verify at runtime:** the context size from
the setting (D2); `keep_alive` long enough that the model is not unloaded
between questions (the default is about five minutes, after which the whole
prompt is re-read); and thinking disabled for models that support it, since a
small model thinking on a laptop CPU is slow.

### 5.3 Library search v2

Your stated goal was: ask which papers you have by an author, on a topic, or on
a research question, without sending the papers. Three changes get there.

**1. Catalog mode (cloud providers).** Send a compact catalog of the *whole*
library — one line per item: key, authors, year, title, tags — as a cached
prefix, plus full abstracts for the top retrieved items, plus the question. The
model does the semantic matching itself, across everything you own. This is
your own suggestion, implemented directly, and it needs no embeddings.

- Size: roughly 40 tokens per item, so 1,000 items is about 40K tokens. On
  Haiku with caching, each further question costs a small fraction of a cent.
- Order the catalog by date added so new items append and most of the cached
  prefix stays valid.
- Every key in the catalog becomes a valid citation target.
- Privacy: this sends every title and author list to the provider. Exclude
  items marked private (already done for search) and gate it behind its own
  consent toggle.
- Fallback for libraries too large for the limit, and for local models:
  retrieval as today.

**2. A real semantic signal, through Ollama.** Add an embedding backend that
calls Ollama's `/api/embed` endpoint. It runs outside Zotero, so the ONNX
problem disappears. Candidate models (sizes from secondary sources): 
`all-minilm` (~46 MB, 384 dimensions — the same size as today's vectors, but a
256-token input limit, so the windowing code still earns its keep),
`nomic-embed-text` (~274 MB, 768 dimensions, long input), `embeddinggemma`
(768 dimensions, ~2K-token input). Detect which is installed; record the
embedding identity with the vectors (D12). Keep hashing as the last resort and
label it honestly in the UI. Decide whether to keep the Transformers.js
dependency at all; if it cannot be made to load, remove it.

**3. Conversation and depth.** Library chat is currently single-turn
(`src/modules/ui/libraryPanel.ts:804` sends no history), so "tell me more about
the second one" has no context. Add history. Ten results is too shallow for
"what do I have on X": send ten with abstracts and a further thirty as
title-only lines.

Still open from the earlier plan: indexing progress in the UI, filters by
collection/tag/year, a survey mode that groups results by theme, pulling full
text for the top few items on demand, group libraries (only the personal
library is indexed today), and a minimum-similarity floor (D16).

### 5.4 Using a subscription instead of an API key

- **Claude:** not possible inside a third-party plugin. Anthropic's consumer
  terms forbid sharing account credentials and forbid automated access except
  through an API key. Unchanged.
- **ChatGPT:** "Sign in with ChatGPT" is now live, with developer
  documentation at `developers.openai.com/siwc/quickstart`. Using a person's
  plan allowance requires the *app* to be approved by OpenAI for plan usage,
  and is available to Go, Plus and Pro subscribers. A personal plugin would
  have to apply. Read the developer page before deciding; it was not reachable
  from the sessions that wrote this document.
- **An approach that works today:** connect Zotero to the Claude desktop app
  through a Model Context Protocol (MCP) server, so the official app — and your
  subscription — does the model work. Community servers exist (for example
  `kujenga/zotero-mcp`, which can search the library and read full text through
  Zotero's local API). The trade-off is that the conversation happens in the
  Claude app, not in Zotero's side panel. This needs no change to this plugin
  and is worth trying before investing in subscription login.
- **Gemini's free API tier** remains a no-cost cloud option the plugin already
  supports.

### 5.5 Local model for an 8 GB laptop

- **Chat model:** Qwen3.5 4B, Ollama tag `qwen3.5:4b` — about 3.4 GB at 4-bit
  quantization, roughly 6 GB of memory needed, 256K advertised context. Several
  independent secondary sources agree on these figures; confirm on the Ollama
  library page or with `ollama show qwen3.5:4b`. If it is too slow,
  `qwen3.5:2b`.
- **The open question is speed, not size.** On Apple Silicon a 12K-token paper
  is read in tens of seconds. On a laptop CPU without a usable GPU it can take
  minutes per question unless the prefix is reused. Measure with
  `ollama run qwen3.5:4b --verbose` and read the prompt evaluation rate. This
  decides whether local whole-paper context is practical or whether local use
  should stay on small retrieved contexts.
- **Advertised context is not usable context.** 256K is what the model
  supports; 8 GB of memory supports perhaps 16K alongside Zotero. The context
  size setting is the real limit.

---

## 6. Work plan

Each milestone is independently shippable. Acceptance criteria are what "done"
means.

### M1 — Make the branch safe (v0.4.1)

Scope: D1, D2, D3, D4, D8, D17.

Done when:
- `pickModel` exists as a pure function with fixture tests, and the four
  failing cases in D1 select a chat model.
- A test asserts the Ollama request body carries the configured context size.
- A test covers text extraction from a response whose first block is thinking.
- `npm test`, `npx tsc --noEmit` and `npm run build` pass.

### M0 — Runtime check in Zotero (owner, ~15 minutes)

Run §7 on the M1 build. Record results in this file. Everything after this
should be adjusted to what it shows.

### M2 — Context policy v2 and visibility (v0.5.0)

Scope: D5, D6, D7, D9, D10, D11; §5.2.

Done when:
- A unit test shows the assembled prompt for the default Ollama settings stays
  inside the context size with six history messages present.
- Two settings bound whole-paper size and retrieved-context size, with tests
  for the boundary.
- A test shows the cacheable prefix is identical across questions in retrieval
  mode (core unchanged, supplement outside the prefix).
- The footer shows token and cache counts for all four providers, confirmed
  against live responses in M0-style testing.

### M3 — Library search v2 (v0.6.0)

Scope: §5.3 items 1–3, D12, D16.

Done when:
- With an Ollama embedding model installed, a conceptual query with no shared
  words ranks a relevant fixture item first, in a test using recorded vectors.
- Catalog mode builds a deterministic, append-only catalog (tested), respects
  private items, and is behind its own consent setting.
- Library chat carries conversation history.

### Later

Filters, survey mode, on-demand full text for top results, group libraries,
dependency majors, "Sign in with ChatGPT" if approval is feasible, moving API
keys out of plain-text preferences, tool-calling retrieval.

---

## 7. Runtime checklist (in Zotero)

Turn on logging first: Help → Debug Output Logging → Enable, then View Output
and search for `Zotero LLM Assistant`.

1. **Install and open Settings → LLM Assistant.** The pane renders; each
   provider section has a Detect button with a visible label.
2. **Embedding backend.** Enable semantic search in the plugin's settings,
   then in Settings → Advanced → Config Editor read
   `extensions.zotero.zotero-llm-assistant.embeddings.modelRevision`.
   `local-hash-v1` = hashing fallback; a long hex string = the real model.
3. **Ollama.** Leave the model field empty, press Detect, confirm the
   auto-selected model is a chat model. Ask a question about an open PDF. In a
   terminal, `ollama ps` shows the loaded model and its context size.
4. **Follow-up speed (Ollama).** Ask a second question about the same paper
   and compare the wait with the first.
5. **Anthropic caching.** Enable cloud sharing, set a key, ask three questions
   about one paper. The footer should read `whole paper`; the first answer
   shows cache *written* above zero, the second and third show cache *read*
   above zero. Read staying at zero means the prefix is being invalidated.
6. **Citations.** Click a `[p.N]` link; it opens that page. Ask for something
   that is not in the paper and check no invented page is linked.
7. **Library question.** In the library pane, ask a conceptual question in
   your own words and a by-author question. Note whether results are relevant.
8. **Other providers you use.** One question each on OpenAI and Gemini with
   the model field empty.

---

## 8. External facts and how sure we are

Network access in the authoring sessions allowed web search but blocked
`ollama.com`, `huggingface.co`, `ai.google.dev` and `platform.openai.com`
directly. Nothing below was checked against those sites.

| Claim | Confidence | Basis | To verify |
|---|---|---|---|
| Claude model IDs, prices, cache pricing (1.25× / 2× / 0.1×), 512-token cache minimum, Haiku's 100K price band and ~30% tokenizer difference | High, as of 2026-10-06 | Anthropic's bundled API reference with that date | `GET /v1/models`; the pricing page. Newer models may exist. |
| Anthropic terms forbid subscription use in third-party tools | High | Fetched from anthropic.com | — |
| Transformers.js does not load in Zotero | Medium-high | Commit `d3acbf6` records the observed errors; no `.wasm` files in the XPI | §7 step 2 |
| `qwen3.5:4b` ≈ 3.4 GB, ~6 GB RAM, 256K context | Medium-high | Several agreeing secondary sources | `ollama show qwen3.5:4b` |
| Ollama `/api/embed`; `all-minilm`, `nomic-embed-text`, `embeddinggemma` | Medium-high | Ollama's documentation surfaced by search; sizes from blogs | Ollama docs; `ollama pull` |
| "Sign in with ChatGPT" is live and needs per-app approval for plan usage | Medium | OpenAI help-centre and developer-page snippets via search | `developers.openai.com/siwc/quickstart` |
| Zotero MCP servers exist and work with the Claude desktop app | Medium | Project listings via search | The project's README |
| OpenAI and Gemini usage field names in D9 | Medium-low | Memory of the APIs | A live response |
| Local speed figures in §5.5 | Low | Rough expectation | Measure |
| Exact current OpenAI and Gemini model IDs and prices | Low | Aggregators that disagree | Live `/v1/models`; official pricing |

---

## 9. Decisions

| Decision | Status |
|---|---|
| Default cloud model: Haiku 5.5 | Kept. Reinforced by §5.1. |
| Local target: 8 GB laptop, Qwen3.5 4B | Kept, pending the speed measurement in §5.5. |
| Empty model field means "choose automatically" | Kept in principle; the implementation is defective (D1). |
| Whole-paper mode with a cached prefix | Kept; needs size limits (D6). |
| "No whole-paper threshold needed" | **Reversed.** |
| Question-dependent chunk selection in retrieval mode | **Reversed** in favour of core plus supplement (§5.2). |
| Fix truncation by windowing instead of swapping the embedding model | Kept, but it matters only once a real embedding backend runs. |
| Semantic retrieval through Transformers.js inside Zotero | **Reversed** in favour of Ollama embeddings and catalog mode (§5.3). |
| Subscription login | Not for Claude. ChatGPT only if approved. Try the MCP route first. |
| Footer shows token counts, no dollar estimate | Kept. |

### Questions for the owner

1. Is the 8 GB laptop Apple Silicon, or an Intel/AMD machine without a usable
   GPU? This decides the local design (§5.5).
2. About how many items are in the library? This sizes catalog mode.
3. Which Zotero version do you run?
4. Which providers will you actually use? That sets testing priority.
5. Is sending the full list of titles and authors to a cloud provider
   acceptable, with private items excluded?
6. Would using the Claude desktop app with a Zotero connector satisfy the
   subscription goal, or does it have to be inside Zotero?

---

## 10. Notes for the next working session

- A cloud session cannot run Zotero. It can change code, run the unit tests and
  build the XPI; runtime results must come from the owner.
- To check external facts from a cloud session, the environment's network
  settings must allow the sites in §8.
- `CLAUDE.md`, `AGENT.md` and `ROADMAP.md` are deliberately untracked in this
  repository; this file is the shared plan.
- Unit tests are standalone `tsx` scripts using Node's `assert`; follow the
  pattern in `test/models.test.ts`. Modules that read preferences need the
  small `Zotero` stub shown in `test/caching.test.ts`.
- Any change to how text becomes a vector must bump
  `EMBEDDING_METHOD_VERSION` in `src/modules/rag/embedder.ts`.
- Never interpolate per-request values into a system prompt or the document
  message; `test/caching.test.ts` guards this.

### Sources

Anthropic [consumer terms](https://www.anthropic.com/legal/consumer-terms);
Claude models, pricing and caching from Anthropic's bundled API reference
(dated 2026-10-06).

Secondary, via web search: 
[Ollama embeddings documentation](https://docs.ollama.com/capabilities/embeddings.md) ·
[Ollama embedding model comparison](https://www.morphllm.com/ollama-embedding-models) ·
[Qwen3.5 small models guide](https://insiderllm.com/guides/qwen-3-5-small-models-9b-beats-30b/) ·
[Qwen3.5-4B model page](https://huggingface.co/Qwen/Qwen3.5-4B) ·
[Qwen3.5 small models analysis](https://artificialanalysis.ai/articles/qwen3-5-small-models) ·
[zotero-mcp](https://github.com/kujenga/zotero-mcp) ·
[Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart) ·
[OpenAI help: Sign in with ChatGPT](https://help.openai.com/en/articles/20001542) ·
[Sign in with ChatGPT partner launch](https://itbrief.co.uk/story/openai-launches-chatgpt-sign-in-for-16-partner-tools) ·
[Anthropic OAuth reporting](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)
