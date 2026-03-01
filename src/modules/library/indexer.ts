/**
 * In-memory library metadata index for keyword-based library search.
 *
 * Builds a `Map<number, ItemMetadata>` from all regular Zotero items in the
 * **user library only** (skipping attachments, notes, and group library items).
 * The index is built **lazily** on first use — not at startup — to avoid
 * blocking large libraries during Zotero launch (D3). The notifier also
 * enforces the user-library-only policy on incremental updates.
 *
 * `startLibraryIndexer()` registers a Zotero notifier for incremental updates.
 * `ensureIndex()` triggers the initial build on demand. `stopLibraryIndexer()`
 * tears down the notifier on shutdown.
 *
 * Phase D: The notifier also handles embedding cache invalidation (D8):
 * - PDF attachment modified → delete chunk embeddings by parent item ID
 * - Regular item modified → delete metadata embedding ("meta:" + key)
 * - Regular item deleted → delete both chunk and metadata embeddings
 *
 * Memory estimate: ~10K items × ~500 bytes ≈ 5MB.
 *
 * @module modules/library/indexer
 */
import {
  deleteChunkEmbedding,
  deleteChunkEmbeddingsByItemId,
} from "../storage/db";
import { clearItemCache } from "../rag/pipeline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata extracted from a single Zotero regular item.
 * All fields are plain strings/arrays — no Zotero runtime objects retained.
 */
