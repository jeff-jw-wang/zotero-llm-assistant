/**
 * RAG pipeline — orchestrates PDF extraction, chunking, scoring, selection,
 * and LLM prompt construction.
 *
 * This is the single entry point for `readerPanel.ts` to build a fully
 * assembled LLM request from a user question + Zotero item. It replaces
 * the Phase A pattern of calling extractor + buildContext + buildMessages
 * inline.
 *
 * Two context modes:
 *
 *   **whole-paper** — chosen when the full text is no larger than the plan's
 *   whole-paper limit (`PromptPlan.wholePaperMax`). The document is sent once,
 *   page-marked and unchanged, behind a prompt-cache breakpoint. Citations are
 *   page numbers, validated against the page count.
 *
 *   **chunk-rag** — for larger documents and small local contexts. Sections
 *   are sent in two parts (docs/MODERNIZATION_PLAN_2026.md §5.2):
 *
 *     - a **core**, chosen once per conversation (structural sections plus the
 *       best matches for the first question), placed in the cached document
 *       message and never changed afterwards;
 *     - a **supplement** of a few sections specific to the current question
 *       that are not in the core, attached to the question message and
 *       replaced every turn.
 *
 *   The prompt prefix therefore stays byte-identical across turns in both
 *   modes, so cloud caching works on large documents and Ollama can reuse its
 *   prompt state on follow-ups, while each question still gets targeted text.
 *
 * In both modes the document block is sized from the model and the settings
 * only. Conversation history is what gives way when space is short: the
 * oldest messages are dropped until the whole prompt fits.
 *
 * Flow:
 *   1. Extract PDF text (cached per item to avoid re-extraction)
 *   2. Chunk pages into ~512-token segments with content-hashed IDs
 *   3. Load or compute chunk embeddings, when an embedding model is ready
 *   4. `assembleContext()` — pure: choose the mode, the core and supplement,
 *      trim history, build the messages
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
import {
  buildMessages,
  getSystemPrompt,
  type ContextMode,
} from "../llm/client";
import { getTopKCapForBudget, estimateTokens } from "../../utils/tokens";
import type { LLMMessage } from "../llm/types";
import {
  fitHistory,
  messageTokens,
  promptTokens,
  type PromptPlan,
} from "../llm/budget";
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
  /**
   * How the paper was supplied. Decides the citation scheme the model was told
   * to use, and therefore how the UI must render citations.
   */
  mode: ContextMode;
  /**
   * Total pages in the document, in whole-paper mode. Acts as the page
   * citation whitelist: `[p.N]` is valid only for 1 <= N <= pageCount, so a
   * hallucinated page is still caught, exactly as an unknown chunk ID is.
   */
  pageCount?: number;
  /** Stats for the UI system note. */
  stats: {
    totalPages: number;
    totalChunks: number;
    selectedChunks: number;
    /** Estimated input tokens of the document block actually sent. */
    contextTokens: number;
    /** Sections attached to this question only (chunk-rag mode). */
    supplementChunks: number;
    /** Earlier messages left out so the prompt fits. */
    historyDropped: number;
    /** Estimated tokens of the whole assembled prompt. */
    promptTokens: number;
  };
  /**
   * The stable core chosen for this conversation (chunk-rag mode). Pass it
   * back as `previousCore` on the next turn so the document block is rebuilt
   * identically.
   */
  core?: CoreSelection;
}

/** The sections fixed into a conversation's cached document block. */
export interface CoreSelection {
  /** Chunk IDs, in the order they were selected. */
  chunkIds: string[];
  /** The `PromptPlan.coreMax` the selection was made for. */
  coreMax: number;
}

// ---------------------------------------------------------------------------
// Per-item extraction/chunk cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  chunks: Chunk[];
  attachmentKey: string;
  totalPages: number;
  /** Extracted pages, retained so whole-paper mode need not re-extract. */
  pages: Array<{ page: number; text: string }>;
}

const itemCache = new Map<number, CacheEntry>();

/** The core selection of each item's current conversation. Session-only. */
const coreCache = new Map<number, CoreSelection>();

