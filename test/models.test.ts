/**
 * Tests for model/context-window resolution and input budgeting.
 *
 * Runs standalone: `npx tsx test/models.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * All tests exercise pure functions only (no network, no Zotero runtime).
 *
 * The central regression guarded here: the old `MODEL_TOKEN_CAPS` table in
 * `utils/tokens.ts` keyed caps on exact model ID strings and returned 8_000
 * for anything it did not recognise. Every model released after that table was
 * last edited therefore received an 8K input budget against a context window
 * up to 125x larger, silently. Nothing in this module may reintroduce a
 * punitive fallback for an unknown model.
 *
 * @see docs/MODERNIZATION_PLAN_2026.md — §3.2
 */

import assert from "node:assert/strict";
import {
  inferContextWindow,
  applyPricingBandCap,
  resolveInputBudget,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_LOCAL_CONTEXT_WINDOW,
  DEFAULT_OUTPUT_RESERVE,
  PREFERRED_MODELS,
  pickModel,
  canChat,
  parseOllamaShow,
} from "../src/modules/llm/models";
import { getTopKCapForBudget, AVG_CHUNK_TOKENS } from "../src/utils/tokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

/** The cap the old lookup table silently applied to unrecognised models. */
const LEGACY_BAD_CAP = 8_000;

// ---------------------------------------------------------------------------
// Regression: no punitive fallback for unknown models
// ---------------------------------------------------------------------------

console.log("\n=== Unknown-model fallback (the 8K regression) ===\n");

test("an unrecognised cloud model does not get the legacy 8K cap", () => {
  const { budget } = resolveInputBudget("anthropic", "some-model-from-2028");
  assert.ok(
    budget > LEGACY_BAD_CAP,
    `unknown model budget ${budget} must exceed the legacy ${LEGACY_BAD_CAP} cap`,
  );
});

test("unrecognised cloud models fall back to the generous window", () => {
  assert.equal(
    inferContextWindow("openai", "totally-unknown-model"),
    FALLBACK_CONTEXT_WINDOW,
  );
});

test("unrecognised local models fall back to the local window", () => {
  assert.equal(
    inferContextWindow("ollama", "some-future-model:9b"),
    FALLBACK_LOCAL_CONTEXT_WINDOW,
  );
});

test("a provider-reported window is preferred over inference", () => {
  // 1M reported for a model whose ID matches no family pattern.
  const { window } = resolveInputBudget("openai", "mystery-model", 1_000_000);
  assert.equal(window, 1_000_000);
});

// ---------------------------------------------------------------------------
// Family inference
// ---------------------------------------------------------------------------

console.log("\n=== Family inference ===\n");

test("current Claude 5.x models infer a 1M window", () => {
  for (const id of [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
  ]) {
    assert.equal(inferContextWindow("anthropic", id), 1_000_000, id);
  }
});

test("older Claude models infer the 200K window", () => {
  assert.equal(inferContextWindow("anthropic", "claude-haiku-4-5"), 200_000);
});

test("Gemini models infer a 1M window", () => {
  assert.equal(inferContextWindow("gemini", "gemini-3-flash"), 1_000_000);
});

test("inference is case-insensitive", () => {
  assert.equal(inferContextWindow("anthropic", "CLAUDE-SONNET-5-5"), 1_000_000);
});

test("most specific family pattern wins", () => {
  // Must not fall through to the generic /^claude-/ 200K rule.
  assert.equal(inferContextWindow("anthropic", "claude-opus-4-8"), 1_000_000);
});

// ---------------------------------------------------------------------------
// Billing-band cap
// ---------------------------------------------------------------------------

console.log("\n=== Billing-band cap ===\n");

test("Haiku 5.5 is capped at its 100K price band", () => {
  const { window, cappedBy } = applyPricingBandCap("claude-haiku-5-5", 1_000_000);
  assert.equal(window, 100_000);
  assert.match(String(cappedBy), /price/i);
});

test("a window already inside the band is untouched", () => {
  const { window, cappedBy } = applyPricingBandCap("claude-haiku-5-5", 50_000);
  assert.equal(window, 50_000);
  assert.equal(cappedBy, undefined);
});

test("models without a price cliff are untouched", () => {
  const { window, cappedBy } = applyPricingBandCap("claude-sonnet-5-5", 1_000_000);
  assert.equal(window, 1_000_000);
  assert.equal(cappedBy, undefined);
});

test("the band cap flows through resolveInputBudget", () => {
  const { budget, window } = resolveInputBudget(
    "anthropic",
    "claude-haiku-5-5",
    1_000_000,
  );
  assert.equal(window, 100_000);
  assert.equal(budget, 100_000 - DEFAULT_OUTPUT_RESERVE);
});

// ---------------------------------------------------------------------------
// Local budgeting: RAM, not the model's claim
// ---------------------------------------------------------------------------

console.log("\n=== Local (Ollama) budgeting ===\n");

