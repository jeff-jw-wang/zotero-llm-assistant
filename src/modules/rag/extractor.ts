/**
 * PDF text extractor — reads a Zotero item's attached PDF and returns
 * structured text chunks with page numbers.
 *
 * SPIKE S1 outcome determines the extraction path used:
 *
 *   Path A (preferred): pdfjs-dist npm package
 *     - Pure JavaScript, no native bindings, works in browser/extension contexts.
 *     - Bundled by esbuild along with the rest of the plugin.
 *     - NOTE: pdfjs-dist v4 uses ESM. If esbuild cannot bundle it correctly in
 *       the Zotero extension context, fall back to Path B.
 *
 *   Path B (fallback): Zotero's internal PDF.js
 *     - Zotero 6+ ships pdf.js internally as Zotero.PDFWorker.
 *     - API is undocumented and may change across Zotero versions.
 *     - Access pattern: Zotero.Attachments.getFilePathAsync(item) + internal APIs.
 *
 * Current implementation uses Path B (Zotero.PDFWorker / Zotero.FullText.getContent)
 * because it avoids bundling a large external dependency and is known to work in the
 * extension context. Update this module if Spike S1 confirms pdfjs-dist is compatible.
 *
 * Page markers:
 *   Each page's text is wrapped with [p.N] ... [/p.N] markers so the LLM
 *   can cite pages by number. The pageWhitelist is the set of page numbers
 *   actually included in the payload sent to the LLM.
 *
 * @module modules/rag/extractor
 * @see docs/ZOTERO_API.md for Spike S1 outcomes
 */

/** A single extracted page. */
export interface ExtractedPage {
  /** 1-based page number. */
  page: number;
  /** Raw text content of the page. */
  text: string;
}

