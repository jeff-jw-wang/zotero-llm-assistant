/**
 * IndexedDB storage layer for the Zotero LLM Assistant.
 *
 * Provides persistent storage for:
 * - Conversation history (keyed by Zotero item ID)
 * - Per-item privacy flags
 * - Embedding vector cache (Phase D)
 *
 * Why IndexedDB and not better-sqlite3:
 *   Zotero plugins run in a Mozilla/XULRunner extension runtime, not Node.js.
 *   Native Node modules like better-sqlite3 cannot load. IndexedDB is browser-native
 *   and available in the extension context. See docs/STORAGE.md for details.
 *
 * Fallback (if spike S2 fails):
 *   If IndexedDB is not shared across main window + reader panel contexts,
 *   migrate to Zotero.DB.queryAsync() for conversations and privacy flags.
 *
 * Schema versioning:
 *   Uses IndexedDB's built-in onupgradeneeded for migrations.
 *   Current version: 2
 *
 *   v1 → v2 migration:
 *     - Drops the old "embeddings" store (keyed by itemId, never populated)
 *     - Creates "chunk_embeddings" store (keyed by chunkId, indexed on itemId)
 *       for per-chunk and per-item-metadata embedding vectors.
 *
 * @module modules/storage/db
 */

const DB_NAME = "zotero-llm-assistant";
const DB_VERSION = 2;

/** Object store names. */
const STORES = {
  CONVERSATIONS: "conversations",
  PRIVACY: "privacy",
  /** @deprecated Dropped in v2. Kept for migration reference only. */
  EMBEDDINGS_V1: "embeddings",
  CHUNK_EMBEDDINGS: "chunk_embeddings",
} as const;

/** A single message in a conversation turn. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** ISO timestamp of when this message was created. */
  timestamp: string;
  /** Source chunks referenced in this message (assistant only). */
  sourceChunks?: SourceChunkRef[];
}

/** Reference to a source chunk used in an assistant response. */
export interface SourceChunkRef {
  chunkId: string;
  pageStart: number;
  pageEnd: number;
  /** Short text excerpt for display. */
  excerpt: string;
}

/** A full conversation record, keyed by Zotero item ID. */
export interface ConversationRecord {
  /** Zotero item ID (integer). */
  itemId: number;
  /** All messages in this conversation (chronological order). */
  messages: ChatMessage[];
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** Per-item privacy flag record. */
export interface PrivacyRecord {
  /** Zotero item ID. */
  itemId: number;
  /** If true, this item's content must not be sent to cloud LLM providers. */
  isPrivate: boolean;
}

/**
 * A single chunk embedding record.
 *
 * For reader RAG chunks, `chunkId` is the chunker-assigned ID (e.g. "42-p3-n0").
 * For library metadata embeddings, `chunkId` is `"meta:" + item.key` (synthetic).
 */
export interface ChunkEmbeddingRecord {
  /** Primary key — chunk ID from chunker or synthetic `"meta:" + key`. */
  chunkId: string;
  /** Parent Zotero item ID, used for bulk invalidation by item. */
  itemId: number;
  /** Float array (~384 dims for all-MiniLM-L6-v2). */
  vector: number[];
  /** ISO timestamp of when this embedding was computed. */
  updatedAt: string;
}

/** Summary of a conversation for the history browser. */
export interface ConversationSummary {
  itemId: number;
  messageCount: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Database initialization
// ---------------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

/** Timeout (ms) for opening the IndexedDB database. Prevents indefinite hangs
 *  if the runtime doesn't support IndexedDB or the open request never settles. */
const DB_OPEN_TIMEOUT_MS = 5_000;

/**
 * Opens (or creates) the IndexedDB database. Returns a cached promise so
 * the DB is opened only once per session.
 *
 * Safety: includes a 5-second timeout and checks for `indexedDB` availability
 * to avoid hanging in contexts where IndexedDB is not supported (e.g. some
 * XUL panel environments in Zotero).
 */
export function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    // Check IndexedDB availability before attempting to open.
    let idb: IDBFactory | undefined;
    try {
      idb = (globalThis as any).indexedDB;
    } catch {
      // globalThis.indexedDB access itself threw — not available.
    }
    if (!idb) {
      dbPromise = null;
      reject(new Error("IndexedDB is not available in this context."));
      return;
    }

