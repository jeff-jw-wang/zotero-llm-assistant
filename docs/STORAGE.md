# Storage Layer — IndexedDB Schema

The Zotero LLM Assistant uses **IndexedDB** for all persistent data. This
document describes the schema, migration strategy, and data lifecycle.

## Why IndexedDB?

Zotero plugins run in a Mozilla/XULRunner extension runtime, not Node.js.
Native Node modules like `better-sqlite3` cannot load. IndexedDB is
browser-native and available in the extension context. It is shared across
the main window, reader panels, and web workers within the same Zotero
process.

Alternative considered: `Zotero.DB.queryAsync()` (SQLite). This would work
but couples the plugin to Zotero's internal DB format and complicates schema
migrations. IndexedDB provides independent schema versioning via
`onupgradeneeded`.

## Database

- **Name**: `zotero-llm-assistant`
- **Current version**: 2
- **Module**: `src/modules/storage/db.ts`

## Object Stores

### `conversations` (v1+)

Stores per-item conversation history.

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | **keyPath** — Zotero item ID |
| `messages` | `ChatMessage[]` | All messages in chronological order |
| `updatedAt` | `string` | ISO timestamp of last update |

Each `ChatMessage`:

| Field | Type | Description |
|-------|------|-------------|
| `role` | `"user" \| "assistant" \| "system"` | Message sender |
| `content` | `string` | Message text |
| `timestamp` | `string` | ISO timestamp |
| `sourceChunks?` | `SourceChunkRef[]` | Chunk citations (assistant only, Phase B+) |

Each `SourceChunkRef`:

| Field | Type | Description |
|-------|------|-------------|
| `chunkId` | `string` | Chunk ID from the chunker |
| `pageStart` | `number` | First page of the chunk (1-based) |
| `pageEnd` | `number` | Last page of the chunk |
| `excerpt` | `string` | Short text excerpt for tooltips |

### `privacy` (v1+)

Per-item privacy flags.

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | `number` | **keyPath** — Zotero item ID |
| `isPrivate` | `boolean` | If true, content must not be sent to cloud providers |

Items without a privacy record default to **not private**. The global cloud
sharing toggle (`prefs.isCloudSharingEnabled()`) controls the overall
behavior; per-item flags override it for specific items.

### `chunk_embeddings` (v2+)

Stores embedding vectors for RAG chunks and library metadata.

| Field | Type | Description |
|-------|------|-------------|
| `chunkId` | `string` | **keyPath** — Chunk ID or synthetic `"meta:" + item.key` |
| `itemId` | `number` | Parent Zotero item ID (indexed for bulk invalidation) |
| `vector` | `number[]` | Float array (384 dimensions for all-MiniLM-L6-v2) |
| `updatedAt` | `string` | ISO timestamp of when the embedding was computed |

**Indexes**: `itemId` (non-unique) — enables efficient bulk deletion when a
PDF is re-extracted.

**Two kinds of records**:
1. **Reader chunks**: `chunkId` = chunker-assigned ID (e.g., `"42-p3-n0"`).
   Created during `buildRAGContext()` when the model is ready.
2. **Library metadata**: `chunkId` = `"meta:" + item.key` (synthetic).
   Created during `searchLibrary()` Stage 2 re-ranking.

### `embeddings` (v1 only — DROPPED in v2)

The v1 schema included an `embeddings` store keyed by `itemId`. This was
never populated and was replaced by `chunk_embeddings` in v2.

## Migration: v1 → v2

The `onupgradeneeded` handler detects the old version and:

1. Deletes the `embeddings` store if it exists (no data loss — never used).
2. Creates the `chunk_embeddings` store with `chunkId` keyPath and `itemId`
   index.
3. Leaves `conversations` and `privacy` stores untouched.

Fresh installs (v0 → v2) create all three active stores from scratch.

## CRUD Functions

### Conversations

| Function | Description |
|----------|-------------|
| `getConversation(itemId)` | Load a conversation record |
| `saveConversation(record)` | Upsert a conversation record |
| `appendMessage(itemId, message)` | Append to existing or create new |
| `deleteConversation(itemId)` | Delete a conversation |
| `getAllConversationSummaries()` | List all conversations (summary: itemId, messageCount, updatedAt) |

### Privacy

| Function | Description |
|----------|-------------|
| `isItemPrivate(itemId)` | Check privacy flag (defaults to false) |
| `setItemPrivacy(itemId, isPrivate)` | Set privacy flag |
| `getAllPrivateItemIds()` | Get all private item IDs as a `Set<number>` |

### Chunk Embeddings

| Function | Description |
|----------|-------------|
| `getChunkEmbedding(chunkId)` | Get a single embedding record |
| `getChunkEmbeddingsByItemId(itemId)` | Get all embeddings for an item |
| `saveChunkEmbeddings(records)` | Bulk upsert embeddings |
| `deleteChunkEmbedding(chunkId)` | Delete a single embedding |
| `deleteChunkEmbeddingsByItemId(itemId)` | Delete all embeddings for an item |

## Embedding Cache Invalidation

Embeddings are invalidated via the Zotero notifier in `indexer.ts`:

| Event | Action |
|-------|--------|
| PDF attachment modified | `deleteChunkEmbeddingsByItemId(parentItemId)` — reader chunks |
| Regular item modified | `deleteChunkEmbedding("meta:" + item.key)` — library metadata |
| Regular item deleted | Both chunk and metadata embeddings deleted |

The notifier reads the item key from the in-memory index **before** removing
the entry, because `Zotero.Items.get(id)` may return null during delete
callbacks.

## Embedding Model

- **Model**: `Xenova/all-MiniLM-L6-v2` (ONNX, quantized)
- **Dimensions**: 384
- **Size**: ~25MB (downloaded on first use)
- **Cache**: Managed by Transformers.js in IndexedDB (separate from our stores)
- **Revision tracking**: `prefs.getEmbeddingModelRevision()` — detects when a
  plugin update pins a new revision

## Data Lifecycle

| Data | Created | Updated | Deleted |
|------|---------|---------|---------|
| Conversation | First user question on an item | Each message append | Manual delete via history tab |
| Privacy flag | User toggles privacy for an item | User toggles again | Never (persists across sessions) |
| Chunk embedding (reader) | First reader question with model ready | Never (immutable) | PDF re-extraction or item delete |
| Metadata embedding (library) | First library search with model ready | Never (immutable) | Item modified or deleted |