/** Full extraction result for an item. */
export interface ExtractionResult {
  /** All pages extracted from the PDF. */
  pages: ExtractedPage[];
  /** Total page count of the document. */
  totalPages: number;
  /** Zotero attachment key of the PDF (stable across sync, used for chunk IDs). */
  attachmentKey: string;
  /** Title from PDF metadata, if available. */
  title?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extracts text from the PDF attachment of a Zotero item.
 *
 * Returns null if the item has no PDF attachment or extraction fails.
 *
 * @param item - A Zotero item (must have a PDF child attachment).
 */
export async function extractPDF(
  item: Zotero.Item,
): Promise<ExtractionResult | null> {
  const pdfItem = await getPDFAttachment(item);
  if (!pdfItem) {
    ztoolkit.log(`No PDF attachment found for item ${item.id}`);
    return null;
  }

  try {
    return await extractViaNativeAPI(pdfItem);
  } catch (err) {
    ztoolkit.log(`PDF extraction failed for item ${item.id}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extraction path: Zotero's native full-text content API (Path B)
// ---------------------------------------------------------------------------

/**
 * Uses Zotero's built-in full-text content system to get page text.
 *
 * Zotero indexes PDF full text for searching. We read from that index,
 * which gives us text with page numbers already split.
 *
 * Limitation: The index may not have been built yet for newly added PDFs.
 * In that case we trigger indexing and wait.
 */
async function extractViaNativeAPI(
  pdfItem: Zotero.Item,
): Promise<ExtractionResult> {
  // Try to index if possible. If indexing is unavailable in this context, we'll
  // still attempt to read existing cache text below.
  try {
    if (Zotero.FullText.canIndex(pdfItem)) {
      const indexState = await Zotero.FullText.getIndexedState(pdfItem);
      if (indexState !== Zotero.FullText.INDEX_STATE_INDEXED) {
        ztoolkit.log("Triggering PDF indexing for item:", pdfItem.id);
        await Zotero.FullText.indexItems([pdfItem.id], {
          complete: true,
          ignoreErrors: true,
        });
      }
    } else {
      ztoolkit.log("PDF not indexable in current context; trying cache fallback.");
    }
  } catch (err: any) {
    ztoolkit.log(`FullText indexing step failed: ${err?.message ?? err}`);
  }

  // Primary path (undocumented API): attempt when available.
  const fullTextAny = Zotero.FullText as any;
  let rawText = "";
  let totalPages = 0;
  try {
    if (typeof fullTextAny.getItemContent === "function") {
      const content = await fullTextAny.getItemContent(pdfItem.id);
      if (typeof content === "string") {
        rawText = content;
      } else if (content) {
        rawText = String(
          content.content ?? content.text ?? content.body ?? "",
        );
        totalPages = Number(content.pages ?? content.totalPages ?? 0) || 0;
      }
    }
  } catch (err: any) {
    ztoolkit.log(`FullText.getItemContent failed: ${err?.message ?? err}`);
  }

  // Fallback path: read indexed cache file directly.
  if (!rawText) {
    rawText = await readIndexedCacheText(pdfItem);
  }

  if (!rawText) {
    return { pages: [], totalPages: 0, attachmentKey: pdfItem.key };
  }

  // If getItemContent() didn't return a page count, query the DB directly.
  // This covers the case where getItemContent() returned a plain string or
  // was skipped entirely (cache-file fallback path).
  if (totalPages === 0) {
    totalPages = await queryTotalPages(pdfItem.id);
  }

  // Split into pages using form-feed when present.
  const pages = splitIntoPages(rawText, totalPages);

  // Use the metadata page count when available. Form-feed splitting may
  // produce more segments than physical pages (e.g. double form-feeds, or
  // extra separators in supplementary material).
  const reportedPages = totalPages > 0 ? totalPages : pages.length;

  return {
    pages,
    totalPages: reportedPages,
    attachmentKey: pdfItem.key,
    title: pdfItem.getField("title") || undefined,
  };
}

// ---------------------------------------------------------------------------
// Page splitting heuristic
// ---------------------------------------------------------------------------

/**
 * Splits a flat text string into pages using form-feed characters (\f)
 * or, if absent, by approximate character count.
 *
 * PDF text extracted by Zotero uses \f (form-feed, ASCII 12) as page separators.
 */
function splitIntoPages(text: string, expectedPages: number): ExtractedPage[] {
  // Try form-feed split first (most reliable).
  if (text.includes("\f")) {
    return text
      .split("\f")
      .map((pageText, idx) => ({ page: idx + 1, text: pageText.trim() }))
      .filter((p) => p.text.length > 0);
  }

  // No form-feed: split by approximate page size.
  if (expectedPages <= 1 || expectedPages === 0) {
    return [{ page: 1, text: text.trim() }];
  }

  const charsPerPage = Math.ceil(text.length / expectedPages);
  const pages: ExtractedPage[] = [];

  for (let i = 0; i < expectedPages; i++) {
    const start = i * charsPerPage;
    const end = Math.min((i + 1) * charsPerPage, text.length);
    const pageText = text.slice(start, end).trim();
    if (pageText) {
      pages.push({ page: i + 1, text: pageText });
    }
  }

  return pages;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Finds the first PDF attachment child of a Zotero item.
 * Returns null if none found.
 */
async function getPDFAttachment(
  item: Zotero.Item,
): Promise<Zotero.Item | null> {
  // If the item itself is an attachment, use it directly.
  if (item.isAttachment()) {
    if (item.attachmentContentType === "application/pdf") return item;
    return null;
  }

  // Otherwise look for PDF children.
  const attachmentIDs = item.getAttachments();
  for (const id of attachmentIDs) {
    const att = await Zotero.Items.getAsync(id);
    if (att && att.attachmentContentType === "application/pdf") {
      return att;
    }
  }
  return null;
}

/**
 * Queries the fulltextContent DB table for the totalPages value.
 * Returns 0 if the query fails or no record exists.
 */
async function queryTotalPages(itemId: number): Promise<number> {
  try {
    const rows = await (Zotero.DB as any).queryAsync(
      "SELECT totalPages FROM fulltextContent WHERE itemID=?",
      [itemId],
    );
    if (rows?.length > 0 && rows[0].totalPages > 0) {
      return Number(rows[0].totalPages);
    }
  } catch {
    // DB query failed — fall back to form-feed count.
  }
  return 0;
}

/**
 * Reads Zotero's full-text cache file for an indexed attachment.
 * This is a stable fallback when undocumented FullText methods vary by version.
 */
async function readIndexedCacheText(pdfItem: Zotero.Item): Promise<string> {
  try {
    const cacheFile = Zotero.FullText.getItemCacheFile(pdfItem);
    if (!cacheFile || !cacheFile.exists()) {
      return "";
    }
    const data = await Zotero.File.getContentsAsync(cacheFile, "utf-8");
    return typeof data === "string" ? data : String(data ?? "");
  } catch (err: any) {
    ztoolkit.log(`Failed reading FullText cache file: ${err?.message ?? err}`);
    return "";
  }
}
