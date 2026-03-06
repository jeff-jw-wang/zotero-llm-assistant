/**
 * RAG pipeline — orchestrates PDF extraction, chunking, scoring, selection,
 * and LLM prompt construction.
 *
 * This is the single entry point for `readerPanel.ts` to build a fully
 * assembled LLM request from a user question + Zotero item. It replaces
 * the Phase A pattern of calling extractor + buildContext + buildMessages
 * inline.
 *
 * Flow:
 *   1. Extract PDF text (cached per item to avoid re-extraction)
 *   2. Chunk pages into ~512-token segments with content-hashed IDs
 *   3. Score chunks by keyword overlap + structural priority
 *   4. Greedily select top chunks within the model's token budget
 *   5. Build context string with chunk markers [c.ID pp.X-Y]
 *   6. Assemble full LLM message array via client.buildMessages()
 *
 * Caching:
 *   Extraction + chunking results are cached in-memory per Zotero item ID.
 *   Cache entries are content-hashed and deterministic for the same PDF, so
 *   they remain valid across item switches. The cache lives for the session.
 *   Call `clearItemCache(itemId)` explicitly if a PDF is re-indexed or its
 *   content changes. This avoids re-extracting the same PDF on every
 *   follow-up question in a conversation.
 *
 * @module modules/rag/pipeline
 * @see PLAN_PHASE_B.md — Steps 2-3
 */

import { extractPDF } from "./extractor";
import { chunkPages, type Chunk } from "./chunker";
import { buildMessages } from "../llm/client";
import { getTokenCap, getTopKCap } from "../../utils/tokens";
import type { LLMMessage } from "../llm/types";
import {
  isModelReady,
  embedText,
  embedTexts,
  cosineSimilarity,
} from "./embedder";
import {
  getChunkEmbeddingsByItemId,
  saveChunkEmbeddings,
  type ChunkEmbeddingRecord,
} from "../storage/db";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Metadata about a selected chunk, used for citation rendering + storage. */
export interface ChunkMeta {
  /** First page this chunk appears on (1-based). */
  pageStart: number;
  /** Last page this chunk appears on (1-based). */
  pageEnd: number;
  /** First ~80 characters of chunk text (for tooltip display). */
  excerpt: string;
}

/** Result of the RAG pipeline, ready for LLM call + UI rendering. */
export interface PipelineResult {
  /** Fully assembled LLM message array (system + document + history + question). */
  messages: LLMMessage[];
  /**
   * Map of selected chunk IDs → metadata. Only chunk IDs present in this map
   * are valid citations. Used for citation whitelist enforcement in the UI.
   */
  chunkWhitelist: Map<string, ChunkMeta>;
  /** Stats for the UI system note. */
  stats: {
    totalPages: number;
    totalChunks: number;
    selectedChunks: number;
  };
}

// ---------------------------------------------------------------------------
// Per-item extraction/chunk cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  chunks: Chunk[];
  attachmentKey: string;
  totalPages: number;
}

const itemCache = new Map<number, CacheEntry>();

/**
 * Clears the cached extraction/chunks for a given item, or the entire cache
 * if no item ID is provided. Call this if a PDF is re-indexed or its content
 * changes. Not needed on item switch — cache entries are deterministic.
 */
