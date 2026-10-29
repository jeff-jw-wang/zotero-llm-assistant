# Modernization Review & Plan — October 2026

Review of `zotero-llm-assistant` v0.1.1b (last commit 2026-03-06) against the
October 2026 model landscape, and a staged plan for a major update.

---

## 1. Verdict

The **architecture has aged well; the configuration has not.**

The parts that are hard to get right — provider abstraction, citation
whitelisting, SSRF validation, the fail-closed privacy model, chunk-ID
provenance — are still sound and better than most Zotero AI plugins. Don't
rewrite them.

What has rotted is everything that encodes a *fact about the world*: model
names, token caps, price assumptions, the embedding model. And one
architectural decision — recomputing the document context on every question —
has quietly become the most expensive thing the plugin does, because it is
incompatible with the prompt caching that every major provider now bills on.

**Three findings worth acting on, in order of value:**

1. **The cost problem is not what it looks like.** The plugin never sent whole
   PDFs — it has always been chunk-RAG. But because the selected chunk set is
   recomputed per question, the prompt prefix changes every turn, so *no
   provider cache can ever hit*. Fixing this is worth roughly **10×** on cloud
   cost and also improves answer quality. See §4.
2. **Subscription auth is not available for Claude.** Anthropic's consumer
   terms prohibit it. OpenAI shipped a mechanism in September 2026 but access
   is gated. See §5.
3. **Library search has a structural defect**, not just a tuning problem:
   items with zero keyword overlap are dropped *before* semantic re-ranking, so
   conceptual questions over the library return nothing. See §7.

---

## 2. What to keep

| Component | Why it still holds up |
|---|---|
| `ILLMProvider` abstraction | Clean seam; adding/replacing providers is cheap. Nothing to change structurally. |
| Citation whitelisting (`chunkWhitelist`) | Content-hashed chunk IDs validated against what was actually sent. This is the correct design and most tools still don't do it. |
| Privacy model | Cloud off by default, per-item flags, OR-logic across IndexedDB + Prefs mirror, fail-closed on corrupt state. Genuinely careful work. |
| SSRF validator (`utils/url.ts`) | Still appropriate for user-supplied endpoints. |
| Prompt-injection framing | `<document>` delimiters + untrusted-data system prompt. Still current best practice. |
| Lazy library index + notifier invalidation | Right call for large libraries. |

---

## 3. What is outdated

### 3.1 Model defaults — all five are stale

| Setting | Current value | Status |
|---|---|---|
| `llm.anthropic.model` | `claude-sonnet-4-6` | Superseded. **Sonnet 5.5 is both better and cheaper** ($2/$10 per MTok vs $3/$15). |
| `llm.openai.model` | `gpt-4o-mini` | ~2 generations behind. |
| `llm.gemini.model` | `gemini-2.0-flash` | Behind; the 3.x line is current. |
| `llm.ollama.model` | `llama3.2` | Behind; small-model quality has moved a lot. |
| Embedding model | `Xenova/all-MiniLM-L6-v2` | Functional but 2021-era, and see §3.3. |

Current Anthropic lineup (verified): `claude-opus-5-5` ($4/$20, 1M context),
`claude-sonnet-5-5` ($2/$10, 1M), `claude-haiku-5-5` ($0.10/$0.50, 1M for
prompts ≤100K). For this workload **Sonnet 5.5 is the right default** and
**Haiku 5.5 is a credible budget tier** at 1/20th the input price.

### 3.2 `MODEL_TOKEN_CAPS` is a staleness *bug*, not just a stale label

`utils/tokens.ts` keys its caps on exact model ID strings and silently falls
back to `DEFAULT_TOKEN_CAP = 8_000` for anything unknown:

```ts
export const MODEL_TOKEN_CAPS: Record<string, number> = { ... };
export function getTokenCap(model: string): number {
  return MODEL_TOKEN_CAPS[model] ?? DEFAULT_TOKEN_CAP;
}
```

So if a user types `claude-opus-5-5` today, they get an **8K** context budget
against a **1M** window — a 99.2% reduction, with no warning. Every future
model release reintroduces this. The map also caps Gemini at 16K for
free-tier-quota reasons that no longer apply.

**Fix:** stop hardcoding. Query each provider's models endpoint for the real
window (`max_input_tokens`), fall back to a family heuristic, and make the
final fallback generous (128K) rather than punitive.

### 3.3 The embedding model truncates half of every chunk

- `chunker.ts`: `TARGET_CHUNK_CHARS = 2048` → chunks are ~512 tokens.
- `all-MiniLM-L6-v2` has a **256-token** maximum sequence length.
- `embedder.ts` passes chunk text straight to the pipeline with no explicit
  truncation handling.