    // Guard against the open request never settling.
    const timeout = setTimeout(() => {
      dbPromise = null;
      reject(new Error("IndexedDB open timed out after 5 seconds."));
    }, DB_OPEN_TIMEOUT_MS);

    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DB_NAME, DB_VERSION);
    } catch (err: any) {
      clearTimeout(timeout);
      dbPromise = null;
      reject(new Error(`IndexedDB open failed: ${err?.message ?? err}`));
      return;
    }

    request.onupgradeneeded = (event: Event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;

      // --- Stores created in v1 (and still needed in v2) ---

      // Conversations store: keyed by itemId.
      if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
        db.createObjectStore(STORES.CONVERSATIONS, { keyPath: "itemId" });
      }

      // Privacy store: keyed by itemId.
      if (!db.objectStoreNames.contains(STORES.PRIVACY)) {
        db.createObjectStore(STORES.PRIVACY, { keyPath: "itemId" });
      }

      // --- v1 → v2 migration ---
      if (oldVersion < 2) {
        // Drop the old per-item embeddings store (never populated in v1).
        if (db.objectStoreNames.contains(STORES.EMBEDDINGS_V1)) {
          db.deleteObjectStore(STORES.EMBEDDINGS_V1);
        }

        // Create chunk_embeddings store: per-chunk vectors with itemId index.
        if (!db.objectStoreNames.contains(STORES.CHUNK_EMBEDDINGS)) {
          const store = db.createObjectStore(STORES.CHUNK_EMBEDDINGS, {
            keyPath: "chunkId",
          });
          store.createIndex("itemId", "itemId", { unique: false });
        }
      }
    };

    request.onsuccess = () => {
      clearTimeout(timeout);
      resolve(request.result);
    };
    request.onerror = () => {
      clearTimeout(timeout);
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      clearTimeout(timeout);
      dbPromise = null;
      reject(
        new Error(
          "IndexedDB open blocked — another connection may be holding a version lock.",
        ),
      );
    };
  });

  return dbPromise;
}

// ---------------------------------------------------------------------------
// Conversation CRUD
// ---------------------------------------------------------------------------

/**
 * Loads the conversation history for a given Zotero item.
 * Returns null if no conversation exists yet.
 */
export async function getConversation(
  itemId: number,
): Promise<ConversationRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CONVERSATIONS, "readonly");
    const store = tx.objectStore(STORES.CONVERSATIONS);
    const req = store.get(itemId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Saves (upserts) a conversation record.
 */
export async function saveConversation(
  record: ConversationRecord,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CONVERSATIONS, "readwrite");
    const store = tx.objectStore(STORES.CONVERSATIONS);
    const req = store.put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Appends a message to an existing conversation, or creates a new one.
 * Returns the updated record.
 */
export async function appendMessage(
  itemId: number,
  message: ChatMessage,
): Promise<ConversationRecord> {
  const existing = await getConversation(itemId);
  const record: ConversationRecord = existing ?? {
    itemId,
    messages: [],
    updatedAt: new Date().toISOString(),
  };
  record.messages.push(message);
  record.updatedAt = new Date().toISOString();
  await saveConversation(record);
  return record;
}

/**
 * Deletes the conversation for a given item.
 */
export async function deleteConversation(itemId: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CONVERSATIONS, "readwrite");
    const store = tx.objectStore(STORES.CONVERSATIONS);
    const req = store.delete(itemId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Privacy flags
// ---------------------------------------------------------------------------

/**
 * Returns whether an item is marked as private (no cloud sharing).
 * Items without a record default to NOT private (global toggle controls behavior).
 */
export async function isItemPrivate(itemId: number): Promise<boolean> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRIVACY, "readonly");
    const store = tx.objectStore(STORES.PRIVACY);
    const req = store.get(itemId);
    req.onsuccess = () => resolve(req.result?.isPrivate ?? false);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Sets the privacy flag for an item.
 */
export async function setItemPrivacy(
  itemId: number,
  isPrivate: boolean,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRIVACY, "readwrite");
    const store = tx.objectStore(STORES.PRIVACY);
    const req = store.put({ itemId, isPrivate } satisfies PrivacyRecord);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Returns all item IDs that are marked as private.
 * Used by the library searcher to exclude private items from cloud-bound context.
 */
export async function getAllPrivateItemIds(): Promise<Set<number>> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.PRIVACY, "readonly");
    const store = tx.objectStore(STORES.PRIVACY);
    const req = store.getAll();
    req.onsuccess = () => {
      const ids = new Set<number>();
      for (const record of req.result as PrivacyRecord[]) {
        if (record.isPrivate) ids.add(record.itemId);
      }
      resolve(ids);
    };
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Chunk embeddings (Phase D)
// ---------------------------------------------------------------------------

