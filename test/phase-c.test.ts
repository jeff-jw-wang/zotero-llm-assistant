/**
 * Phase C tests — library search scoring, context building, link whitelist,
 * checkLibraryPrivacy, and createProvider factory.
 *
 * Runs standalone: `npx tsx test/phase-c.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * Pure-function tests (scoreItem, buildLLMContext, parseLibraryLinks,
 * validateEndpointURL) need no runtime mocks. The checkLibraryPrivacy and
 * createProvider tests set up a minimal Zotero.Prefs mock so the actual
 * client.ts code path is exercised.
 *
 * @see PLAN_PHASE_C.md — Step 12
 */

import assert from "node:assert/strict";
import { scoreItem, buildLLMContext, parseLibraryLinks } from "../src/modules/library/searcher";
import type { SearchResult } from "../src/modules/library/searcher";
import type { ItemMetadata } from "../src/modules/library/indexer";

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

function makeMeta(overrides: Partial<ItemMetadata> = {}): ItemMetadata {
  return {
    itemId: 1,
    key: "ABCD1234",
    title: "",
    authors: "",
    year: "",
    abstract: "",
    tags: [],
    doi: "",
    itemType: "journalArticle",
    ...overrides,
  };
}

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    itemId: 1,
    key: "ABCD1234",
    title: "Test Paper",
    authors: "Smith, Jones",
    year: "2023",
    abstract: "A test abstract.",
    score: 30,
    ...overrides,
  };
}

// ===========================================================================
// scoreItem() tests
// ===========================================================================

console.log("\n=== scoreItem() Tests ===\n");

test("no keyword match → score 0", () => {
  const meta = makeMeta({ title: "Machine Learning Overview" });
  const score = scoreItem(meta, ["quantum", "biology"]);
  assert.equal(score, 0);
});

test("title-only match → +30 per keyword", () => {
  const meta = makeMeta({ title: "Deep Learning for NLP" });
  const score = scoreItem(meta, ["deep"]);
  assert.equal(score, 30);
});

test("title match with two keywords → +60", () => {
  const meta = makeMeta({ title: "Deep Learning for NLP" });
  const score = scoreItem(meta, ["deep", "learning"]);
  assert.equal(score, 60);
});

test("author match → +15 per keyword", () => {
  const meta = makeMeta({ authors: "Smith, Johnson" });
  const score = scoreItem(meta, ["smith"]);
  assert.equal(score, 15);
});

test("tag match → +20 per keyword", () => {
  const meta = makeMeta({ tags: ["machine-learning", "nlp"] });
  const score = scoreItem(meta, ["machine"]);
  assert.equal(score, 20);
});

test("abstract match → +5 per keyword", () => {
  const meta = makeMeta({ abstract: "This paper presents a novel deep learning method." });
  const score = scoreItem(meta, ["novel"]);
  assert.equal(score, 5);
});

test("exact 4-digit year match → +25", () => {
  const meta = makeMeta({ year: "2023" });
  const score = scoreItem(meta, ["2023"]);
  assert.equal(score, 25);
});

test("non-year token does not trigger year bonus", () => {
  const meta = makeMeta({ year: "2023" });
  const score = scoreItem(meta, ["deep"]); // "deep" is not 4-digit
  assert.equal(score, 0);
});

test("5-digit 'year' does not trigger year bonus", () => {
  const meta = makeMeta({ year: "2023" });
  const score = scoreItem(meta, ["20230"]); // 5 digits
  assert.equal(score, 0);
});

test("multiple matching keywords accumulate across fields", () => {
  const meta = makeMeta({
    title: "Deep Learning for NLP",
    authors: "Smith",
    tags: ["deep-learning"],
    abstract: "A deep learning method for natural language processing.",
    year: "2023",
  });
  // "deep": title +30, tags +20, abstract +5 = 55
  // "2023": year +25 = 25
  const score = scoreItem(meta, ["deep", "2023"]);
  assert.equal(score, 80);
});

test("case-insensitive matching", () => {
  const meta = makeMeta({ title: "DEEP LEARNING" });
  const score = scoreItem(meta, ["deep"]); // keywords are already lowercase
  assert.equal(score, 30);
});

