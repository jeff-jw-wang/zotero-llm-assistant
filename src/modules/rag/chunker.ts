/**
 * Text chunker — splits extracted PDF pages into smaller, semantically
 * meaningful chunks for LLM context retrieval.
 *
 * Chunking strategy (paragraph/window, Phase B baseline):
 *   1. Concatenate all page texts with \f page-break markers preserved
 *   2. Split at paragraph breaks (\n\n)
 *   3. Greedily merge consecutive paragraphs up to TARGET_CHUNK_CHARS
 *   4. Split oversized paragraphs at sentence boundaries
 *   5. Last resort: word-boundary split
 *
 * Each chunk carries:
 *   - A content-hashed ID (FNV-1a of attachmentKey + page range + full text)
 *   - The 1-based page range it spans (derived from \f positions)
 *
 * Chunk IDs are deterministic for the same content but resilient to chunker
 * algorithm changes — old IDs stored in conversation records carry their own
 * page metadata and never need re-resolution.
 *
 * Heading-aware splitting (detecting numbered sections, all-caps headings) is
 * intentionally deferred to a follow-up iteration. The chunker is a pure
 * function so the strategy can be swapped without breaking callers.
 *
 * @module modules/rag/chunker
 * @see PLAN_PHASE_B.md — Design decisions D1, D3, D6
 */