/**
 * Retrieves a single chunk embedding by its chunkId.
 * Returns null if not cached.
 */
export async function getChunkEmbedding(
  chunkId: string,
): Promise<ChunkEmbeddingRecord | null> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CHUNK_EMBEDDINGS, "readonly");
    const store = tx.objectStore(STORES.CHUNK_EMBEDDINGS);
    const req = store.get(chunkId);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Retrieves all chunk embeddings for a given Zotero item ID.
 * Uses the `itemId` index for efficient lookup.
 */
export async function getChunkEmbeddingsByItemId(
  itemId: number,
): Promise<ChunkEmbeddingRecord[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CHUNK_EMBEDDINGS, "readonly");
    const store = tx.objectStore(STORES.CHUNK_EMBEDDINGS);
    const index = store.index("itemId");
    const req = index.getAll(itemId);
    req.onsuccess = () => resolve(req.result as ChunkEmbeddingRecord[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Saves (upserts) chunk embeddings in bulk.
 * Uses a single readwrite transaction for efficiency.
 */
export async function saveChunkEmbeddings(
  records: ChunkEmbeddingRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CHUNK_EMBEDDINGS, "readwrite");
    const store = tx.objectStore(STORES.CHUNK_EMBEDDINGS);
    for (const record of records) {
      store.put(record);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Deletes a single chunk embedding by chunkId.
 * Used for metadata embedding invalidation when a regular item is modified.
 */
export async function deleteChunkEmbedding(
  chunkId: string,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CHUNK_EMBEDDINGS, "readwrite");
    const store = tx.objectStore(STORES.CHUNK_EMBEDDINGS);
    const req = store.delete(chunkId);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Deletes all chunk embeddings for a given Zotero item ID.
 * Used when a PDF attachment is modified (re-extraction invalidates chunks).
 */
export async function deleteChunkEmbeddingsByItemId(
  itemId: number,
): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CHUNK_EMBEDDINGS, "readwrite");
    const store = tx.objectStore(STORES.CHUNK_EMBEDDINGS);
    const index = store.index("itemId");
    const req = index.openCursor(itemId);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
      // Cursor exhausted — transaction will auto-complete.
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Conversation summaries (for history browser)
// ---------------------------------------------------------------------------

/**
 * Returns summaries of all conversations, sorted by `updatedAt` descending.
 * Used by the library panel's history tab.
 */
export async function getAllConversationSummaries(): Promise<ConversationSummary[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.CONVERSATIONS, "readonly");
    const store = tx.objectStore(STORES.CONVERSATIONS);
    const req = store.getAll();
    req.onsuccess = () => {
      const records = req.result as ConversationRecord[];
      const summaries: ConversationSummary[] = records.map((r) => ({
        itemId: r.itemId,
        messageCount: r.messages.length,
        updatedAt: r.updatedAt,
      }));
      // Sort by updatedAt descending (most recent first).
      summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      resolve(summaries);
    };
    req.onerror = () => reject(req.error);
  });
}
