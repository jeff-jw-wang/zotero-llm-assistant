/**
 * Keyword-based library search and LLM context builder.
 *
 * `scoreItem()` is a pure function (no Zotero dependency) that scores a single
 * item's metadata against a set of keywords. `searchLibrary()` orchestrates
 * scoring across the in-memory index and handles privacy filtering (D5).
 * `buildLLMContext()` formats results into a string for the LLM.
 *
 * `parseLibraryLinks()` extracts `zotero://select/library/items/KEY` patterns
 * from LLM response text and marks them clickable only when the key is in an
 * allowed set (D6 — prevents hallucinated links from being rendered as trusted).
 *
 * @module modules/library/searcher
 */
import type { ItemMetadata } from "./indexer";
import { ensureIndex, getIndex } from "./indexer";
import {
  getAllPrivateItemIds,
  getAllMetaEmbeddings,
  getChunkEmbedding,
  saveChunkEmbeddings,
  type ChunkEmbeddingRecord,
} from "../storage/db";
import {
  isModelReady,
  embedText,
  embedTexts,
  cosineSimilarity,
} from "../rag/embedder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single search result with relevance score. */
export interface SearchResult {
  itemId: number;
  key: string;
  title: string;
  authors: string;
  year: string;
  abstract: string;
  score: number;
}

/** A parsed library link found in LLM response text. */
export interface ParsedLibraryLink {
  /** Full URL as it appeared in the text. */
  url: string;
  /** The Zotero item key extracted from the URL. */
  key: string;
  /** Whether the key is in the allowed whitelist. */
  allowed: boolean;
  /** Start index in the source text. */
  start: number;
  /** End index (exclusive) in the source text. */
  end: number;
}

// ---------------------------------------------------------------------------
// Scoring weights
// ---------------------------------------------------------------------------

const WEIGHT_TITLE = 30;
const WEIGHT_AUTHORS = 15;
const WEIGHT_TAGS = 20;
const WEIGHT_ABSTRACT = 5;
const WEIGHT_YEAR = 25;

/**
 * Maximum possible keyword score per keyword: title(30)+authors(15)+tags(20)+abstract(5)+year(25) = 95.
 * Used for D4 normalization. Clamped to prevent multi-keyword queries from exceeding 1.0.
 */
const MAX_LIBRARY_KEYWORD_SCORE = 95;

/** D4 blend weights — same as pipeline for consistency. */
const KEYWORD_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;
const BLEND_SCALE = 100;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scores a single item's metadata against a list of lowercase keywords.
 *
 * This is a pure function — no side effects, no Zotero dependency.
 * Intended to be easily unit-tested.
 *
 * Scoring rules (keyword-only):
 * - Title match: +30 per keyword
 * - Authors match: +15 per keyword
 * - Tags match: +20 per keyword (any tag)
 * - Abstract match: +5 per keyword
 * - Exact 4-digit year match: +25 (only for keywords that look like years)
 *
 * When `semanticScore` is provided (Stage 2 active), uses the D4 unified
 * normalized blend formula. When undefined (Stage 2 skipped), returns raw
 * keyword score.
 *
 * @param meta - Item metadata to score.
 * @param keywords - Lowercase keywords from the query.
 * @param semanticScore - Optional cosine similarity (0–1), pre-clamped.
 */
export function scoreItem(
  meta: ItemMetadata,
  keywords: string[],
  semanticScore?: number,
): number {
  let keywordScore = 0;

  const titleLower = meta.title.toLowerCase();
  const authorsLower = meta.authors.toLowerCase();
  const abstractLower = meta.abstract.toLowerCase();
  const tagsLower = meta.tags.map((t) => t.toLowerCase());

  for (const kw of keywords) {
    if (titleLower.includes(kw)) keywordScore += WEIGHT_TITLE;
    if (authorsLower.includes(kw)) keywordScore += WEIGHT_AUTHORS;
    if (tagsLower.some((t) => t.includes(kw))) keywordScore += WEIGHT_TAGS;
    if (abstractLower.includes(kw)) keywordScore += WEIGHT_ABSTRACT;

    // Year match: only for 4-digit numeric keywords.
    if (/^\d{4}$/.test(kw) && meta.year === kw) keywordScore += WEIGHT_YEAR;
  }

  // D4: when semanticScore is provided, blend on normalized scale.
  if (semanticScore !== undefined) {
    const normKeyword = Math.min(1, keywordScore / MAX_LIBRARY_KEYWORD_SCORE);
    return Math.round(
      (KEYWORD_WEIGHT * normKeyword + SEMANTIC_WEIGHT * semanticScore) *
        BLEND_SCALE,
    );
  }

  return keywordScore;
}