Transformers.js truncates at the model limit, so **roughly the second half of
every chunk never contributes to its embedding**, and library metadata
embeddings (`title + abstract`) are cut off mid-abstract. Semantic search has
been running at a fraction of its intended quality this whole time.

### 3.4 Anthropic provider is on an old request shape

- `DEFAULT_MAX_TOKENS = 4096` — risks mid-answer truncation; current guidance
  is ~16K non-streaming, ~64K streaming.
- No `output_config.effort`, no adaptive thinking. Current models expose
  effort (`low`…`max`) as the main quality/cost dial; the plugin can't reach it.
- `system` is sent as a plain string, which **cannot carry `cache_control`** —
  a blocker for §4.
- API version pinned to `2023-06-01`. Note: on API version `2026-10-21`,
  `temperature`/`top_p`/`top_k` return 400 on every model — relevant if the
  version is ever bumped, since `ChatOptions.temperature` is plumbed through.

### 3.5 Dependencies and platform

`zotero-types@4.1.0-beta.4`, `zotero-plugin-scaffold@0.8.2`,
`@huggingface/transformers@3.8.1` are all ~7 months old. Zotero 8
compatibility should be re-verified against a current release before shipping.

### 3.6 Minor

- Local path mismatch: Ollama is sent `num_ctx: 16384` but chunk selection
  budgets only 8K, so a third of the window goes unused.
- `test/` is seven standalone `tsx` scripts with no runner — fine, but a real
  test runner would make a refactor of this size much safer.
- API keys are plaintext in `prefs.js`. Documented and accepted, but worth
  revisiting.

---

## 4. The token-cost question — premise correction and the real fix

### 4.1 The whole PDF is not being re-sent

`pipeline.ts` already does: extract → chunk (~512 tokens) → score (keyword +
optional embedding blend) → greedy-select within a token cap → build
`<document>`. Extraction and chunking are cached per item. So the original
worry — "the whole PDF goes over the wire every question" — is not what
happens.

### 4.2 What *is* happening is worse in a subtler way

Chunk **scoring depends on the question**, so the selected chunk set differs on
every turn. The message array is:

```
[system] → [user: <document> …selected chunks… ] → [history] → [user: question]
```

Because the `<document>` block changes each turn, **the cacheable prefix
changes each turn.** Every question re-pays full input price for its context,
and prompt caching — the single biggest cost lever all three cloud providers
now offer — can never engage. The plugin is structurally locked out of it.

For a 10-question conversation at the 32K Anthropic cap:

| Design | Input tokens | Cost (Sonnet 5.5, $2/MTok) |
|---|---|---|
| Current (32K fresh per turn) | ~320K | **~$0.64** |
| Full paper, cached (12K paper) | 15K write + ~11K cache-read-equiv | **~$0.05** |

That is **~12× cheaper** — and the model sees the *entire* paper rather than a
keyword-selected 32K slice, so answers get *better*, not worse. A typical
research paper is 8–15K tokens; whole-paper context is not exotic against 1M
windows.

### 4.3 The fix: make the prefix stable, then cache it

**Restructure to:**

```
[system: stable, no timestamps]                    ← cache breakpoint
[user: <document> …WHOLE paper, fixed… ]           ← cache breakpoint
[history …]
[user: current question]                            ← volatile, after breakpoints
```

Then per provider:

| Provider | Mechanism |
|---|---|
| Anthropic | `cache_control: {type: "ephemeral"}` on the system/document blocks; `ttl: "1h"` for a reading session. Reads ≈0.1×, writes ≈1.25×. Requires the array form of `system`. Max 4 breakpoints. |
| OpenAI | Automatic prefix caching, cached input ≈10% of input. No flag — it just needs a stable prefix. |
| Gemini | Implicit caching is on by default for 2.5+ and discounts matching prefixes; explicit caching adds hourly storage fees, so implicit is the right target. |
| Ollama | No token cost, but llama.cpp reuses the KV cache when the prefix is unchanged — follow-up questions get **much faster**. |

**One change, a win on every provider.** This is the highest-value item in the
plan and it is a restructuring, not a rewrite.

### 4.4 Keep RAG — as the fallback, not the default

Chunk-RAG stays for the cases it was actually good for:

- documents over the whole-paper threshold (theses, books, >100K tokens),
- local models with small real context windows,
- citation anchoring (the chunk whitelist still drives clickable page links —
  for whole-paper mode, use page markers as the whitelist unit instead).

Selection logic should then run **once per conversation**, not once per
question, so the prefix stays stable.

### 4.5 Make the saving visible