// ===========================================================================
// buildLLMContext() tests
// ===========================================================================

console.log("\n=== buildLLMContext() Tests ===\n");

test("single result → correct fields emitted", () => {
  const result = makeResult({
    key: "XYZ789",
    title: "Test Paper",
    authors: "Smith, Jones",
    year: "2023",
    abstract: "A test abstract.",
  });
  const ctx = buildLLMContext([result]);
  assert.ok(ctx.includes("Title: Test Paper"));
  assert.ok(ctx.includes("Authors: Smith, Jones"));
  assert.ok(ctx.includes("Year: 2023"));
  assert.ok(ctx.includes("Abstract: A test abstract."));
  assert.ok(ctx.includes("Link: zotero://select/library/items/XYZ789"));
});

test("abstract truncated at 300 chars with ...", () => {
  const longAbstract = "A".repeat(350);
  const result = makeResult({ abstract: longAbstract });
  const ctx = buildLLMContext([result]);
  // Should contain first 300 chars + "..."
  assert.ok(ctx.includes("A".repeat(300) + "..."));
  assert.ok(!ctx.includes("A".repeat(301)));
});

test("short abstract is NOT truncated", () => {
  const shortAbstract = "Short abstract under 300 chars.";
  const result = makeResult({ abstract: shortAbstract });
  const ctx = buildLLMContext([result]);
  assert.ok(ctx.includes(`Abstract: ${shortAbstract}`));
  assert.ok(!ctx.includes("..."));
});

test("multiple results joined with separator", () => {
  const r1 = makeResult({ key: "AAA", title: "Paper One" });
  const r2 = makeResult({ key: "BBB", title: "Paper Two" });
  const ctx = buildLLMContext([r1, r2]);
  assert.ok(ctx.includes("\n---\n"));
  assert.ok(ctx.includes("Title: Paper One"));
  assert.ok(ctx.includes("Title: Paper Two"));
});

test("zotero://select link format is correct", () => {
  const result = makeResult({ key: "TESTKEY1" });
  const ctx = buildLLMContext([result]);
  assert.ok(ctx.includes("Link: zotero://select/library/items/TESTKEY1"));
});

test("empty results array → empty string", () => {
  const ctx = buildLLMContext([]);
  assert.equal(ctx, "");
});

// ===========================================================================
// parseLibraryLinks() tests
// ===========================================================================

console.log("\n=== parseLibraryLinks() Tests ===\n");

test("pattern with key in allowedKeys → marked allowed", () => {
  const text = "See zotero://select/library/items/ABCD1234 for details.";
  const allowed = new Set(["ABCD1234"]);
  const links = parseLibraryLinks(text, allowed);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.key, "ABCD1234");
  assert.equal(links[0]!.allowed, true);
  assert.equal(links[0]!.url, "zotero://select/library/items/ABCD1234");
});

test("pattern with key NOT in allowedKeys → marked not allowed", () => {
  const text = "See zotero://select/library/items/FAKE0000 for details.";
  const allowed = new Set(["ABCD1234"]);
  const links = parseLibraryLinks(text, allowed);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.key, "FAKE0000");
  assert.equal(links[0]!.allowed, false);
});

test("multiple patterns, mixed allowed/not-allowed", () => {
  const text = [
    "See zotero://select/library/items/AAA111",
    "and zotero://select/library/items/BBB222",
    "also zotero://select/library/items/CCC333",
  ].join(" ");
  const allowed = new Set(["AAA111", "CCC333"]);
  const links = parseLibraryLinks(text, allowed);
  assert.equal(links.length, 3);
  assert.equal(links[0]!.key, "AAA111");
  assert.equal(links[0]!.allowed, true);
  assert.equal(links[1]!.key, "BBB222");
  assert.equal(links[1]!.allowed, false);
  assert.equal(links[2]!.key, "CCC333");
  assert.equal(links[2]!.allowed, true);
});

test("no zotero links in text → empty array", () => {
  const text = "This is a plain text response with no special links.";
  const links = parseLibraryLinks(text, new Set(["ABC"]));
  assert.equal(links.length, 0);
});