/** Reciprocal Rank Fusion constant, from the original RRF paper. */
export const RRF_K = 60;

/**
 * Combines several ranked lists into one with Reciprocal Rank Fusion.
 *
 *     score(key) = Σ over lists  1 / (k + rank_in_that_list)
 *
 * RRF is used rather than a weighted sum of the underlying scores because
 * keyword scores (unbounded integers) and cosine similarities (-1..1) are on
 * incomparable scales, whereas ranks are comparable by construction. An item
 * appearing in both lists outranks one that appears in only a single list at a
 * similar position, which is the behaviour hybrid retrieval wants.
 *
 * Pure function — no Zotero or storage dependency.
 *
 * @param lists - Ranked lists, each already sorted best-first.
 * @param k - Rank-smoothing constant; higher flattens the curve.
 * @returns Keys with fused scores, sorted best-first.
 */
export function fuseRankings(
  lists: string[][],
  k: number = RRF_K,
): Array<{ key: string; score: number }> {
  const fused = new Map<string, number>();

  for (const list of lists) {
    list.forEach((key, index) => {
      // Ranks are 1-based.
      fused.set(key, (fused.get(key) ?? 0) + 1 / (k + index + 1));
    });
  }

  return [...fused.entries()]
    .map(([key, score]) => ({ key, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** Diagnostics about how a search was resolved, for display in the UI. */
export interface SearchDiagnostics {
  /** Items in the library index that were eligible (after privacy filtering). */
  candidates: number;
  /** Items that matched at least one keyword. */
  keywordMatches: number;
  /** Items that had a usable metadata embedding, i.e. semantic coverage. */
  semanticCovered: number;
  /** Whether the semantic pass ran at all. */
  semanticActive: boolean;
}

/**
 * Searches the library with semantic-first hybrid retrieval.
 *
 * **What changed and why.** The previous implementation used keyword score as
 * a *gate*: it kept only items with `score > 0`, took the top `maxResults * 3`
 * of those, and let semantic similarity merely re-rank that shortlist. An item
 * whose title, authors, tags and abstract shared no literal word with the
 * query was eliminated before embeddings were ever consulted — so the exact
 * question this feature exists for ("which papers in my library address this
 * research question?", phrased in the user's own words) returned little or
 * nothing, while a title-keyword query worked fine. Semantic search was
 * present but structurally unable to reach the items it existed to find.
 *
 * Now the two retrievers run **independently over the whole library** and are
 * combined with Reciprocal Rank Fusion:
 *
 *     score(item) = Σ over lists  1 / (RRF_K + rank_in_that_list)
 *
 * RRF is used rather than a weighted sum of raw scores because keyword scores
 * and cosine similarities are on incomparable scales; ranks are comparable by
 * construction. Keyword matching becomes a *contributor*, so an exact title or
 * author match still wins, while a purely conceptual match can now surface.
 *
 * Semantic coverage grows in the background (see `startBackgroundEmbedding`),
 * so a freshly-installed library starts keyword-only and improves as indexing
 * proceeds. `SearchDiagnostics.semanticCovered` reports how far along that is.
 *
 * @param query - User search query.
 * @param opts.maxResults - Maximum results to return (default 10).
 * @param opts.excludePrivate - If true, omit items flagged as private (D5):
 *   fully removed, with no placeholder and no count revealed.
 */
export async function searchLibraryDetailed(
  query: string,
  opts?: { maxResults?: number; excludePrivate?: boolean },
): Promise<{ results: SearchResult[]; diagnostics: SearchDiagnostics }> {
  await ensureIndex();

  const maxResults = opts?.maxResults ?? 10;
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const empty: SearchDiagnostics = {
    candidates: 0,
    keywordMatches: 0,
    semanticCovered: 0,
    semanticActive: false,
  };

  if (query.trim().length === 0) {
    return { results: [], diagnostics: empty };
  }

  // D5: private items are excluded from the candidate set entirely, before any
  // ranking, so neither retriever can leak their existence.
  let privateIds: Set<number> | null = null;
  if (opts?.excludePrivate) {
    privateIds = await getAllPrivateItemIds();
  }

  const candidates: SearchResult[] = [];
  for (const [_id, meta] of getIndex()) {
    if (privateIds && privateIds.has(meta.itemId)) continue;
    candidates.push({
      itemId: meta.itemId,
      key: meta.key,
      title: meta.title,
      authors: meta.authors,
      year: meta.year,
      abstract: meta.abstract,
      score: 0,
    });
  }

  if (candidates.length === 0) {
    return { results: [], diagnostics: empty };
  }

  const byKey = new Map(candidates.map((c) => [c.key, c]));

  // --- Retriever 1: keyword ---
  // Needs the full ItemMetadata (tags are only on the index entry), so score
  // from the index rather than from the trimmed SearchResult.
  const keywordScored: Array<{ key: string; score: number }> = [];
  if (keywords.length > 0) {
    for (const [_id, meta] of getIndex()) {
      if (!byKey.has(meta.key)) continue; // filtered out above
      const score = scoreItem(meta, keywords);
      if (score > 0) keywordScored.push({ key: meta.key, score });
    }
    keywordScored.sort((a, b) => b.score - a.score);
  }

  // --- Retriever 2: semantic, over every item that has a vector ---
  const semanticScored: Array<{ key: string; score: number }> = [];
  let semanticActive = false;

  if (isModelReady()) {
    try {
      const [queryVec, metaVectors] = await Promise.all([
        embedText(query),
        getAllMetaEmbeddings(),
      ]);

      for (const candidate of candidates) {
        const vec = metaVectors.get(candidate.key);
        if (!vec) continue; // Not embedded yet — background job will catch up.
        semanticScored.push({
          key: candidate.key,
          score: cosineSimilarity(queryVec, vec),
        });
      }

      semanticScored.sort((a, b) => b.score - a.score);
      semanticActive = true;

      // Keep extending coverage for next time.
      void startBackgroundEmbedding().catch((e: any) =>
        ztoolkit.log("Background embedding error: " + e?.message),
      );
    } catch (err: any) {
      // Semantic retrieval failed — degrade to keyword-only rather than error.
      ztoolkit.log("Semantic retrieval failed: " + err?.message);
    }
  }

  // --- Fuse with Reciprocal Rank Fusion ---
  const results = fuseRankings([
    keywordScored.map((e) => e.key),
    semanticScored.map((e) => e.key),
  ])
    .slice(0, maxResults)
    .map(({ key, score }) => {
      const item = byKey.get(key)!;
      // Scale to a readable integer; RRF scores are small fractions.
      return { ...item, score: Math.round(score * 10_000) };
    });

  return {
    results,
    diagnostics: {
      candidates: candidates.length,
      keywordMatches: keywordScored.length,
      semanticCovered: semanticScored.length,
      semanticActive,
    },
  };
}

/**
 * Searches the library, returning results only.
 *
 * Thin wrapper over {@link searchLibraryDetailed} for callers that do not need
 * retrieval diagnostics.
 */
export async function searchLibrary(
  query: string,
  opts?: { maxResults?: number; excludePrivate?: boolean },
): Promise<SearchResult[]> {
  const { results } = await searchLibraryDetailed(query, opts);
  return results;
}

// ---------------------------------------------------------------------------
// Background embedding (single-flight)
// ---------------------------------------------------------------------------

/** Module-level guard for background embedding job. */
let backgroundIndexPromise: Promise<void> | null = null;

/**
 * Starts a background job to embed metadata for un-embedded library items.
 * Single-flight: if a job is already running, returns immediately.
 * In-memory cursor — not persisted across sessions (D9).
 */
async function startBackgroundEmbedding(): Promise<void> {
  if (backgroundIndexPromise) return; // Already running.
  if (!isModelReady()) return;

  backgroundIndexPromise = (async () => {
    try {
      const index = getIndex();
      const batch: Array<{ key: string; itemId: number; text: string }> = [];

      for (const [_id, meta] of index) {
        const metaChunkId = "meta:" + meta.key;
        const cached = await getChunkEmbedding(metaChunkId);
        if (cached) continue; // Already embedded.

        batch.push({
          key: meta.key,
          itemId: meta.itemId,
          text: `${meta.title} ${meta.abstract}`,
        });

        // Process in batches of 10 to avoid blocking.
        if (batch.length >= 10) {
          await processBatch(batch.splice(0, 10));
          await new Promise<void>((r) => setTimeout(r, 0));
        }
      }

      // Process remaining items.
      if (batch.length > 0) {
        await processBatch(batch);
      }
    } finally {
      backgroundIndexPromise = null;
    }
  })();

  return backgroundIndexPromise;
}

/**
 * Embeds a batch of metadata texts and saves to IndexedDB.
 */
async function processBatch(
  batch: Array<{ key: string; itemId: number; text: string }>,
): Promise<void> {
  const texts = batch.map((b) => b.text);
  const vectors = await embedTexts(texts);
  const now = new Date().toISOString();
  const records: ChunkEmbeddingRecord[] = batch.map((b, i) => ({
    chunkId: "meta:" + b.key,
    itemId: b.itemId,
    vector: vectors[i]!,
    updatedAt: now,
  }));
  await saveChunkEmbeddings(records);
}

/**
 * Maximum abstract length included per item, in characters.
 *
 * Was 300, which cut most abstracts off mid-sentence and gave the model an
 * unreliable basis for judging relevance. 1500 covers essentially every real
 * abstract; at ten results that is roughly 4K tokens of context, which is
 * negligible against the budgets resolved in `modules/llm/models.ts` and is
 * the cheapest quality win available on the library path.
 */
export const MAX_ABSTRACT_CHARS = 1500;

/**
 * Builds a context string for the LLM from search results.
 *
 * Receives only the already-filtered result list (privacy handled upstream by
 * `searchLibrary` — D5). Emits every item unconditionally.
 *
 * @param results - Search results to include in the context.
 */
export function buildLLMContext(results: SearchResult[]): string {
  return results
    .map((r) => {
      const abstractSnippet =
        r.abstract.length > MAX_ABSTRACT_CHARS
          ? r.abstract.slice(0, MAX_ABSTRACT_CHARS) + "..."
          : r.abstract;
      return [
        `Title: ${r.title}`,
        `Authors: ${r.authors}`,
        `Year: ${r.year}`,
        `Abstract: ${abstractSnippet}`,
        `Link: zotero://select/library/items/${r.key}`,
      ].join("\n");
    })
    .join("\n---\n");
}

/**
 * Parses `zotero://select/library/items/KEY` patterns in LLM response text.
 *
 * Returns an array of parsed links, each annotated with whether the key is
 * in the allowed whitelist (D6). The UI renderer uses this to decide whether
 * to make the link clickable (allowed) or render as plain text (not allowed).
 *
 * @param text - The LLM response text.
 * @param allowedKeys - Set of item keys from the search results sent to the LLM.
 */
export function parseLibraryLinks(
  text: string,
  allowedKeys: Set<string>,
): ParsedLibraryLink[] {
  const regex = /zotero:\/\/select\/library\/items\/([A-Za-z0-9]+)/g;
  const links: ParsedLibraryLink[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    links.push({
      url: match[0],
      key: match[1]!,
      allowed: allowedKeys.has(match[1]!),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return links;
}