There is already a diagnostics footer. Extend it with tokens in/out, cache
read vs. write, and estimated cost per turn. `usage.cache_read_input_tokens`
is the ground truth for whether caching is actually working — if it stays zero
across turns, something is still invalidating the prefix.

---

## 5. Subscription auth instead of API keys — the honest answer

### 5.1 Anthropic: not permitted

From Anthropic's own consumer terms:

> "You may not share your Account login information, Anthropic API key, or
> Account credentials with anyone else."

and automated access is prohibited:

> "…to access the Services through automated or non-human means, whether
> through a bot, script, or otherwise."

— with the carve-out "Except when you are accessing our Services via an
Anthropic API Key." The terms also state the Commercial Terms (which govern
API keys) explicitly **do not** cover Claude.ai or Claude Pro individual use.

Secondary reporting indicates Anthropic made this explicit for consumer OAuth
tokens in a February 2026 legal-page update, began enforcement in January 2026,
and cut off third-party agents in April 2026. Either way, the official terms
are clear enough: **for Claude, an API key is the only supported path.** Don't
build subscription auth for it.

### 5.2 OpenAI: exists, but gated

"Sign in with ChatGPT" was announced at DevDay on 2026-09-29 and does let
Plus/Pro users spend plan allowance inside third-party apps, with per-app
weekly caps set in ChatGPT settings. But:

- ~16 named launch partners (Devin, Notion, Vercel, Warp, …).
- Broader/commercial developer access reportedly goes through an interest form.
- No automatic fallback to API billing — you get `429
  subscription_sharing_usage_limit_exceeded` at the cap.
- I could not verify any of this against OpenAI's own docs from this session
  (see §10).

**Recommendation:** register interest, design the provider interface so an
OAuth-token transport can drop in later, but **don't build it now**. It would
be speculative work against an unverified, gated API.

### 5.3 What actually saves money today

Ranked by effect, not novelty:

1. **Prompt caching** (§4) — ~10× on cloud cost, works now, no auth changes.
2. **A good local model** (§6) — zero marginal cost.
3. **Haiku 5.5 as the cheap cloud tier** — $0.10/MTok input is 1/20th of
   Sonnet, and paper Q&A over supplied text is well within its ability.
4. **Gemini's free API tier** — already supported, genuinely free for light use.

Caching plus a local default gets the cost problem solved without depending on
anyone's subscription policy.

---

## 6. Local open-source model recommendation

**Caveat up front:** I could not reach `ollama.com` or `huggingface.co` from
this session, so exact tags must be confirmed locally. The search results I
could get were SEO-style roundups that contradicted each other on model names.
Treat the names below as candidates to verify, and the *selection method* as
the durable recommendation.

### 6.1 The durable fix: stop hardcoding model names

The recurring staleness here is a design problem, not a knowledge problem.
Hardcoding `llama3.2` guaranteed this conversation. Instead:

- **Ollama:** `GET /api/tags` lists what the user actually has installed;
  populate a dropdown from it and pick the best match by heuristic.
- **Cloud:** each provider exposes a models endpoint; populate the dropdown
  from it and cache the result.
- Keep a free-text override, and a lazily-updated fallback list.

Done once, the plugin never needs a "model refresh" release again.

### 6.2 What matters for *this* workload

Paper Q&A is long-context reading comprehension, grounding, and
instruction-following — **not** reasoning-heavy. So prioritise, in order:

1. **Real usable context ≥32K** (a paper is 10–15K tokens, plus history).
   Claimed context ≠ usable context; test it.
2. **Instruction-following and citation discipline** — will it actually emit
   `[c.ID]` markers and refuse to invent them?
3. **Speed** — this is interactive. A MoE model with few active parameters
   beats a dense model of the same total size.
4. Raw benchmark IQ matters least.

### 6.3 Candidates by hardware

| RAM | Candidate | Notes |
|---|---|---|
| 8 GB | **Qwen3.5-4B** | Cited as the strongest small model; ~3.3–4.0 GB at Q4, 256K claimed context. Best quality-per-GB pick. |
| 8 GB (lighter) | Phi-4-mini 3.8B | ~2.5 GB. Fallback if 4B is too slow. |
| 16 GB | **GPT-OSS-20B** | MoE: 21B total but only ~3.6B active, so it runs near 4B speed. OpenAI states MXFP4 fits in 16 GB (provider claim — verify for your runtime and context length). |
| 16 GB (dense) | Qwen3-8B / Phi-4-14B | Qwen3-8B is the safe generalist; Phi-4-14B if you have headroom. |
| 32 GB+ / Apple Silicon | Qwen3.6-27B class | Best quality, but check it leaves room for Zotero itself. |