test("num_ctx caps a local model's advertised window", () => {
  // Qwen3.5-4B advertises 256K, but an 8GB laptop cannot hold that KV cache.
  const { window } = resolveInputBudget("ollama", "qwen3.5:4b", 262_144, 16_384);
  assert.equal(window, 16_384);
});

test("num_ctx does not inflate a smaller advertised window", () => {
  const { window } = resolveInputBudget("ollama", "tiny:1b", 4_096, 16_384);
  assert.equal(window, 4_096);
});

test("num_ctx is ignored for cloud providers", () => {
  const { window } = resolveInputBudget(
    "anthropic",
    "claude-sonnet-5-5",
    1_000_000,
    16_384,
  );
  assert.equal(window, 1_000_000);
});

// ---------------------------------------------------------------------------
// Output reserve and floors
// ---------------------------------------------------------------------------

console.log("\n=== Output reserve ===\n");

test("the output reserve is withheld from the input budget", () => {
  const { budget, window } = resolveInputBudget(
    "anthropic",
    "claude-sonnet-5-5",
    200_000,
  );
  assert.equal(budget, window - DEFAULT_OUTPUT_RESERVE);
});

test("the reserve never consumes more than a quarter of a small window", () => {
  // A 4K local window must not be reduced to nothing by an 8K reserve.
  const { budget } = resolveInputBudget("ollama", "tiny:1b", 4_096, 4_096);
  assert.ok(budget >= 3_072, `budget ${budget} should keep most of a 4K window`);
});

test("the budget never goes non-positive", () => {
  const { budget } = resolveInputBudget("ollama", "tiny:1b", 512, 512);
  assert.ok(budget > 0, `budget ${budget} must be positive`);
});

// ---------------------------------------------------------------------------
// topK derivation
// ---------------------------------------------------------------------------

console.log("\n=== topK derivation ===\n");

test("topK scales with the budget", () => {
  assert.equal(getTopKCapForBudget(16_000), Math.floor(16_000 / AVG_CHUNK_TOKENS));
  assert.equal(getTopKCapForBudget(92_000), Math.floor(92_000 / AVG_CHUNK_TOKENS));
});

test("topK is at least 1 even for a tiny budget", () => {
  assert.equal(getTopKCapForBudget(10), 1);
});

test("a Haiku 5.5 budget admits far more chunks than the legacy cap did", () => {
  const { budget } = resolveInputBudget("anthropic", "claude-haiku-5-5", 1_000_000);
  const legacyTopK = Math.floor(LEGACY_BAD_CAP / AVG_CHUNK_TOKENS);
  assert.ok(
    getTopKCapForBudget(budget) > legacyTopK * 4,
    "resolved budget should admit several times the legacy chunk count",
  );
});

// ---------------------------------------------------------------------------
// Automatic model selection (plan defect D1)
// ---------------------------------------------------------------------------

console.log("\n=== Automatic model selection (D1) ===\n");

/**
 * Model IDs on OpenAI's pricing page, read 2026-11-12. The old name-pattern
 * logic selected `gpt-realtime-2.1-mini` from this list.
 */
const OPENAI_IDS = [
  "gpt-4.1", "gpt-4.1-2025-04-14", "gpt-4.1-mini", "gpt-4.1-mini-2025-04-14",
  "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5.1",
  "gpt-5.2", "gpt-5.2-pro", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini",
  "gpt-5.4-nano", "gpt-5.4-pro", "gpt-5.5", "gpt-5.5-pro", "gpt-5.6-luna",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-astra-law",
  "gpt-6-cyber", "gpt-6-luna", "gpt-6-rosalind", "gpt-6-sol", "gpt-6.1-sol",
  "gpt-6.1-terra", "gpt-realtime-2.1", "gpt-realtime-2.1-mini",
  "gpt-image-2", "text-embedding-3-small", "o4-mini",
];

/** Illustrative: every one of these supports `generateContent`. */
const GEMINI_IDS = [
  "gemini-3.1-flash-image-preview", "gemini-3.1-pro-preview",
  "gemini-3-flash", "gemini-3-flash-lite", "gemini-2.5-flash-preview-tts",
];

const ANTHROPIC_IDS = [
  "claude-3-haiku-20240307", "claude-haiku-4-5-20251001", "claude-haiku-5-5",
  "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2",
];

const OLLAMA_NO_QWEN35 = [
  { id: "qwen3-embedding:0.6b", capabilities: ["embedding"] },
  { id: "nomic-embed-text:latest", capabilities: ["embedding"] },
  { id: "gemma3:4b", capabilities: ["completion", "vision"] },
];

test("OpenAI: picks the preferred chat model, not a realtime model", () => {
  assert.equal(pickModel("openai", OPENAI_IDS), "gpt-6-luna");
});

test("OpenAI: without the preferred ID, asks instead of guessing", () => {
  const ids = OPENAI_IDS.filter((id) => id !== "gpt-6-luna");
  assert.equal(pickModel("openai", ids), undefined);
});

