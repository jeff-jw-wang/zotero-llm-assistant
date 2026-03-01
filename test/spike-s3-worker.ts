/**
 * Spike S3 — Web Worker support in Zotero 7.
 *
 * This file contains two test scripts meant to be run inside Zotero's
 * developer console (Tools → Developer → Run JavaScript). They cannot
 * run in Node.js because they require the XULRunner/Gecko environment.
 *
 * ## Part A — Worker Primitive
 * Tests whether `new Worker(URL.createObjectURL(blob))` works inside
 * a bootstrapped Zotero 7 XPI.
 *
 * ## Part B — Worker + Transformers.js
 * Tests whether Transformers.js can load and embed text inside a Worker.
 * Only run if Part A passes.
 *
 * ## Go/No-Go Criteria (D1):
 * 1. Worker can be created from addon code
 * 2. Transformers.js loads and returns embeddings inside the worker
 * 3. UI stays responsive during indexing
 * 4. Worker memory footprint < 200MB resident
 * 5. worker.terminate() doesn't leak memory
 * All five must pass for "go". Any failure → MainThreadRunner fallback.
 *
 * ## How to Run:
 * 1. Build the plugin: `npm run build`
 * 2. Install the XPI in Zotero 7
 * 3. Open Tools → Developer → Run JavaScript
 * 4. Copy-paste Part A code block, execute
 * 5. If Part A passes, copy-paste Part B code block, execute
 * 6. Record results in docs/ZOTERO_API.md under "## Web Workers"
 *
 * @module test/spike-s3-worker
 */

// ======================================================================
// Part A — Worker Primitive
// ======================================================================
// Copy everything between the Part A markers into Zotero's JS console.

/*
// --- Part A: Worker Primitive Test ---
(async () => {
  try {
    const workerCode = `
      self.onmessage = function(e) {
        self.postMessage({ echo: e.data, pid: "worker" });
      };
    `;
    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker timeout (5s)")), 5000);
      worker.onmessage = (e) => {
        clearTimeout(timeout);
        resolve(e.data);
      };
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error("Worker error: " + e.message));
      };
      worker.postMessage("ping");
    });

    worker.terminate();
    URL.revokeObjectURL(url);

    if (result && result.echo === "ping" && result.pid === "worker") {
      Zotero.log("[S3-A] PASS: Worker created, message round-trip successful.");
      return "PASS";
    } else {
      Zotero.log("[S3-A] FAIL: Unexpected response: " + JSON.stringify(result));
      return "FAIL";
    }
  } catch (err) {
    Zotero.log("[S3-A] FAIL: " + err.message);
    return "FAIL: " + err.message;
  }
})();
*/

// ======================================================================
// Part B — Worker + Transformers.js
// ======================================================================
// Only run if Part A passed. This test requires @huggingface/transformers
// to be bundled and accessible from the addon's module scope.
//
// NOTE: This test may need adaptation based on how the addon's bundler
// exposes modules to workers. The worker needs to import Transformers.js,
// which may require a dedicated worker entry point in the build config.
//
// If dynamic import inside a Blob worker is not supported, try:
// 1. Create a separate worker script file in the addon bundle
// 2. Reference it via chrome:// or resource:// URL
//
// The test measures:
// - Can Transformers.js load in a worker context?
// - Does pipeline("feature-extraction", ...) return vectors?
// - Memory footprint after model load
// - Does worker.terminate() clean up?

/*
// --- Part B: Worker + Transformers.js Test ---
// This is a conceptual test. The actual import path for Transformers.js
// inside a worker depends on the bundler output format.
(async () => {
  try {
    // Attempt 1: Use a worker with dynamic import
    // This may fail if CSP or module resolution prevents it.
    const workerCode = `
      self.onmessage = async function(e) {
        try {
          // Dynamic import — may need a full URL path
          const { pipeline } = await import("@huggingface/transformers");
          const extractor = await pipeline(
            "feature-extraction",
            "Xenova/all-MiniLM-L6-v2",
            { quantized: true }
          );
          const output = await extractor("test embedding", {
            pooling: "mean",
            normalize: true,
          });
          const vector = Array.from(output.data);
          self.postMessage({
            success: true,
            vectorLength: vector.length,
            sample: vector.slice(0, 5),
          });
        } catch (err) {
          self.postMessage({ success: false, error: err.message });
        }
      };
    `;

    const blob = new Blob([workerCode], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);

    // Memory before
    const memBefore = performance?.memory?.usedJSHeapSize || 0;

    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Worker+TF.js timeout (120s)")),
        120000,
      );
      worker.onmessage = (e) => {
        clearTimeout(timeout);
        resolve(e.data);
      };
      worker.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error("Worker error: " + e.message));
      };
      worker.postMessage("go");
    });

    // Memory after (approximate — may not be accurate for worker memory)
    const memAfter = performance?.memory?.usedJSHeapSize || 0;
    const memDeltaMB = ((memAfter - memBefore) / 1024 / 1024).toFixed(1);

    worker.terminate();
    URL.revokeObjectURL(url);

    if (result.success) {
      Zotero.log(`[S3-B] PASS: Vector length=${result.vectorLength}, ` +
        `sample=${JSON.stringify(result.sample)}, ` +
        `approx memory delta=${memDeltaMB}MB`);
      return "PASS";
    } else {
      Zotero.log("[S3-B] FAIL: " + result.error);
      return "FAIL: " + result.error;
    }
  } catch (err) {
    Zotero.log("[S3-B] FAIL: " + err.message);
    return "FAIL: " + err.message;
  }
})();
*/

// ======================================================================
// Results Template (copy to docs/ZOTERO_API.md)
// ======================================================================
/*
## Web Workers

**Spike S3 — tested on**: Zotero [version], [OS]

| Test | Result | Notes |
|------|--------|-------|
| Part A: Worker primitive | PASS/FAIL | |
| Part B: Worker + Transformers.js | PASS/FAIL/SKIPPED | |
| Vector dimensions | 384 or N/A | |
| Memory delta | ~NNN MB | |
| worker.terminate() | Clean/Leaked | |

**Decision**: WorkerRunner / MainThreadRunner

The embedder module always probes WorkerRunner at runtime regardless of this
result. This spike sets expectations and documents the tested environment.
*/

export {};