**Default suggestion:** Qwen3.5-4B for broad compatibility; GPT-OSS-20B if the
machine has 16 GB or more, because MoE gives near-large-model quality at
small-model latency.

### 6.4 Embedding model

Replacing `all-MiniLM-L6-v2` fixes the §3.3 truncation bug:

| Option | Dims | Max tokens | Size | Trade-off |
|---|---|---|---|---|
| all-MiniLM-L6-v2 (current) | 384 | **256** | ~25 MB | Truncates 512-token chunks. |
| **EmbeddingGemma-300m** | 768 (Matryoshka → 512/256/128) | **2048** | ~120–200 MB quantized | Recommended. Fits a whole chunk *and* a whole abstract. Truncate to 256 dims to keep IndexedDB small. |
| bge-small-en-v1.5 | 384 | 512 | ~35 MB | Lighter upgrade; fixes truncation at minimal download cost. |

EmbeddingGemma is the better model; bge-small is the better download. Either
beats the status quo. Verify an ONNX build exists for transformers.js before
committing — and note the existing consent + pinned-revision flow already
handles the re-download cleanly.

---

## 7. Library-wide questions

### 7.1 This already works the way you hoped

`libraryPanel.ts` + `indexer.ts` + `searcher.ts` already send **metadata only**
— title, authors, year, a 300-char abstract snippet, and a `zotero://` link —
for the top ~10 matches. Full papers are never sent for library questions. The
instinct that they shouldn't be is already the implementation.

### 7.2 The structural defect

In `searchLibrary()`:

```ts
const score = scoreItem(meta, keywords);
if (score > 0) { keywordResults.push({...}); }   // ← the gate
...
const shortlist = keywordResults.slice(0, maxResults * 3);
if (isModelReady() && shortlist.length > 0) { /* semantic re-rank */ }
```

Keyword scoring is a **gate**, and semantic similarity only **re-ranks the
survivors**. An item whose title, authors, tags and abstract share no literal
word with the query is eliminated before embeddings are ever consulted.

So exactly the question you want to ask — *"which papers in my library address
this research question?"*, phrased in your own words — returns little or
nothing, while a title-keyword query works fine. Semantic search is present but
cannot reach the items it exists to find.

Compounding it: abstracts truncated to 300 chars, metadata embeddings truncated
at 256 tokens (§3.3), 10 results max, no collection/tag/year filters.

### 7.3 Fix: semantic-first hybrid retrieval

1. **Embed every item at index time**, not on demand. The
   `startBackgroundEmbedding()` machinery already exists — promote it from
   fire-and-forget to a proper indexing pass with progress UI.
2. **Brute-force cosine over the whole library.** 10K items × 768 dims ×
   float32 = ~30 MB; with typed arrays this is a few milliseconds. No ANN index
   needed at Zotero library scale. Truncate to 256 dims (Matryoshka) if memory
   matters.
3. **Fuse, don't gate.** Run keyword and semantic retrieval independently and
   combine with Reciprocal Rank Fusion. Keyword becomes a *contributor*,
   so exact title/author matches still win while conceptual matches surface.
4. **Full abstracts** in the context, not 300 chars.
5. **Filters:** collection, tag, year range, item type.

### 7.4 Using the model's own knowledge of your papers — safely

You're right that the model already knows many of these papers, and that
sending metadata alone is often enough. The risk is that this is also the
easiest way to get confident fabrication about papers you own.

**Proposed contract, which fits the citation discipline already in the project:**

- The system prompt requires every claim to be tagged as either grounded in
  supplied library metadata, or drawn from general knowledge.
- The UI renders general-knowledge passages in a visually distinct style with a
  "not verified against your library" marker — the same philosophy as the
  existing strikethrough for non-whitelisted citations.
- `zotero://` links stay whitelisted to keys actually sent
  (`parseLibraryLinks` already does this — keep it).

### 7.5 Two new modes

- **Survey mode** — "what themes/methods/questions are in my library?" Returns
  a grouped synthesis with per-group citations rather than a flat ranked list.
- **Escalation** — after shortlisting, optionally pull full abstracts plus
  first-page chunks for the top 3–5 items when the question needs substance
  rather than identification. Caches per §4, and bounded by an explicit budget.

---

## 8. Proposed plan

Four phases, ordered so that each ships independently and the highest-value
work lands first.

### Phase 1 — De-stale (v0.2.0) · small, mechanical, unblocks everything

1. Model discovery from provider APIs (`/api/tags` for Ollama, models endpoints
   for cloud) replacing hardcoded defaults; free-text override retained.