test("malformed pattern (wrong prefix) → not matched", () => {
  const text = "See zotero://open/library/items/ABCD1234 for details.";
  const links = parseLibraryLinks(text, new Set(["ABCD1234"]));
  assert.equal(links.length, 0);
});

test("link start and end indices are correct", () => {
  const prefix = "Check this: ";
  const link = "zotero://select/library/items/KEY12345";
  const suffix = " and more.";
  const text = prefix + link + suffix;
  const links = parseLibraryLinks(text, new Set(["KEY12345"]));
  assert.equal(links.length, 1);
  assert.equal(links[0]!.start, prefix.length);
  assert.equal(links[0]!.end, prefix.length + link.length);
});

test("empty allowedKeys → all links marked not allowed", () => {
  const text = "See zotero://select/library/items/ABCD1234.";
  const links = parseLibraryLinks(text, new Set());
  assert.equal(links.length, 1);
  assert.equal(links[0]!.allowed, false);
});

// ===========================================================================
// Zotero global mock — required before importing client.ts
//
// client.ts → prefs.ts → Zotero.Prefs.get/set
// client.ts → db.ts → uses (globalThis as any).indexedDB lazily (OK)
// ===========================================================================

/** In-memory pref store for the mock. */
const mockPrefs: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string, _global?: boolean) {
      return mockPrefs[key];
    },
    set(key: string, value: any, _global?: boolean) {
      mockPrefs[key] = value;
    },
  },
};

// ztoolkit stub (some modules log via ztoolkit.log).
(globalThis as any).ztoolkit = { log: () => {} };

// addon stub (some code reads addon.data.config).
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

// Now safe to import modules that depend on Zotero globals.
const { checkLibraryPrivacy, createProvider } = await import("../src/modules/llm/client");
import { validateEndpointURL } from "../src/utils/url";
import { OpenAIProvider } from "../src/modules/llm/providers/openai";
import { AnthropicProvider } from "../src/modules/llm/providers/anthropic";

/** Helper: set a pref in the mock store (uses the full namespaced key). */
const PREF_PREFIX = "extensions.zotero.zotero-llm-assistant";
function setMockPref(suffix: string, value: any) {
  mockPrefs[`${PREF_PREFIX}.${suffix}`] = value;
}

// ===========================================================================
// checkLibraryPrivacy() tests — real function from client.ts
// ===========================================================================

console.log("\n=== checkLibraryPrivacy() Tests (real import) ===\n");

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
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

await testAsync("local provider (isCloud = false) → returns null", async () => {
  setMockPref("privacy.cloudSharingEnabled", false);
  const localProvider = { isCloud: false } as any;
  assert.equal(await checkLibraryPrivacy(localProvider), null);
});

await testAsync("local provider, sharing enabled → still null", async () => {
  setMockPref("privacy.cloudSharingEnabled", true);
  const localProvider = { isCloud: false } as any;
  assert.equal(await checkLibraryPrivacy(localProvider), null);
});

await testAsync("cloud provider, sharing enabled → returns null", async () => {
  setMockPref("privacy.cloudSharingEnabled", true);
  const cloudProvider = { isCloud: true } as any;
  assert.equal(await checkLibraryPrivacy(cloudProvider), null);
});

await testAsync("cloud provider, sharing disabled → returns non-null error", async () => {
  setMockPref("privacy.cloudSharingEnabled", false);
  const cloudProvider = { isCloud: true } as any;
  const result = await checkLibraryPrivacy(cloudProvider);
  assert.notEqual(result, null);
  assert.ok(typeof result === "string");
  assert.ok(result!.includes("Cloud sharing is disabled"));
});

// ===========================================================================
// createProvider() tests — real function from client.ts
// ===========================================================================

console.log("\n=== createProvider() Tests (real import) ===\n");

test("createProvider('openai') with valid config → returns OpenAIProvider", () => {
  setMockPref("llm.provider", "openai");
  setMockPref("llm.openai.apiKey", "sk-test-key-123");
  setMockPref("llm.openai.endpoint", "https://api.openai.com");
  const provider = createProvider();
  assert.ok(provider instanceof OpenAIProvider);
});