import type { ExtractedPage } from "./extractor";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single text chunk with page-range metadata. */
export interface Chunk {
  /** Content-hash ID (8-char hex, with optional -N collision suffix). */
  id: string;
  /** Chunk body text. */
  text: string;
  /** First page this chunk appears on (1-based). */
  pageStart: number;
  /** Last page this chunk appears on (1-based). */
  pageEnd: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target chunk size in characters (~512 tokens at 4 chars/token). */
export const TARGET_CHUNK_CHARS = 2048;

/** Regex pattern string for chunk IDs: 8 hex chars + optional collision suffix.
 *  Case-insensitive — the model may emit uppercase hex. Normalize to lowercase
 *  before whitelist lookup. */
export const CHUNK_ID_PATTERN = "[0-9a-fA-F]{8}(?:-\\d+)?";

/**
 * Creates a fresh RegExp for matching [c.ID] citations in LLM output.
 * Returns a new instance every call to avoid global-regex lastIndex bugs.
 * Case-insensitive: captured IDs should be lowercased before whitelist lookup.
 */
export function makeChunkCiteRegex(): RegExp {
  return new RegExp(`\\[c\\.(${CHUNK_ID_PATTERN})\\]`, "gi");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Splits extracted pages into chunks.
 *
 * @param pages - Extracted pages from the PDF (from extractor.ts).
 * @param attachmentKey - Zotero attachment key (stable across sync).
 * @returns Array of chunks with content-hashed IDs and page ranges.
 */
export function chunkPages(
  pages: ExtractedPage[],
  attachmentKey: string,
): Chunk[] {
  if (pages.length === 0) return [];

  // Step 1: Concatenate all pages with \f markers; build page-position map.
  const { fullText, pageBreaks } = buildPageMap(pages);

  // Step 2: Split into raw segments at paragraph boundaries.
  const segments = splitIntoParagraphs(fullText);

  // Step 3: Merge small segments up to TARGET_CHUNK_CHARS.
  const merged = mergeSegments(segments);

  // Step 4: Split oversized segments.
  const finalSegments = splitOversized(merged);

  // Step 5: Assign page ranges and IDs.
  const usedIds = new Set<string>();
  const chunks: Chunk[] = [];
  let offset = 0;

  for (const seg of finalSegments) {
    const trimmed = seg.trim();
    if (!trimmed) {
      offset += seg.length;
      continue;
    }

    const startOffset = fullText.indexOf(trimmed, offset);
    const endOffset = startOffset + trimmed.length;

    const pageStart = getPageAtOffset(pageBreaks, startOffset, pages);
    const pageEnd = getPageAtOffset(pageBreaks, endOffset - 1, pages);

    const id = generateChunkId(attachmentKey, pageStart, pageEnd, trimmed, usedIds);

    chunks.push({ id, text: trimmed, pageStart, pageEnd });
    offset = endOffset;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Page-position map
// ---------------------------------------------------------------------------

interface PageMap {
  /** Full concatenated text with \f separators. */
  fullText: string;
  /** Character offsets where each page starts (0-indexed into fullText). */
  pageBreaks: number[];
}

/**
 * Concatenates all page texts with \f separators and records the character
 * offset where each page begins.
 */
function buildPageMap(pages: ExtractedPage[]): PageMap {
  const parts: string[] = [];
  const pageBreaks: number[] = [];
  let offset = 0;

  for (let i = 0; i < pages.length; i++) {
    if (i > 0) {
      parts.push("\f");
      offset += 1;
    }
    pageBreaks.push(offset);
    parts.push(pages[i]!.text);
    offset += pages[i]!.text.length;
  }

  return { fullText: parts.join(""), pageBreaks };
}

/**
 * Returns the 1-based page number for a character offset in the concatenated text.
 */
function getPageAtOffset(
  pageBreaks: number[],
  offset: number,
  pages: ExtractedPage[],
): number {
  for (let i = pageBreaks.length - 1; i >= 0; i--) {
    if (offset >= pageBreaks[i]!) {
      return pages[i]!.page;
    }
  }
  return pages[0]?.page ?? 1;
}

// ---------------------------------------------------------------------------
// Paragraph splitting
// ---------------------------------------------------------------------------

/**
 * Splits text at paragraph breaks (\n\n), preserving the position of \f
 * page-break markers within segments.
 */
function splitIntoParagraphs(text: string): string[] {
  // Split on double newlines (paragraph boundaries).
  // Keep the delimiter pattern so we don't lose whitespace context.
  return text.split(/\n{2,}/).filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Segment merging
// ---------------------------------------------------------------------------

/**
 * Greedily merges consecutive segments up to TARGET_CHUNK_CHARS.
 * Short paragraphs that fit together become a single chunk.
 */
function mergeSegments(segments: string[]): string[] {
  const merged: string[] = [];
  let buffer = "";

  for (const seg of segments) {
    const candidate = buffer ? buffer + "\n\n" + seg : seg;

    if (candidate.length <= TARGET_CHUNK_CHARS) {
      buffer = candidate;
    } else {
      if (buffer) merged.push(buffer);
      buffer = seg;
    }
  }

  if (buffer) merged.push(buffer);
  return merged;
}

// ---------------------------------------------------------------------------
// Oversized segment splitting
// ---------------------------------------------------------------------------

/** Sentence boundary: period + space + uppercase letter. */
const SENTENCE_RE = /\.\s+(?=[A-Z])/;

/**
 * Splits segments that exceed TARGET_CHUNK_CHARS at sentence boundaries,
 * then at word boundaries as a last resort.
 */
function splitOversized(segments: string[]): string[] {
  const result: string[] = [];

  for (const seg of segments) {
    if (seg.length <= TARGET_CHUNK_CHARS) {
      result.push(seg);
      continue;
    }
    // Try sentence-level splitting.
    const sentences = splitAtSentences(seg);
    const remerged = mergeSegments(sentences);

    for (const chunk of remerged) {
      if (chunk.length <= TARGET_CHUNK_CHARS) {
        result.push(chunk);
      } else {
        // Last resort: word-boundary split.
        result.push(...splitAtWordBoundary(chunk));
      }
    }
  }

  return result;
}

/**
 * Splits text at sentence boundaries.
 */
function splitAtSentences(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const match = SENTENCE_RE.exec(remaining);
    if (!match) {
      parts.push(remaining);
      break;
    }
    // Include the period in the current sentence.
    const splitPoint = match.index + 1; // after the period
    parts.push(remaining.slice(0, splitPoint));
    remaining = remaining.slice(splitPoint).trimStart();
  }

  return parts.filter((s) => s.length > 0);
}

/**
 * Splits text at the nearest word boundary before TARGET_CHUNK_CHARS.
 */
function splitAtWordBoundary(text: string): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > TARGET_CHUNK_CHARS) {
    // Find the last space before the target.
    let splitAt = remaining.lastIndexOf(" ", TARGET_CHUNK_CHARS);
    if (splitAt <= 0) {
      // No space found; hard split.
      splitAt = TARGET_CHUNK_CHARS;
    }
    result.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) result.push(remaining);
  return result;
}

// ---------------------------------------------------------------------------
// Chunk ID generation (FNV-1a content hash)
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Computes FNV-1a 32-bit hash and returns an 8-character hex string.
 */
function fnv1aHex(str: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  // Convert to unsigned 32-bit, then to 8-char hex.
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Generates a content-hashed chunk ID with collision handling.
 *
 * @param attachmentKey - Zotero attachment key.
 * @param pageStart - First page of this chunk.
 * @param pageEnd - Last page of this chunk.
 * @param text - Full chunk text (hashed in entirety).
 * @param usedIds - Set of already-assigned IDs for collision detection.
 * @returns Unique ID string (8-char hex, or hex-N on collision).
 */
function generateChunkId(
  attachmentKey: string,
  pageStart: number,
  pageEnd: number,
  text: string,
  usedIds: Set<string>,
): string {
  const base = fnv1aHex(`${attachmentKey}:${pageStart}-${pageEnd}:${text}`);

  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  // Collision: append incrementing suffix.
  let suffix = 1;
  while (usedIds.has(`${base}-${suffix}`)) {
    suffix++;
  }
  const id = `${base}-${suffix}`;
  usedIds.add(id);
  return id;
}
