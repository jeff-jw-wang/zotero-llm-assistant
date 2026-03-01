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

/**
 * Searches the library index for items matching the query.
 *
 * Uses two-stage retrieval (D9):
 * 1. Stage 1 — Keyword shortlist: fast keyword scoring on all items, take top-K.
 * 2. Stage 2 — Semantic re-rank (only if model ready): embed query + shortlisted
 *    items' title+abstract, re-rank by D4 blended score.
 *
 * Calls `ensureIndex()` to lazily build the index on first use (D3).
 *
 * When `excludePrivate` is true, private items are fully removed from results
 * — no placeholder emitted, no count revealed (D5).
 *
 * @param query - User search query.
 * @param opts.maxResults - Maximum results to return (default 10).
 * @param opts.excludePrivate - If true, omit items flagged as private.
 */
export async function searchLibrary(
  query: string,
  opts?: { maxResults?: number; excludePrivate?: boolean },
): Promise<SearchResult[]> {
  await ensureIndex();

  const maxResults = opts?.maxResults ?? 10;
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  if (keywords.length === 0) return [];

  // Optionally load private item IDs for filtering.
  let privateIds: Set<number> | null = null;
  if (opts?.excludePrivate) {
    privateIds = await getAllPrivateItemIds();
  }

  // --- Stage 1: Keyword shortlist ---
  const keywordResults: SearchResult[] = [];

  for (const [_id, meta] of getIndex()) {
    // D5: fully exclude private items for cloud providers.
    if (privateIds && privateIds.has(meta.itemId)) continue;

    const score = scoreItem(meta, keywords);
    if (score > 0) {
      keywordResults.push({
        itemId: meta.itemId,
        key: meta.key,
        title: meta.title,
        authors: meta.authors,
        year: meta.year,
        abstract: meta.abstract,
        score,
      });
    }
  }

  keywordResults.sort((a, b) => b.score - a.score);

  // --- Stage 2: Semantic re-rank (if model ready) ---
  const shortlistSize = maxResults * 3;
  const shortlist = keywordResults.slice(0, shortlistSize);

  if (isModelReady() && shortlist.length > 0) {
    try {
      // Embed the query.
      const queryVec = await embedText(query);

      // For each shortlisted item, get or compute the metadata embedding.
      for (const result of shortlist) {
        const metaChunkId = "meta:" + result.key;
        let cached = await getChunkEmbedding(metaChunkId);

        if (!cached) {
          // Compute and cache the metadata embedding (title + abstract).
          const text = `${result.title} ${result.abstract}`;
          const [vector] = await embedTexts([text]);
          if (vector) {
            const record: ChunkEmbeddingRecord = {
              chunkId: metaChunkId,
              itemId: result.itemId,
              vector,
              updatedAt: new Date().toISOString(),
            };
            await saveChunkEmbeddings([record]);
            cached = record;
          }
        }

        if (cached) {
          const rawSimilarity = cosineSimilarity(queryVec, cached.vector);
          const normSemantic = Math.max(0, rawSimilarity);
          // Re-score with blended formula.
          result.score = scoreItem(
            {
              itemId: result.itemId,
              key: result.key,
              title: result.title,
              authors: result.authors,
              year: result.year,
              abstract: result.abstract,
              tags: [], // Tags already scored in keyword pass.
              doi: "",
              itemType: "",
            },
            keywords,
            normSemantic,
          );
        } else {
          // Embedding failed — use normSemantic=0 on blended scale.
          result.score = scoreItem(
            {
              itemId: result.itemId,
              key: result.key,
              title: result.title,
              authors: result.authors,
              year: result.year,
              abstract: result.abstract,
              tags: [],
              doi: "",
              itemType: "",
            },
            keywords,
            0,
          );
        }
      }

      // Re-sort by blended score.
      shortlist.sort((a, b) => b.score - a.score);

      // Fire-and-forget background indexing (D9).
      void startBackgroundEmbedding().catch((e: any) =>
        ztoolkit.log("Background embedding error: " + e?.message),
      );
    } catch (err: any) {
      // Semantic re-rank failed — fall through with keyword-only results.
      ztoolkit.log("Semantic re-rank failed: " + err?.message);
    }
  }

  return shortlist.slice(0, maxResults);
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
        r.abstract.length > 300
          ? r.abstract.slice(0, 300) + "..."
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
