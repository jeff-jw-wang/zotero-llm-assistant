/**
 * Embedding module — local semantic embeddings with resilient runtime fallback.
 *
 * Primary backend:
 *   - Transformers.js (`Xenova/all-MiniLM-L6-v2`, 384 dims)
 *
 * Fallback backend (always available in Zotero runtime):
 *   - Lightweight hashing embedder (384 dims), deterministic and fully local
 *
 * If Transformers.js fails due to Zotero runtime/backend incompatibilities,
 * the module automatically switches to the hashing backend so semantic search
 * still works (reduced quality vs MiniLM, but functional and stable).
 *
 * @module modules/rag/embedder
 */
import * as prefs from "../../prefs";
import { clearAllChunkEmbeddings } from "../storage/db";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Model identifier on HuggingFace Hub.
 * all-MiniLM-L6-v2 produces 384-dim vectors, ~25MB ONNX download.
 */
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

/**
 * Pinned model revision for deterministic builds and auditability.
 * Update this when upgrading the model version; users will be prompted
 * to re-download via the consent flow (D2).
 *
 * To update: look up the latest commit hash at
 * https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2
 */
const PINNED_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
const HASH_BACKEND_REVISION = "local-hash-v1";

/**
 * Version of the *method* by which text becomes a vector.
 *
 * Bump this whenever the transformation changes in a way that makes new
 * vectors incomparable with cached ones — even if the model is unchanged. The
 * cache is cleared and rebuilt in the background on upgrade.
 *
 * History:
 *   1 — single forward pass per text; inputs over the model's 256-token limit
 *       were silently truncated by the tokenizer.
 *   2 — long inputs are split into overlapping windows and mean-pooled, so the
 *       whole text contributes. Pooled vectors differ from truncated ones, so
 *       v1 vectors must not be ranked alongside v2 vectors.
 */
export const EMBEDDING_METHOD_VERSION = 2;

/** Embedding vector dimensions (all-MiniLM-L6-v2). */
export const EMBEDDING_DIMS = 384;

/**
 * Maximum input the model actually accepts, in characters.
 *
 * all-MiniLM-L6-v2 has a 256-token maximum sequence length — about 1024
 * characters of English prose. Anything longer is silently truncated by the
 * tokenizer. That was a real quality bug: chunker.ts targets 2048-character
 * chunks (~512 tokens), so roughly the **second half of every chunk never
 * contributed to its embedding**, and long abstracts were cut mid-text.
 *
 * 900 is deliberately below the ~1024 ceiling: the chars-per-token ratio is
 * worse than 4:1 for dense academic prose, citations and numbers, so the
 * margin keeps real text inside the window.
 */
const MAX_INPUT_CHARS = 900;

/**
 * Overlap between windows, in characters, so a sentence split across a
 * boundary still contributes coherently to both windows.
 */
const WINDOW_OVERLAP_CHARS = 100;

type EmbeddingBackend = "transformers" | "hashing";

// ---------------------------------------------------------------------------
// EmbeddingRunner interface
// ---------------------------------------------------------------------------

/**
 * Abstract interface for embedding execution.
 * Allows swapping between Worker and main-thread implementations.
 */
interface EmbeddingRunner {
  embed(
    texts: string[],
    onProgress?: (p: number) => void,
  ): Promise<number[][]>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// MainThreadRunner
// ---------------------------------------------------------------------------

/**
 * Runs Transformers.js pipeline on the main thread.
 * Guaranteed fallback — works in all environments.
 */
class MainThreadRunner implements EmbeddingRunner {
  private pipeline: any = null;

  async embed(
    texts: string[],
    onProgress?: (p: number) => void,
  ): Promise<number[][]> {
    if (!this.pipeline) {
      this.pipeline = await this.loadPipeline(onProgress);
    }

    const results: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      const output = await this.pipeline(texts[i]!, {
        pooling: "mean",
        normalize: true,
      });
      results.push(Array.from(output.data as Float32Array));

      // Yield every 10 items to keep UI responsive.
      if (i > 0 && i % 10 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
        onProgress?.(i / texts.length);
      }
    }

    onProgress?.(1);
    return results;
  }

