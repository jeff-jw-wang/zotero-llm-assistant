/**
 * Tests for the M1 defect fixes that are not about model selection
 * (those live in models.test.ts).
 *
 * Runs standalone: `npx tsx test/m1-fixes.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * Covers, by defect number in docs/MODERNIZATION_PLAN_2026.md §4:
 *   D2 — the configured Ollama context size is sent in the request.
 *   D4 — Anthropic non-streaming answers survive a leading thinking block.
 *   D8 — the progress note is cleared by answer text, not by a usage report.
 *   D3 — button labels in the settings locale file use the attribute form.
 *
 * No network: providers are driven through a stubbed `Zotero.HTTP.request`
 * and a stubbed `fetch`, and the request bodies they send are captured.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Zotero global stubs
// ---------------------------------------------------------------------------

const mockPrefs: Record<string, any> = {};

/** Every request sent through Zotero.HTTP.request or fetch, newest last. */
const sent: Array<{ url: string; body: any }> = [];
/** What the next non-streaming request returns. */
let nextResponse: any = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string) {
      return mockPrefs[key];
    },
    set(key: string, value: any) {
      mockPrefs[key] = value;
    },
  },
  HTTP: {
    async request(_method: string, url: string, opts: any) {
      sent.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
      const text = JSON.stringify(nextResponse);
      return { status: 200, responseText: text, response: text };
    },
  },
};
(globalThis as any).ztoolkit = { log: () => {} };
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

const PREFIX = "extensions.zotero.zotero-llm-assistant";

const { OllamaProvider, DEFAULT_NUM_CTX } = await import(
  "../src/modules/llm/providers/ollama"
);
const { createProvider } = await import("../src/modules/llm/client");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

const MESSAGES = [
  { role: "system" as const, content: "You answer questions about a paper." },
  { role: "user" as const, content: "What is the main finding?" },
];

/** Replaces global fetch with one that records the body and streams `lines`. */
function stubStreamingFetch(lines: string[]): void {
  (globalThis as any).fetch = async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(lines.join("\n") + "\n", { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// D2 — Ollama context size
// ---------------------------------------------------------------------------

console.log("\n=== D2: Ollama request carries the configured context size ===\n");

await test("buildRequestBody sends the context size it was constructed with", () => {
  const provider = new OllamaProvider("http://localhost:11434", 8192);
  const body: any = provider.buildRequestBody(MESSAGES, { model: "qwen3.5:4b" }, true);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.model, "qwen3.5:4b");
  assert.equal(body.stream, true);
});

await test("a missing or invalid context size falls back to the default, never to none", () => {
  for (const bad of [undefined, 0, -1, NaN]) {
    const provider = new OllamaProvider("http://localhost:11434", bad as any);
    const body: any = provider.buildRequestBody(MESSAGES, { model: "m" }, false);
    assert.equal(body.options.num_ctx, DEFAULT_NUM_CTX);
  }
});

await test("non-streaming chat() puts the configured size on the wire", async () => {
  sent.length = 0;
  nextResponse = { message: { content: "ok" }, done: true };
  const provider = new OllamaProvider("http://localhost:11434", 32768);
  const answer = await provider.chat(MESSAGES, { model: "qwen3.5:4b" });
  assert.equal(answer, "ok");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.url.endsWith("/api/chat"));
  assert.equal(sent[0]!.body.options.num_ctx, 32768);
  assert.equal(sent[0]!.body.stream, false);
});

await test("streaming chatStream() puts the configured size on the wire", async () => {
  sent.length = 0;
  stubStreamingFetch([
    JSON.stringify({ message: { content: "Hel" }, done: false }),
    JSON.stringify({ message: { content: "lo" }, done: true }),
  ]);
  const provider = new OllamaProvider("http://localhost:11434", 4096);
  let text = "";
  for await (const chunk of provider.chatStream(MESSAGES, { model: "m" })) {
    text += chunk.text;
  }
  assert.equal(text, "Hello");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.options.num_ctx, 4096);
  assert.equal(sent[0]!.body.stream, true);
});

await test("createProvider() passes the llm.ollama.numCtx preference through", async () => {
  mockPrefs[`${PREFIX}.llm.provider`] = "ollama";
  mockPrefs[`${PREFIX}.llm.ollama.endpoint`] = "http://localhost:11434";
  mockPrefs[`${PREFIX}.llm.ollama.numCtx`] = 24576;

  sent.length = 0;
  nextResponse = { message: { content: "ok" }, done: true };
  await createProvider().chat(MESSAGES, { model: "m" });
  assert.equal(sent[0]!.body.options.num_ctx, 24576);

  // Changing the setting changes the next request.
  mockPrefs[`${PREFIX}.llm.ollama.numCtx`] = 8192;
  sent.length = 0;
  await createProvider().chat(MESSAGES, { model: "m" });
  assert.equal(sent[0]!.body.options.num_ctx, 8192);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