/**
 * Forgets the core selection for an item (or all items), so the next question
 * chooses a fresh one. Call when a conversation is cleared.
 */
export function clearCoreSelection(itemId?: number): void {
  if (itemId !== undefined) {
    coreCache.delete(itemId);
  } else {
    coreCache.clear();
  }
}

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
  clearCoreSelection(itemId);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4;

/** Most sections attached to a single question as its supplement. */
const MAX_SUPPLEMENT_CHUNKS = 3;

/** The fixed assistant turn `buildMessages()` adds after a document. */
const ACK_OVERHEAD_TOKENS = 30;

/**
 * Renders the full document with page markers, for whole-paper mode.
 *
 * The output depends only on the PDF, never on the question, which is the
 * whole point: a question-independent document block means a byte-identical
 * prompt prefix across turns, which is what lets prompt caching work. See
 * docs/MODERNIZATION_PLAN_2026.md §4.
 */
export function buildWholePaperContext(
  pages: Array<{ page: number; text: string }>,
): string {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => `[p.${p.page}]\n${p.text.trim()}`)
    .join("\n\n");
}

/** Overhead per chunk marker: [c.xxxxxxxx pp.XX-XX]\n...\n[/c.xxxxxxxx] */
const MARKER_OVERHEAD = 50;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Renders chunks with their citation markers, in page order. */
function renderChunks(
  chunks: Chunk[],
  whitelist: Map<string, ChunkMeta>,
): string {
  const ordered = [...chunks].sort(
    (a, b) => a.pageStart - b.pageStart || a.pageEnd - b.pageEnd,
  );
  const parts: string[] = [];
  for (const chunk of ordered) {
    const pageRange =
      chunk.pageStart === chunk.pageEnd
        ? `p.${chunk.pageStart}`
        : `pp.${chunk.pageStart}-${chunk.pageEnd}`;
    parts.push(`[c.${chunk.id} ${pageRange}]\n${chunk.text}\n[/c.${chunk.id}]`);
    whitelist.set(chunk.id, {
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      excerpt: chunk.text.slice(0, 80).replace(/\n/g, " "),
    });
  }
  return parts.join("\n\n");
}

/** Inputs to {@link assembleContext}. */
export interface AssembleInput {
  /** Extracted pages, for whole-paper mode. */
  pages: Array<{ page: number; text: string }>;
  /** The same text, chunked, for chunk-rag mode. */
  chunks: Chunk[];
  totalPages: number;
  question: string;
  /** Earlier messages, oldest first, without the current question. */
  history: LLMMessage[];
  /** Allowances from `planPrompt()`. */
  plan: PromptPlan;
  /** Core chosen earlier in this conversation, if any. */
  previousCore?: CoreSelection;
  /** Chunk vectors and the question vector, when embeddings are available. */
  chunkEmbeddings?: Map<string, number[]>;
  questionEmbedding?: number[];
}

/**
 * Builds the messages for one question from already-extracted text.
 *
 * Pure: no Zotero, no network, no storage. Given the same inputs it returns
 * the same messages, which is what makes the cached prefix testable.
 *
 * The core is reused from `previousCore` when the conversation is continuing
 * (`history` is non-empty), it was chosen for the same `plan.coreMax`, and all
 * of its chunks still exist. Otherwise a new core is chosen from this
 * question — a new conversation, a changed model or setting, or a re-indexed
 * PDF.
 */