test("createProvider('openai') with missing key → throws", () => {
  setMockPref("llm.provider", "openai");
  setMockPref("llm.openai.apiKey", "");
  assert.throws(() => createProvider(), /API key is not set/);
});

test("createProvider('openai') with private-IP endpoint → throws SSRF error", () => {
  setMockPref("llm.provider", "openai");
  setMockPref("llm.openai.apiKey", "sk-test-key-123");
  setMockPref("llm.openai.endpoint", "https://192.168.1.1");
  assert.throws(() => createProvider(), /invalid/i);
});

test("createProvider('openai') with HTTP endpoint → throws SSRF error", () => {
  setMockPref("llm.provider", "openai");
  setMockPref("llm.openai.apiKey", "sk-test-key-123");
  setMockPref("llm.openai.endpoint", "http://api.openai.com");
  assert.throws(() => createProvider(), /invalid|HTTPS/i);
});

test("createProvider('anthropic') with valid key → returns AnthropicProvider", () => {
  setMockPref("llm.provider", "anthropic");
  setMockPref("llm.anthropic.apiKey", "sk-ant-test-key");
  const provider = createProvider();
  assert.ok(provider instanceof AnthropicProvider);
});

test("createProvider('anthropic') with missing key → throws", () => {
  setMockPref("llm.provider", "anthropic");
  setMockPref("llm.anthropic.apiKey", "");
  assert.throws(() => createProvider(), /API key is not set/);
});

test("createProvider('custom') with valid config → returns OpenAIProvider (D1)", () => {
  setMockPref("llm.provider", "custom");
  setMockPref("llm.custom.endpoint", "https://my-proxy.example.com");
  setMockPref("llm.custom.apiKey", "custom-key-123");
  const provider = createProvider();
  assert.ok(provider instanceof OpenAIProvider); // D1: reuses OpenAI class
});

test("createProvider('custom') with empty endpoint → throws", () => {
  setMockPref("llm.provider", "custom");
  setMockPref("llm.custom.endpoint", "");
  setMockPref("llm.custom.apiKey", "custom-key-123");
  assert.throws(() => createProvider(), /URL is not set/);
});

test("createProvider('custom') with empty key → throws", () => {
  setMockPref("llm.provider", "custom");
  setMockPref("llm.custom.endpoint", "https://my-proxy.example.com");
  setMockPref("llm.custom.apiKey", "");
  assert.throws(() => createProvider(), /API key is not set/);
});

// ===========================================================================
// SSRF validateEndpointURL() tests — pure function, no mocks needed
// ===========================================================================

console.log("\n=== SSRF Validation Tests ===\n");

test("valid HTTPS endpoint passes validation", () => {
  const r = validateEndpointURL("https://api.openai.com");
  assert.equal(r.valid, true);
});

test("HTTP endpoint fails validation (HTTPS required)", () => {
  const r = validateEndpointURL("http://api.openai.com");
  assert.equal(r.valid, false);
  assert.ok(r.error != null);
});

test("private IP endpoint (127.0.0.1) fails validation", () => {
  const r = validateEndpointURL("https://127.0.0.1");
  assert.equal(r.valid, false);
});

test("private IP endpoint (192.168.x.x) fails validation", () => {
  const r = validateEndpointURL("https://192.168.1.1");
  assert.equal(r.valid, false);
});

test("localhost hostname fails validation", () => {
  const r = validateEndpointURL("https://localhost");
  assert.equal(r.valid, false);
});

test(".local hostname fails validation", () => {
  const r = validateEndpointURL("https://myserver.local");
  assert.equal(r.valid, false);
});

test("empty string fails validation", () => {
  const r = validateEndpointURL("");
  assert.equal(r.valid, false);
});

test("Ollama default (localhost:11434) is blocked for custom endpoint", () => {
  const r = validateEndpointURL("http://localhost:11434");
  assert.equal(r.valid, false);
});

// ===========================================================================
// Summary
// ===========================================================================

console.log("\n========================================");
if (failed === 0) {
  console.log(`Results: ${passed} passed, ${failed} failed`);
} else {
  console.log(`Results: ${passed} passed, ${failed} FAILED`);
}
console.log("========================================\n");

if (failed > 0) process.exit(1);