  private async loadPipeline(
    onProgress?: (p: number) => void,
  ): Promise<any> {
    // --- Console shim (must come before the Transformers.js import) ---
    // In Zotero's privileged chrome context, `console` is undefined.
    // Transformers.js calls console.log/warn internally; without this shim
    // those calls throw ReferenceError and crash model loading (Issue #1).
    if (typeof (globalThis as any).console === "undefined") {
      const safeLog = (...args: any[]) => {
        try {
          ztoolkit.log("[TF.js]", ...args);
        } catch {
          /* ztoolkit itself unavailable — silently discard */
        }
      };
      (globalThis as any).console = {
        log: safeLog,
        warn: safeLog,
        error: safeLog,
        info: safeLog,
        debug: () => {},
        group: () => {},
        groupEnd: () => {},
        groupCollapsed: () => {},
        time: () => {},
        timeEnd: () => {},
        trace: () => {},
        dir: () => {},
        table: () => {},
        assert: () => {},
      };
      ztoolkit.log("Embedder: installed console shim for Transformers.js");
    }

    // Dynamic import to avoid loading Transformers.js at module parse time.
    // env: configure before pipeline() to suppress unnecessary FS probing.
    //
    // KNOWN LIMITATION (Issue #1, Review P1): The bare specifier
    // "@huggingface/transformers" may fail to resolve in Zotero's privileged
    // chrome context ("bare specifier not remapped" error). This is a bundling
    // issue: the build system's `webpackIgnore: true` annotation skips the
    // import, but Zotero's chrome module loader doesn't have a module map for
    // it. A proper fix requires either (a) bundling Transformers.js into the
    // XPI as a file:// or resource:// path, or (b) registering a chrome module
    // alias in the addon manifest. Until then, the try/catch below produces a
    // descriptive error that propagates to the Settings UI, and the RAG
    // pipeline falls back to keyword-only scoring (extractor + chunker still
    // work fine without embeddings).
    let pipeline: any;
    let env: any;
    try {
      const mod = (await import(
        /* webpackIgnore: true */ "@huggingface/transformers"
      )) as any;
      pipeline = mod.pipeline;
      env = mod.env;
    } catch (importErr: any) {
      const msg = (importErr as Error)?.message ?? String(importErr);
      throw new Error(
        `Failed to load Transformers.js in Zotero context: ${msg}. ` +
          "This is a known limitation — semantic search requires a bundling fix. " +
          "Keyword-based search remains fully functional.",
      );
    }

    // Suppress Transformers.js's local-model filesystem probing, which fails
    // (and logs loudly) in chrome contexts that have no writable local path.
    if (env) {
      env.allowLocalModels = false;
      env.allowRemoteModels = true;
    }

    const opts: any = {
      revision: PINNED_REVISION,
      quantized: true,
      progress_callback: onProgress
        ? (data: any) => {
            if (data.progress != null) {
              onProgress(data.progress / 100);
            }
          }
        : undefined,
    };
    return pipeline("feature-extraction", MODEL_ID, opts);
  }

  dispose(): void {
    this.pipeline = null;
  }
}

// ---------------------------------------------------------------------------
// HashingRunner (runtime-safe local fallback)
// ---------------------------------------------------------------------------

/**
 * Lightweight deterministic embedding fallback.
 *
 * Produces 384-dim unit vectors using token + char-trigram hashing. This is
 * less semantically rich than MiniLM but avoids runtime/backend constraints.
 */
class HashingRunner implements EmbeddingRunner {
  async embed(
    texts: string[],
    onProgress?: (p: number) => void,
  ): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(hashEmbed(texts[i] ?? ""));
      if (i > 0 && i % 25 === 0) {
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      if (onProgress) {
        onProgress((i + 1) / texts.length);
      }
    }
    if (texts.length === 0) {
      onProgress?.(1);
    }
    return vectors;
  }

  dispose(): void {
    // No resources to release.
  }
}

// ---------------------------------------------------------------------------
// WorkerRunner (stub — implementation depends on spike S3 outcome)
// ---------------------------------------------------------------------------

/**
 * Runs Transformers.js pipeline inside a Web Worker.
 * Falls back gracefully if worker creation fails.
 */
class WorkerRunner implements EmbeddingRunner {
  private worker: Worker | null = null;
  private ready = false;