export function assembleContext(input: AssembleInput): PipelineResult {
  const { pages, chunks, totalPages, question, history, plan } = input;

  const systemAndQuestion = (mode: ContextMode, supplementTokens: number) =>
    messageTokens({ content: getSystemPrompt(mode) }) +
    messageTokens({ content: question }) +
    supplementTokens +
    ACK_OVERHEAD_TOKENS;

  const finish = (
    mode: ContextMode,
    documentText: string,
    supplementText: string,
    rest: Omit<PipelineResult, "messages" | "mode" | "stats"> & {
      stats: Omit<
        PipelineResult["stats"],
        "contextTokens" | "historyDropped" | "promptTokens"
      >;
    },
  ): PipelineResult => {
    const contextTokens = estimateTokens(documentText);
    const supplementTokens = supplementText
      ? estimateTokens(supplementText)
      : 0;
    const historyMax =
      plan.promptCapacity -
      contextTokens -
      systemAndQuestion(mode, supplementTokens);
    const kept = fitHistory(history, historyMax);
    const messages = buildMessages(
      documentText,
      question,
      kept,
      mode,
      supplementText,
    );
    return {
      ...rest,
      messages,
      mode,
      stats: {
        ...rest.stats,
        contextTokens,
        historyDropped: history.length - kept.length,
        promptTokens: promptTokens(messages),
      },
    };
  };

  // --- Whole-paper mode: the full text is within the whole-paper limit ---
  //
  // The limit comes from the model and the settings only, so the decision is
  // the same on every turn and the document block never changes.
  const wholeContext = buildWholePaperContext(pages);
  const wholeTokens = estimateTokens(wholeContext);

  if (wholeContext && wholeTokens <= plan.wholePaperMax) {
    return finish("whole-paper", wholeContext, "", {
      // Page citations are validated against pageCount, not this map.
      chunkWhitelist: new Map(),
      pageCount: totalPages || pages.length,
      stats: {
        totalPages,
        totalChunks: chunks.length,
        selectedChunks: chunks.length,
        supplementChunks: 0,
      },
    });
  }

  // --- Chunk-rag mode: stable core + per-question supplement ---
  const scored = scoreChunks(
    chunks,
    question,
    input.chunkEmbeddings,
    input.questionEmbedding,
  );
  const byId = new Map(chunks.map((c) => [c.id, c]));

  const previous = input.previousCore;
  const reusable =
    previous !== undefined &&
    history.length > 0 &&
    previous.coreMax === plan.coreMax &&
    previous.chunkIds.every((id) => byId.has(id));

  let coreChunks: Chunk[];
  if (reusable) {
    coreChunks = previous!.chunkIds.map((id) => byId.get(id)!);
  } else {
    coreChunks = selectChunks(
      scored,
      plan.coreMax,
      getTopKCapForBudget(plan.coreMax),
    );
  }
  // A truncated fallback chunk keeps its ID, so IDs alone identify the core.
  const core: CoreSelection = {
    chunkIds: coreChunks.map((c) => c.id),
    coreMax: plan.coreMax,
  };
  const coreIds = new Set(core.chunkIds);

  // Supplement: the sections most relevant to *this* question that the core
  // lacks. Only sections with some relevance qualify — structural position
  // alone (being the abstract) is the core's job, not the supplement's.
  const supplementCandidates = scored
    .filter((c) => !coreIds.has(c.id) && c.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, MAX_SUPPLEMENT_CHUNKS);
  const supplementChunks =
    plan.supplementMax > 0
      ? selectChunks(
          supplementCandidates.map((c) => ({ ...c, score: c.relevance })),
          plan.supplementMax,
          MAX_SUPPLEMENT_CHUNKS,
          false,
        )
      : [];

  const chunkWhitelist = new Map<string, ChunkMeta>();
  const coreText = renderChunks(coreChunks, chunkWhitelist);
  const supplementText = renderChunks(supplementChunks, chunkWhitelist);

  return finish("chunk-rag", coreText, supplementText, {
    chunkWhitelist,
    core,
    stats: {
      totalPages,
      totalChunks: chunks.length,
      selectedChunks: coreChunks.length + supplementChunks.length,
      supplementChunks: supplementChunks.length,
    },
  });
}

/**
 * Builds the full RAG context for a user question about a Zotero item.
 *
 * Does the Zotero-dependent work — extraction, chunking, embeddings — and
 * hands the result to {@link assembleContext}.
 *
 * @param item - The Zotero item being discussed (must have a PDF attachment).
 * @param question - The user's current question.
 * @param conversationHistory - Previous messages (excluding system + current question).
 * @param plan - Allowances for this provider/model, from `getPromptPlan()` in
 *   `modules/llm/client.ts`.
 * @returns Pipeline result with messages, chunk whitelist, and stats.
 */
