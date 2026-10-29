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
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