  async embed(
    texts: string[],
    onProgress?: (p: number) => void,
  ): Promise<number[][]> {
    if (!this.worker) {
      this.worker = this.createWorker();
    }

    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not available"));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error("Worker embedding timeout (120s)"));
      }, 120000);

      (this.worker as any).onmessage = (e: any) => {
        clearTimeout(timeout);
        const data = e.data;
        if (data.type === "progress" && onProgress) {
          onProgress(data.progress);
          return; // Wait for result.
        }
        if (data.type === "result") {
          resolve(data.vectors as number[][]);
        } else if (data.type === "error") {
          reject(new Error(data.message));
        }
      };

      (this.worker as any).onerror = (e: any) => {
        clearTimeout(timeout);
        reject(new Error("Worker error: " + (e.message || e)));
      };

      this.worker.postMessage({ type: "embed", texts });
    });
  }

  /**
   * Lightweight probe: tests that a Worker can be created and can
   * exchange messages, WITHOUT loading the model. This avoids triggering
   * a ~25MB download during the probe.
   */
  async probe(): Promise<void> {
    if (!this.worker) {
      this.worker = this.createWorker();
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Worker probe timeout (5s)"));
      }, 5000);

      (this.worker as any).onmessage = (e: any) => {
        clearTimeout(timeout);
        if (e.data?.type === "pong") {
          resolve();
        } else {
          reject(new Error("Unexpected probe response"));
        }
      };

      (this.worker as any).onerror = (e: any) => {
        clearTimeout(timeout);
        reject(new Error("Worker probe error: " + (e.message || e)));
      };

      this.worker!.postMessage({ type: "ping" });
    });
  }

  private createWorker(): Worker {
    // Create an inline worker that loads Transformers.js.
    // NOTE: The actual import path may need to be a chrome:// or resource:// URL
    // depending on the Zotero addon bundler output. This is validated in spike S3.
    const workerCode = `
      let pipeline = null;

      async function ensurePipeline() {
        if (pipeline) return pipeline;
        const { pipeline: createPipeline } = await import("@huggingface/transformers");
        pipeline = await createPipeline("feature-extraction", "${MODEL_ID}", {
          revision: "${PINNED_REVISION}",
          quantized: true,
          progress_callback: (data) => {
            if (data.progress != null) {
              self.postMessage({ type: "progress", progress: data.progress / 100 });
            }
          },
        });
        return pipeline;
      }

      self.onmessage = async function(e) {
        try {
          if (e.data.type === "ping") {
            self.postMessage({ type: "pong" });
            return;
          }
          const { texts } = e.data;
          const pipe = await ensurePipeline();
          const vectors = [];
          for (const text of texts) {
            const output = await pipe(text, { pooling: "mean", normalize: true });
            vectors.push(Array.from(output.data));
          }
          self.postMessage({ type: "result", vectors });
        } catch (err) {
          self.postMessage({ type: "error", message: err.message });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  }

  dispose(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** The active runner for this session. */
let runner: EmbeddingRunner | null = null;

/** Active embedding backend (for diagnostics + revision behavior). */
let backend: EmbeddingBackend | null = null;

/** Whether the model pipeline is ready (loaded and cached). */
let modelReady = false;

/** Whether we've already probed and selected a runner this session. */
let runnerProbed = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true once the model is loaded (cached locally) and ready for embedding.
 * Does not trigger a download — call `ensureModelReady()` for that.
 */
export function isModelReady(): boolean {
  return modelReady;
}

/**
 * Returns true if the stored model revision matches the current PINNED_REVISION.
 *
 * Used to:
 * - Auto-warm safely on startup (only when cached model is current — no surprise download).
 * - Detect stale models in the Settings UI ("Model update available").
 *
 * Returns false if no revision is stored (model never downloaded) or if
 * the plugin shipped a new PINNED_REVISION.
 */
export function isModelRevisionCurrent(): boolean {
  const stored = prefs.getEmbeddingModelRevision();
  return stored !== "" && (stored === PINNED_REVISION || stored === HASH_BACKEND_REVISION);
}

/**
 * Initializes the embedding pipeline, downloading the model if needed.
 * This is the explicit entry point that the UI calls after obtaining consent.
 *
 * @param onProgress - Optional progress callback (0–1).
 * @throws Error if consent has not been given (`isEmbeddingModelAccepted()` is false).
 */
export async function ensureModelReady(
  onProgress?: (p: number) => void,
): Promise<void> {
  if (modelReady) return;

  if (!prefs.isEmbeddingModelAccepted()) {
    throw new Error(
      "Embedding model consent not given. User must accept before download.",
    );
  }

  // Try Transformers first; if unavailable in runtime, auto-fallback to
  // hashing so semantic mode stays functional.
  const selection = await initializeRunner(onProgress);
  runner = selection.runner;
  backend = selection.backend;
  runnerProbed = true;

  modelReady = true;
  prefs.setEmbeddingModelRevision(
    backend === "transformers" ? PINNED_REVISION : HASH_BACKEND_REVISION,
  );
  prefs.setEmbeddingRuntimeUnsupported(false);
  prefs.setEmbeddingRuntimeUnsupportedReason("");

  await migrateEmbeddingMethod();
}

/**
 * Discards cached vectors produced by an older embedding method.
 *
 * Runs once per method bump, right after the model is ready and before any
 * embedding can be requested. Best-effort: if the cache cannot be cleared the
 * pref is left alone so the migration retries next time, rather than leaving
 * mixed-method vectors behind a version that claims to be current.
 */
async function migrateEmbeddingMethod(): Promise<void> {
  if (prefs.getEmbeddingMethodVersion() === EMBEDDING_METHOD_VERSION) return;

  try {
    await clearAllChunkEmbeddings();
    prefs.setEmbeddingMethodVersion(EMBEDDING_METHOD_VERSION);
    ztoolkit.log(
      `Embeddings: cleared cache for method v${EMBEDDING_METHOD_VERSION}; ` +
        "vectors will be rebuilt in the background.",
    );
  } catch (err: any) {
    ztoolkit.log(
      "Embeddings: method migration failed, will retry: " + err?.message,
    );
  }
}

/**
 * Splits text into overlapping windows that fit the model's input limit.
 *
 * Returns a single-element array for text already short enough, which is the
 * common case for queries and short abstracts.
 */
export function windowText(text: string): string[] {
  if (text.length <= MAX_INPUT_CHARS) return [text];

  const windows: string[] = [];
  const stride = MAX_INPUT_CHARS - WINDOW_OVERLAP_CHARS;

  for (let start = 0; start < text.length; start += stride) {
    const slice = text.slice(start, start + MAX_INPUT_CHARS);
    if (slice.trim().length > 0) windows.push(slice);
    if (start + MAX_INPUT_CHARS >= text.length) break;
  }

  return windows.length > 0 ? windows : [text.slice(0, MAX_INPUT_CHARS)];
}

/**
 * Mean-pools several window vectors into one, then L2-normalises.
 *
 * Mean pooling over windows is the standard way to represent a passage longer
 * than the encoder's window. Re-normalising afterwards matters because
 * `cosineSimilarity` and the callers' score blending assume unit vectors —
 * the component vectors are normalised individually, but their mean is not.
 */
export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return vectors[0]!;

  const dims = vectors[0]!.length;
  const sum = new Array<number>(dims).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dims && i < vec.length; i++) {
      sum[i] += vec[i]!;
    }
  }

  let norm = 0;
  for (let i = 0; i < dims; i++) {
    sum[i] /= vectors.length;
    norm += sum[i]! * sum[i]!;
  }

  norm = Math.sqrt(norm);
  if (norm === 0) return sum;

  for (let i = 0; i < dims; i++) sum[i] /= norm;
  return sum;
}

/**
 * Embeds a single text string.
 *
 * Requires both consent AND a prior call to `ensureModelReady()`. This
 * prevents accidental model downloads from embed calls deep in the pipeline.
 *
 * Text longer than the model's input window is split into overlapping windows
 * and mean-pooled, so the whole string contributes rather than being silently
 * truncated at 256 tokens.
 *
 * @param text - The text to embed.
 * @param onProgress - Optional callback: (progress: number) => void, 0–1.
 * @returns 384-dimensional vector as number[].
 * @throws Error if consent not given or model not ready.
 */
export async function embedText(
  text: string,
  onProgress?: (p: number) => void,
): Promise<number[]> {
  assertConsentAndReady();
  const currentRunner = await getRunner();
  const windows = windowText(text);
  const vectors = await currentRunner.embed(windows, onProgress);
  return meanPool(vectors);
}

/**
 * Embeds an array of texts in batch (for chunked documents).
 *
 * Requires both consent AND a prior call to `ensureModelReady()`.
 *
 * Each text is windowed to the model's input limit and mean-pooled, so a
 * 2048-character chunk is fully represented instead of truncated at 256
 * tokens. Windows across all texts are embedded in one batch, then regrouped.
 *
 * @param texts - Array of chunk texts.
 * @param onProgress - Optional callback.
 * @returns Array of vectors, same order as input.
 * @throws Error if consent not given or model not ready.
 */
export async function embedTexts(
  texts: string[],
  onProgress?: (p: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  assertConsentAndReady();
  const currentRunner = await getRunner();

  // Flatten every text's windows into one batch, remembering the spans so the
  // per-text vectors can be pooled back in order.
  const flat: string[] = [];
  const spans: Array<[number, number]> = [];

  for (const text of texts) {
    const windows = windowText(text);
    spans.push([flat.length, windows.length]);
    flat.push(...windows);
  }

  const vectors = await currentRunner.embed(flat, onProgress);

  return spans.map(([start, count]) =>
    meanPool(vectors.slice(start, start + count)),
  );
}

/**
 * Guard: both consent flag and model readiness must be true before embed calls.
 * This ensures the model is never downloaded as a side effect of embedding —
 * only `ensureModelReady()` (called from explicit UI consent) can trigger that.
 */
function assertConsentAndReady(): void {
  if (!prefs.isEmbeddingModelAccepted()) {
    throw new Error(
      "Embedding model consent not given. Call ensureModelReady() after obtaining user consent.",
    );
  }
  if (!modelReady) {
    throw new Error(
      "Embedding model not loaded. Call ensureModelReady() first.",
    );
  }
}

/**
 * Cosine similarity between two vectors. Pure function, no dependencies.
 *
 * Returns a value in [-1, 1]. Returns 0 for zero-magnitude vectors (no NaN).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * Disposes the current runner and releases resources.
 * Call during plugin shutdown.
 */
export function disposeEmbedder(): void {
  if (runner) {
    runner.dispose();
    runner = null;
  }
  backend = null;
  modelReady = false;
  runnerProbed = false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the active embedding runner.
 *
 * Zotero's extension runtime does not reliably resolve bare module specifiers
 * inside inline Worker code (e.g. `import("@huggingface/transformers")`),
 * which can break model loading in the worker path. To keep semantic search
 * stable, we currently force main-thread execution.
 *
 * If worker module resolution is solved in a future spike, this can be
 * switched back to a worker-first probe.
 */
async function getRunner(): Promise<EmbeddingRunner> {
  if (runner) return runner;
  const selection = await initializeRunner();
  runner = selection.runner;
  backend = selection.backend;
  runnerProbed = true;
  return runner;
}

async function initializeRunner(
  onProgress?: (p: number) => void,
): Promise<{ runner: EmbeddingRunner; backend: EmbeddingBackend }> {
  // Prefer full semantic model first.
  const tfRunner = new MainThreadRunner();
  try {
    await tfRunner.embed(["warmup"], onProgress);
    ztoolkit.log("Embedder: using Transformers backend");
    return { runner: tfRunner, backend: "transformers" };
  } catch (tfErr: any) {
    const msg = tfErr?.message ?? String(tfErr);
    ztoolkit.log(
      `Embedder: Transformers unavailable (${msg}). Falling back to hashing backend.`,
    );
  }

  // Guaranteed runtime-safe fallback.
  const hashRunner = new HashingRunner();
  await hashRunner.embed(["warmup"], onProgress);
  ztoolkit.log("Embedder: using hashing fallback backend");
  return { runner: hashRunner, backend: "hashing" };
}

function hashEmbed(text: string): number[] {
  const vector = new Float32Array(EMBEDDING_DIMS);
  const normalized = normalizeText(text);
  if (!normalized) {
    return Array.from(vector);
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    addFeature(vector, `tok:${token}`, 1.0);
    const len = token.length;
    if (len >= 3) {
      for (let i = 0; i <= len - 3; i++) {
        addFeature(vector, `tri:${token.slice(i, i + 3)}`, 0.35);
      }
    }
  }

  // Normalize to unit vector for cosine similarity.
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    norm += vector[i]! * vector[i]!;
  }
  if (norm > 0) {
    const inv = 1 / Math.sqrt(norm);
    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i]! * inv;
    }
  }
  return Array.from(vector);
}

function addFeature(vector: Float32Array, feature: string, weight: number): void {
  const h1 = fnv1a32(feature);
  const h2 = fnv1a32(`sign:${feature}`);
  const i1 = h1 % EMBEDDING_DIMS;
  const i2 = ((h1 >>> 8) ^ h2) % EMBEDDING_DIMS;
  const sign1 = (h2 & 1) === 0 ? 1 : -1;
  const sign2 = (h2 & 2) === 0 ? 1 : -1;

  vector[i1] = (vector[i1] ?? 0) + sign1 * weight;
  vector[i2] = (vector[i2] ?? 0) + sign2 * weight * 0.5;
}

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