export function clearItemCache(itemId?: number): void {
  if (itemId !== undefined) {
    itemCache.delete(itemId);
  } else {
    itemCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

/** Overhead per chunk marker: [c.xxxxxxxx pp.XX-XX]\n...\n[/c.xxxxxxxx] */
const MARKER_OVERHEAD = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds the full RAG context for a user question about a Zotero item.
 *
 * @param item - The Zotero item being discussed (must have a PDF attachment).
 * @param question - The user's current question.
 * @param conversationHistory - Previous messages (excluding system + current question).
 * @param model - The LLM model identifier (for token cap lookup).
 * @returns Pipeline result with messages, chunk whitelist, and stats.
 */
export async function buildRAGContext(
  item: Zotero.Item,
  question: string,
  conversationHistory: LLMMessage[],
  model: string,
): Promise<PipelineResult> {
  // --- Step 1-2: Extract + Chunk (with cache) ---
  let cached = itemCache.get(item.id);
  if (!cached) {
    const extraction = await extractPDF(item);
    if (!extraction || extraction.pages.length === 0) {
      // No PDF content — return empty context.
      const messages = buildMessages("", question, conversationHistory);
      return {
        messages,
        chunkWhitelist: new Map(),
        stats: { totalPages: 0, totalChunks: 0, selectedChunks: 0 },
      };
    }

    const chunks = chunkPages(extraction.pages, extraction.attachmentKey);
    cached = {
      chunks,
      attachmentKey: extraction.attachmentKey,
      totalPages: extraction.totalPages,
    };
    itemCache.set(item.id, cached);
  }

  const { chunks, totalPages } = cached;

  // --- Step 3: Score chunks (with optional embeddings) ---
  let chunkEmbeddings: Map<string, number[]> | undefined;
  let questionEmbedding: number[] | undefined;

  if (isModelReady()) {
    try {
      // Load cached chunk embeddings from IndexedDB.
      const cachedRecords = await getChunkEmbeddingsByItemId(item.id);
      const cachedMap = new Map<string, number[]>();
      for (const rec of cachedRecords) {
        cachedMap.set(rec.chunkId, rec.vector);
      }

      // Find chunks missing embeddings and compute them.
      const missingChunks = chunks.filter((c) => !cachedMap.has(c.id));
      if (missingChunks.length > 0) {
        const missingTexts = missingChunks.map((c) => c.text);
        const missingVecs = await embedTexts(missingTexts);
        const now = new Date().toISOString();
        const newRecords: ChunkEmbeddingRecord[] = missingChunks.map(
          (c, i) => ({
            chunkId: c.id,
            itemId: item.id,
            vector: missingVecs[i]!,
            updatedAt: now,
          }),
        );
        await saveChunkEmbeddings(newRecords);
        for (const rec of newRecords) {
          cachedMap.set(rec.chunkId, rec.vector);
        }
      }

      chunkEmbeddings = cachedMap;

      // Embed the question (single short string — fast).
      questionEmbedding = await embedText(question);
    } catch (err: any) {
      // Embedding failed — fall back to keyword-only scoring silently.
      ztoolkit.log(
        `Pipeline: embedding failed, using keyword-only scoring: ${err?.message}`,
      );
      chunkEmbeddings = undefined;
      questionEmbedding = undefined;
    }
  }

  const scored = scoreChunks(chunks, question, chunkEmbeddings, questionEmbedding);

  // --- Step 4: Select within token budget + dynamic topK cap ---
  const tokenCap = getTokenCap(model);
  const maxChunks = getTopKCap(model); // Caps chunk COUNT independent of token budget.
  const selected = selectChunks(scored, tokenCap, maxChunks);

  // --- Step 5: Build context string + whitelist ---
  // Re-sort selected chunks by page order for coherent reading.
  selected.sort((a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd);

  const contextParts: string[] = [];
  const chunkWhitelist = new Map<string, ChunkMeta>();

  for (const chunk of selected) {
    const pageRange =
      chunk.pageStart === chunk.pageEnd
        ? `p.${chunk.pageStart}`
        : `pp.${chunk.pageStart}-${chunk.pageEnd}`;
    contextParts.push(
      `[c.${chunk.id} ${pageRange}]\n${chunk.text}\n[/c.${chunk.id}]`,
    );
    chunkWhitelist.set(chunk.id, {
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      excerpt: chunk.text.slice(0, 80).replace(/\n/g, " "),
    });
  }

  const context = contextParts.join("\n\n");

  // --- Step 6: Build messages ---
  const messages = buildMessages(context, question, conversationHistory);

  return {
    messages,
    chunkWhitelist,
    stats: {
      totalPages,
      totalChunks: chunks.length,
      selectedChunks: selected.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk scoring
// ---------------------------------------------------------------------------

interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * Maximum possible keyword score for a single chunk in the pipeline.
 * Used for normalization in the D4 blend formula.
 * Approx: abstract(80) + introduction(80) + conclusion(60) + discussion(40)
 * + method(20) + position(100) + ~5 keyword matches(50) ≈ 430.
 * We use 300 as a practical cap — most chunks won't hit all boosts.
 */
const MAX_PIPELINE_KEYWORD_SCORE = 300;

/** D4 blend weights. */
const KEYWORD_WEIGHT = 0.6;
const SEMANTIC_WEIGHT = 0.4;
const BLEND_SCALE = 100;

/**
 * Scores each chunk by keyword overlap with the question and structural
 * priority (abstract, introduction, conclusion, etc.).
 *
 * When embeddings are provided (semantic mode active), scores use the D4
 * normalized blend formula. Missing chunk vectors get normSemantic=0 to
 * maintain a consistent ranking scale.
 *
 * When embeddings are not provided, returns raw keyword scores.
 */
function scoreChunks(
  chunks: Chunk[],
  question: string,
  chunkEmbeddings?: Map<string, number[]>,
  questionEmbedding?: number[],
): ScoredChunk[] {
  const questionWords = new Set(
    question
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );

  const semanticModeActive =
    chunkEmbeddings !== undefined && questionEmbedding !== undefined;

  return chunks.map((chunk, index) => {
    let keywordScore = 0;
    const lower = chunk.text.toLowerCase();

    // Structural boosts.
    if (/\babstract\b/.test(lower)) keywordScore += 80;
    if (/\bintroduction\b/.test(lower)) keywordScore += 80;
    if (/\bconclusion\b/.test(lower)) keywordScore += 60;
    if (/\bdiscussion\b/.test(lower)) keywordScore += 40;
    if (/\bmethods?\b/.test(lower)) keywordScore += 20;

    // Position boosts: first and last chunk.
    if (index === 0) keywordScore += 100;
    if (index === chunks.length - 1) keywordScore += 50;

    // Keyword overlap.
    for (const word of questionWords) {
      if (lower.includes(word)) keywordScore += 10;
    }

    // D4 blend: use normalized scale when semantic mode is active.
    let finalScore: number;
    if (semanticModeActive) {
      const normKeyword = Math.min(1, keywordScore / MAX_PIPELINE_KEYWORD_SCORE);
      const chunkVec = chunkEmbeddings!.get(chunk.id);
      const rawSimilarity = chunkVec
        ? cosineSimilarity(questionEmbedding!, chunkVec)
        : 0;
      const normSemantic = Math.max(0, rawSimilarity);
      finalScore =
        (KEYWORD_WEIGHT * normKeyword + SEMANTIC_WEIGHT * normSemantic) *
        BLEND_SCALE;
    } else {
      finalScore = keywordScore;
    }

    return { ...chunk, score: finalScore };
  });
}

// ---------------------------------------------------------------------------
// Chunk selection (greedy budget fill)
// ---------------------------------------------------------------------------

/**
 * Greedily selects top-scoring chunks within the token budget and chunk count cap.
 *
 * Two constraints are applied:
 *   1. Token budget (maxTokens): total chars ≤ maxTokens × 4
 *   2. Dynamic topK (maxChunks): number of chunks ≤ maxChunks
 *
 * If no chunks fit, truncates the highest-scoring chunk to the budget.
 *
 * @param maxChunks - Optional maximum chunk count (dynamic topK from getTopKCap()).
 */
function selectChunks(
  scored: ScoredChunk[],
  maxTokens: number,
  maxChunks?: number,
): Chunk[] {
  // Sort by score descending; apply topK cap before budget fill.
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const candidates = maxChunks !== undefined ? sorted.slice(0, maxChunks) : sorted;

  const budget = maxTokens * CHARS_PER_TOKEN;
  const selected: Chunk[] = [];
  let usedChars = 0;

  for (const chunk of candidates) {
    const chunkChars = chunk.text.length + MARKER_OVERHEAD;
    if (usedChars + chunkChars > budget) continue;
    selected.push(chunk);
    usedChars += chunkChars;
  }

  // Guard: always include at least one chunk (truncated to budget), so the
  // user gets some context even when a single chunk exceeds the token cap.
  if (selected.length === 0 && candidates.length > 0) {
    const top = candidates[0]!;
    const maxChars = Math.max(budget - MARKER_OVERHEAD, 100);
    selected.push({
      id: top.id,
      text:
        top.text.slice(0, maxChars) +
        (top.text.length > maxChars ? "…" : ""),
      pageStart: top.pageStart,
      pageEnd: top.pageEnd,
    });
  }

  return selected;
}