test("OpenAI: a look-alike of the preferred ID is not selected", () => {
  assert.equal(
    pickModel("openai", ["gpt-6-luna-audio", "gpt-6-luna-2", "gpt-5.6-luna"]),
    undefined,
  );
});

test("Gemini: never picks an image or TTS model by name", () => {
  const picked = pickModel("gemini", GEMINI_IDS);
  assert.equal(picked, undefined);
});

test("Gemini: uses the preferred alias when the provider offers it", () => {
  assert.equal(
    pickModel("gemini", [...GEMINI_IDS, "gemini-flash-latest"]),
    "gemini-flash-latest",
  );
});

test("Anthropic: picks Haiku 5.5, not a retired dated Haiku", () => {
  assert.equal(pickModel("anthropic", ANTHROPIC_IDS), "claude-haiku-5-5");
});

test("Anthropic: accepts a dated snapshot of the preferred ID, newest first", () => {
  const ids = [
    "claude-3-haiku-20240307",
    "claude-haiku-5-5-20260801",
    "claude-haiku-5-5-20261001",
    "claude-sonnet-5-5",
  ];
  assert.equal(pickModel("anthropic", ids), "claude-haiku-5-5-20261001");
});

test("Anthropic: only retired/unknown models on offer means no pick", () => {
  assert.equal(
    pickModel("anthropic", ["claude-3-haiku-20240307", "claude-opus-4-1"]),
    undefined,
  );
});

test("Ollama: never picks an embedding model; takes the one chat model", () => {
  assert.equal(pickModel("ollama", OLLAMA_NO_QWEN35), "gemma3:4b");
});

test("Ollama: prefers qwen3.5:4b, then qwen3.5:2b", () => {
  const both = [
    { id: "llama3.2:latest", capabilities: ["completion"] },
    { id: "qwen3.5:2b", capabilities: ["completion", "thinking"] },
    { id: "qwen3.5:4b", capabilities: ["completion", "thinking", "vision"] },
  ];
  assert.equal(pickModel("ollama", both), "qwen3.5:4b");
  assert.equal(pickModel("ollama", both.slice(0, 2)), "qwen3.5:2b");
});

test("Ollama: a preferred ID that reports no chat capability is skipped", () => {
  assert.equal(
    pickModel("ollama", [{ id: "qwen3.5:4b", capabilities: ["embedding"] }]),
    undefined,
  );
});

test("Ollama: several chat models and no preferred one means no pick", () => {
  const models = [
    { id: "gemma3:4b", capabilities: ["completion"] },
    { id: "llama3.2:latest", capabilities: ["completion"] },
  ];
  assert.equal(pickModel("ollama", models), undefined);
});

test("Ollama: only embedding models installed means no pick", () => {
  assert.equal(pickModel("ollama", OLLAMA_NO_QWEN35.slice(0, 2)), undefined);
});

test("Ollama: capabilities unreported — one model is taken, several are not", () => {
  assert.equal(pickModel("ollama", ["mistral:latest"]), "mistral:latest");
  assert.equal(
    pickModel("ollama", ["mistral:latest", "qwen3-embedding:0.6b"]),
    undefined,
  );
});

test("an unknown model beside a known embedding model is not assumed to chat", () => {
  assert.equal(
    pickModel("ollama", [
      { id: "mystery:latest" },
      { id: "all-minilm:latest", capabilities: ["embedding"] },
    ]),
    undefined,
  );
});

test("custom endpoint: a single served model is used; otherwise no pick", () => {
  assert.equal(pickModel("custom", ["local-model"]), "local-model");
  assert.equal(pickModel("custom", ["a", "b"]), undefined);
});

test("no models means no pick, for every provider", () => {
  for (const p of Object.keys(PREFERRED_MODELS) as Array<
    keyof typeof PREFERRED_MODELS
  >) {
    assert.equal(pickModel(p, []), undefined);
  }
});

test("canChat distinguishes yes, no and not-reported", () => {
  assert.equal(canChat({ capabilities: ["completion", "vision"] }), true);
  assert.equal(canChat({ capabilities: ["embedding"] }), false);
  assert.equal(canChat({}), undefined);
});

test("parseOllamaShow reads capabilities and the context length", () => {
  // Shape from Ollama's "show model details" API reference.
  const parsed = parseOllamaShow({
    capabilities: ["completion", "thinking", "vision"],
    model_info: {
      "general.architecture": "qwen35",
      "qwen35.context_length": 262144,
      "qwen35.embedding_length": 2560,
    },
  });
  assert.deepEqual(parsed.capabilities, ["completion", "thinking", "vision"]);
  assert.equal(parsed.contextWindow, 262144);
});

test("parseOllamaShow tolerates an older Ollama with no capabilities", () => {
  assert.deepEqual(parseOllamaShow({ model_info: {} }), {});
  assert.deepEqual(parseOllamaShow(undefined), {});
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