export interface ItemMetadata {
  itemId: number;
  key: string;
  title: string;
  authors: string;
  year: string;
  abstract: string;
  tags: string[];
  doi: string;
  itemType: string;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The in-memory index, keyed by Zotero item ID. */
const index = new Map<number, ItemMetadata>();

/** Whether the full index has been built at least once. */
let indexReady = false;

/** Promise for the in-progress build, if any (prevents concurrent builds). */
let buildPromise: Promise<void> | null = null;

/** Zotero notifier ID (for cleanup on shutdown). */
let notifierId: string | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current index (read-only view).
 * May be empty if `ensureIndex()` has not been called yet.
 */
export function getIndex(): ReadonlyMap<number, ItemMetadata> {
  return index;
}

/**
 * Ensures the index has been built. If already built, returns immediately.
 * If a build is in progress, awaits it. Otherwise starts a new build.
 *
 * Called internally by `searchLibrary()` — callers don't need to manage this.
 */
export async function ensureIndex(): Promise<void> {
  if (indexReady) return;
  if (buildPromise) {
    await buildPromise;
    return;
  }
  buildPromise = buildLibraryIndex();
  try {
    await buildPromise;
    indexReady = true;
  } finally {
    buildPromise = null;
  }
}

/**
 * Builds the full library index from scratch.
 *
 * Iterates all regular items in the Zotero library, extracts metadata,
 * and stores it in the module-level `index` map.
 *
 * Yields to the event loop every 100 items to keep the UI responsive.
 */
export async function buildLibraryIndex(): Promise<void> {
  index.clear();

  const libraryID = Zotero.Libraries.userLibraryID;
  const allItems: Zotero.Item[] = await (Zotero.Items as any).getAll(libraryID);

  let count = 0;
  for (const item of allItems) {
    if (!item.isRegularItem()) continue;

    index.set(item.id, extractMetadata(item));

    count++;
    if (count % 100 === 0) {
      // Yield to event loop to keep UI responsive during large libraries.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }

  ztoolkit.log(`Library index built: ${index.size} items`);
}

/**
 * Registers the Zotero notifier for incremental index updates.
 * Does NOT build the index — that happens lazily via `ensureIndex()`.
 *
 * Call this in `onStartup()`.
 */
export function startLibraryIndexer(): void {
  if (notifierId) return; // Already registered.

  notifierId = Zotero.Notifier.registerObserver(
    {
      notify(
        event: string,
        _type: string,
        ids: Array<string | number>,
      ) {
        // Only process incremental updates if the index has been built.
        if (!indexReady) return;

        const numericIds = ids.map(Number).filter((n) => !isNaN(n));

        if (event === "delete") {
          for (const id of numericIds) {
            // Read key from in-memory index BEFORE removing (item may not be
            // retrievable from Zotero during delete callbacks).
            const meta = index.get(id);
            index.delete(id);

            // D8: Invalidate both chunk embeddings (by itemId) and metadata
            // embedding (by "meta:" + key). void + .catch() because the
            // notifier callback is synchronous.
            void deleteChunkEmbeddingsByItemId(id).catch((e: any) =>
              ztoolkit.log("Embedding invalidation failed (chunks): " + e?.message),
            );
            if (meta) {
              void deleteChunkEmbedding("meta:" + meta.key).catch((e: any) =>
                ztoolkit.log("Embedding invalidation failed (meta): " + e?.message),
              );
            }
          }
          return;
        }

        if (event === "add" || event === "modify") {
          const userLibID = Zotero.Libraries.userLibraryID;
          for (const id of numericIds) {
            try {
              const item = Zotero.Items.get(id);

              // D8 Path A: PDF attachment modified → invalidate chunk embeddings.
              if (
                item &&
                item.isAttachment() &&
                (item as any).attachmentContentType === "application/pdf"
              ) {
                const parentId = (item as any).parentItemID;
                if (parentId) {
                  void deleteChunkEmbeddingsByItemId(parentId).catch((e: any) =>
                    ztoolkit.log("Chunk embedding invalidation failed: " + e?.message),
                  );
                  clearItemCache(parentId);
                }
                continue;
              }

              // Regular item handling.
              if (item && item.isRegularItem() && item.libraryID === userLibID) {
                index.set(id, extractMetadata(item));

                // D8 Path B: Regular item modified → invalidate metadata embedding.
                if (event === "modify") {
                  void deleteChunkEmbedding("meta:" + item.key).catch((e: any) =>
                    ztoolkit.log("Meta embedding invalidation failed: " + e?.message),
                  );
                }
              } else {
                // Item is non-regular or from a group library — remove if present.
                index.delete(id);
              }
            } catch {
              // Item may have been deleted between event and processing.
            }
          }
        }
      },
    },
    ["item"],
    "llm-assistant-library-indexer",
  );

  ztoolkit.log("Library indexer notifier registered");
}

/**
 * Unregisters the Zotero notifier. Call this in `onShutdown()`.
 */
export function stopLibraryIndexer(): void {
  if (notifierId) {
    Zotero.Notifier.unregisterObserver(notifierId);
    notifierId = null;
  }
  index.clear();
  indexReady = false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts metadata from a Zotero.Item into a plain object.
 */
function extractMetadata(item: Zotero.Item): ItemMetadata {
  // Authors: filter to "author" creator type only, then cap at 3 names.
  const creators = item.getCreators();
  const authorTypeID = Zotero.CreatorTypes.getID("author");
  const authorNames = creators
    .filter((c: any) => c.creatorTypeID === authorTypeID)
    .map((c: any) => c.lastName || c.name || "")
    .filter(Boolean);
  const authorStr =
    authorNames.length > 3
      ? `${authorNames.slice(0, 3).join(", ")} et al.`
      : authorNames.join(", ");

  // Year: extract 4-digit year from the date field.
  const dateStr = item.getField("date") as string;
  const yearMatch = dateStr?.match(/(\d{4})/);
  const year = yearMatch ? yearMatch[1]! : "";

  // Tags: plain string array.
  const tags = item.getTags().map((t: any) => t.tag as string);

  return {
    itemId: item.id,
    key: item.key,
    title: (item.getField("title") as string) || "",
    authors: authorStr,
    year,
    abstract: (item.getField("abstractNote") as string) || "",
    tags,
    doi: (item.getField("DOI") as string) || "",
    itemType: item.itemType,
  };
}
