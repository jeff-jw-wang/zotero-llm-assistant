/**
 * Embedding module — Transformers.js wrapper for local text embeddings.
 *
 * Provides `embedText()` and `embedTexts()` for generating 384-dimensional
 * vectors using the `Xenova/all-MiniLM-L6-v2` ONNX model. The model is
 * downloaded on first use (~25MB) with user consent (D2).
 *
 * Architecture (D1):
 *   Uses an `EmbeddingRunner` interface with two implementations:
 *   - `WorkerRunner`: runs Transformers.js in a Web Worker (primary)
 *   - `MainThreadRunner`: guaranteed fallback on main thread
 *
 *   At runtime, `WorkerRunner` is always probed first (try/catch). If it
 *   fails (worker unsupported, ONNX load error, etc.), falls back to
 *   `MainThreadRunner` for the rest of the session.
 *
 * Model lifecycle (D2):
 *   - Model downloaded only after explicit user consent
 *   - Pinned revision hash for deterministic builds
 *   - Cached locally by Transformers.js in IndexedDB
 *   - Version-keyed: revision change triggers re-download prompt
 *
 * @module modules/rag/embedder
 */
import * as prefs from "../../prefs";

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

/** Embedding vector dimensions (all-MiniLM-L6-v2). */
export const EMBEDDING_DIMS = 384;

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
    const { pipeline, env } = (await import(
      /* webpackIgnore: true */ "@huggingface/transformers"
    )) as any;

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
  return stored !== "" && stored === PINNED_REVISION;
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

  // Context guard: Transformers.js dynamic imports and IndexedDB (used for
  // model caching) both fail in Zotero's reader panel privileged chrome frame.
  // IndexedDB availability is the reliable proxy for "am I in the main window?"
  // — it is defined in the main window context but undefined in reader panels.
  if (typeof (globalThis as any).indexedDB === "undefined") {
    throw new Error(
      "ensureModelReady() must be called from the main Zotero window, not from a " +
        "reader panel context. Call it from hooks.ts onStartup() or the Settings pane.",
    );
  }

  const currentRunner = await getRunner();

  // Warm up by embedding a short test string — this triggers model download.
  await currentRunner.embed(["warmup"], onProgress);

  // If we get here, the model is loaded and cached.
  modelReady = true;
  prefs.setEmbeddingModelRevision(PINNED_REVISION);
}

/**
 * Embeds a single text string.
 *
 * Requires both consent AND a prior call to `ensureModelReady()`. This
 * prevents accidental model downloads from embed calls deep in the pipeline.
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
  const [vector] = await currentRunner.embed([text], onProgress);
  return vector!;
}

/**
 * Embeds an array of texts in batch (for chunked documents).
 *
 * Requires both consent AND a prior call to `ensureModelReady()`.
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
  const result = await currentRunner.embed(texts, onProgress);
  return result;
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
  runnerProbed = true;
  // Main-thread only mode (stable in Zotero 8).
  runner = new MainThreadRunner();
  ztoolkit.log("Embedder: using MainThreadRunner");
  return runner;
}