2. Replace `MODEL_TOKEN_CAPS` with provider-reported windows + family heuristic
   + generous (128K) fallback. **Removes the silent 8K-cap bug.**
3. New defaults: Sonnet 5.5 (Anthropic), current Gemini Flash, current OpenAI
   small model, discovered Ollama model.
4. Anthropic provider: raise `max_tokens`, array-form `system`,
   `output_config.effort` plumbed to a settings control.
5. Dependency refresh; verify Zotero 8; add a real test runner.

### Phase 2 — Token economics (v0.3.0) · the main event

6. Restructure `buildMessages()` for prefix stability (stable system →
   stable document → history → volatile question).
7. Whole-paper mode as default below a size threshold; RAG retained for
   oversized documents and small-context local models; selection moved to
   once-per-conversation.
8. `cache_control` for Anthropic; verify automatic/implicit caching on OpenAI
   and Gemini; verify KV reuse on Ollama.
9. Cost + cache telemetry in the diagnostics footer, driven by
   `cache_read_input_tokens`.
10. Port citation anchoring to page markers for whole-paper mode.

### Phase 3 — Library intelligence (v0.4.0)

11. Semantic-first hybrid retrieval with RRF; remove the keyword gate.
12. Full-library background embedding with progress UI.
13. Embedding model upgrade (EmbeddingGemma-300m or bge-small-en-v1.5).
14. Filters, survey mode, grounded-vs-general-knowledge labeling, escalation.

### Phase 4 — Optional / later

15. **Tool-use ("agentic") retrieval** — expose `search_library`,
    `get_paper_chunks`, `get_page` as tools and let the model drive its own
    retrieval. This is the 2026-native architecture and would unify the reader
    and library paths. But it's a substantial rewrite of the orchestration
    layer, and Phase 2 captures most of the cost benefit for a fraction of the
    work. **Recommendation: defer** until Phases 1–3 are stable.
16. "Sign in with ChatGPT" transport, if/when access opens.
17. Move API keys out of plaintext prefs.

---

## 9. Decisions needed before Phase 1

1. **Target hardware for the local model** — materially changes the §6.3 pick.
2. **Whole-paper threshold** — suggest 100K tokens; above that, stay on RAG.
3. **Default cloud model** — Sonnet 5.5 (balanced) or Haiku 5.5 (1/20th the
   input price, likely sufficient here)?
4. **Embedding model** — EmbeddingGemma-300m (better) vs bge-small-en-v1.5
   (~6× smaller download)?
5. **Phase order** — Phase 2 is the highest value; Phase 1 is a prerequisite
   for little effort. Phase 3 is the biggest functional change.

---

## 10. Verification caveats

Network access in the session that produced this document was restricted.
`platform.openai.com`, `ai.google.dev`, `ollama.com` and `huggingface.co` all
failed to resolve, so **OpenAI, Gemini, Ollama and Hugging Face facts here come
from third-party aggregators that contradicted each other** and must be
re-verified against official pricing/model pages before implementation.

Confidence by source:

- **High** — Anthropic model IDs, pricing, caching semantics (authoritative
  reference); Anthropic consumer terms (fetched from anthropic.com); all
  statements about this repository's own code.
- **Medium** — "Sign in with ChatGPT" existence and shape; EmbeddingGemma and
  MiniLM specifications.
- **Low — verify before building** — exact OpenAI/Gemini model IDs and prices;
  exact Ollama tags and small-model rankings; whether an ONNX EmbeddingGemma
  build exists for transformers.js.

### Sources

Anthropic: [consumer terms](https://www.anthropic.com/legal/consumer-terms).
Claude model IDs, pricing and caching semantics come from the bundled
`claude-api` reference (cached 2026-10-06).

Third-party (unverified, conflicting):
[Claude pricing](https://costmytokens.com/claude-api-pricing/) ·
[OpenAI pricing](https://benchlm.ai/openai/api-pricing) ·
[Gemini pricing](https://www.maximem.ai/blog/gemini-api-pricing-2026) ·
[Gemini caching](https://www.morphllm.com/gemini-api-pricing) ·
[Sign in with ChatGPT](https://www.developersdigest.tech/blog/sign-in-with-chatgpt-coding-agents-plan-usage-2026) ·
[Anthropic OAuth ban reporting](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/) ·
[small local models](https://www.promptquorum.com/local-llms/small-local-llm-models) ·
[local LLMs by hardware](https://localairun.com/best-local-llm/) ·
[embedding models](https://supermemory.ai/blog/best-open-source-embedding-models-benchmarked-and-ranked/) ·
[local embeddings for RAG](https://bestllmfor.com/best/embeddings-self-hosted/)
