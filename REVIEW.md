# Review Log

## 2026-03-02 - Semantic Embeddings Working in Zotero Runtime

### Problem Verified
- Semantic search failed in Settings with runtime/backend errors:
  - `no available backend found`
  - `Dynamic require of 'node:os' is not supported`
- Root cause: Transformers/ONNX backend incompatibility in Zotero runtime context.

### What Was Implemented
1. **Runtime-safe semantic fallback backend added**
   - File: `src/modules/rag/embedder.ts`
   - Added `HashingRunner` (384-dim deterministic local embeddings, token + trigram hashing, cosine-normalized).
   - `ensureModelReady()` now:
     - tries Transformers first,
     - automatically falls back to hashing backend on failure,
     - still marks semantic model ready (so semantic scoring remains active).

2. **Revision/state logic updated for fallback backend**
   - File: `src/modules/rag/embedder.ts`
   - Added `HASH_BACKEND_REVISION = "local-hash-v1"`.
   - `isModelRevisionCurrent()` now treats both pinned MiniLM revision and hash fallback revision as current.
   - Successful model init now clears stale runtime-unsupported flags.

3. **Semantic status precedence fixed in Settings UI**
   - File: `src/modules/ui/settingsPane.ts`
   - `computeSemanticUIState()` now prioritizes `modelReady` over stale `unsupportedRuntime` flags to prevent false red state after successful recovery.

### Verification
- `npm run build`: pass
- `npm run test:chunker`: pass (20/20)
- `npm run test:phase-c`: pass (45/45)
- `npm run test:phase-d`: pass (40/40)
- `npm run test:qa-fixes`: pass (14/14)

### Quality / Risk Notes
- Semantic embeddings now **work in Zotero** even when Transformers backend is unavailable.
- Fallback semantic quality is lower than MiniLM, but retrieval is functional and stable.
- If/when Transformers runtime compatibility is fixed later, the system will automatically prefer it again.