export async function buildRAGContext(
  item: Zotero.Item,
  question: string,
  conversationHistory: LLMMessage[],
  plan: PromptPlan,
): Promise<PipelineResult> {
  // --- Step 1-2: Extract + Chunk (with cache) ---
  let cached = itemCache.get(item.id);
  if (!cached) {
    const extraction = await extractPDF(item);
    if (!extraction || extraction.pages.length === 0) {
      // No PDF content — return empty context.
      const historyMax =
        plan.promptCapacity -
        messageTokens({ content: getSystemPrompt("chunk-rag") }) -
        messageTokens({ content: question });
      const kept = fitHistory(conversationHistory, historyMax);
      const messages = buildMessages("", question, kept);
      return {
        messages,
        chunkWhitelist: new Map(),
        mode: "chunk-rag",
        stats: {
          totalPages: 0,
          totalChunks: 0,
          selectedChunks: 0,
          contextTokens: 0,
          supplementChunks: 0,
          historyDropped: conversationHistory.length - kept.length,
          promptTokens: promptTokens(messages),
        },
      };
    }

    const chunks = chunkPages(extraction.pages, extraction.attachmentKey);
    cached = {
      chunks,
      attachmentKey: extraction.attachmentKey,
      totalPages: extraction.totalPages,
      pages: extraction.pages,
    };
    itemCache.set(item.id, cached);
  }

  const { chunks, totalPages, pages } = cached;

  // --- Step 3: Embeddings, only when the document will not be sent whole ---
  let chunkEmbeddings: Map<string, number[]> | undefined;
  let questionEmbedding: number[] | undefined;

  const sentWhole =
    estimateTokens(buildWholePaperContext(pages)) <= plan.wholePaperMax;

  if (!sentWhole && isModelReady()) {
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

  // --- Step 4: Assemble ---
  const result = assembleContext({
    pages,
    chunks,
    totalPages,
    question,
    history: conversationHistory,
    plan,
    previousCore: coreCache.get(item.id),
    chunkEmbeddings,
    questionEmbedding,
  });

  if (result.core) {
    coreCache.set(item.id, result.core);
  } else {
    coreCache.delete(item.id);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Chunk scoring
// ---------------------------------------------------------------------------

interface ScoredChunk extends Chunk {
  /** Overall rank: structural priority blended with relevance. */
  score: number;
  /**
   * How well the chunk matches the question, with no structural or position
   * boost. Zero means nothing links it to the question.
   */
  relevance: number;
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
    let relevance = 0;
    for (const word of questionWords) {
      if (lower.includes(word)) relevance += 10;
    }
    keywordScore += relevance;

    // D4 blend: use normalized scale when semantic mode is active.
    let finalScore: number;
    if (semanticModeActive) {
      const normKeyword = Math.min(1, keywordScore / MAX_PIPELINE_KEYWORD_SCORE);
      const chunkVec = chunkEmbeddings!.get(chunk.id);
      const rawSimilarity = chunkVec
        ? cosineSimilarity(questionEmbedding!, chunkVec)
        : 0;
      const normSemantic = Math.max(0, rawSimilarity);
      relevance += normSemantic * BLEND_SCALE;
      finalScore =
        (KEYWORD_WEIGHT * normKeyword + SEMANTIC_WEIGHT * normSemantic) *
        BLEND_SCALE;
    } else {
      finalScore = keywordScore;
    }

    return { ...chunk, score: finalScore, relevance };
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
 * @param maxChunks - Optional maximum chunk count (dynamic topK from
 *   getTopKCapForBudget()).
 * @param forceOne - When nothing fits, include the top chunk truncated to the
 *   budget. Right for the core (some context beats none); wrong for the
 *   supplement, which is optional.
 */
function selectChunks(
  scored: Array<Chunk & { score: number }>,
  maxTokens: number,
  maxChunks?: number,
  forceOne: boolean = true,
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
  if (forceOne && selected.length === 0 && candidates.length > 0) {
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
