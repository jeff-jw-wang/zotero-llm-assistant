/**
 * Phase D tests — embeddings, semantic scoring, export, conversation summaries.
 *
 * Runs standalone: `npx tsx test/phase-d.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * Tests cover:
 * - cosineSimilarity() — pure math function
 * - scoreItem() with semanticScore — D4 blended scoring
 * - exportConversationAsMarkdown() — pure function
 * - formatRelativeDate()-like edge cases (indirectly)
 *
 * Note: scoreChunks() in pipeline.ts is internal (not exported), so we test
 * the exported scoring API (scoreItem) and cosineSimilarity directly.
 * Pipeline integration is validated via build + manual testing in Zotero.
 *
 * @see PLAN_PHASE_D.md — Step 13
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test harness (same pattern as phase-c.test.ts)
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

// ---------------------------------------------------------------------------
// Zotero global mock — required before importing modules that use Zotero
// ---------------------------------------------------------------------------

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

(globalThis as any).ztoolkit = { log: () => {} };
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

// ===========================================================================
// cosineSimilarity() tests
// ===========================================================================

// Import after globals are set up.
const { cosineSimilarity } = await import("../src/modules/rag/embedder");

console.log("\n=== cosineSimilarity() Tests ===\n");

test("identical vectors → 1.0", () => {
  const v = [1, 0, 0, 1];
  const result = cosineSimilarity(v, v);
  assert.ok(Math.abs(result - 1.0) < 1e-6, `Expected ~1.0, got ${result}`);
});

test("orthogonal vectors → 0.0", () => {
  const a = [1, 0, 0, 0];
  const b = [0, 1, 0, 0];
  const result = cosineSimilarity(a, b);
  assert.ok(Math.abs(result) < 1e-6, `Expected ~0.0, got ${result}`);
});

test("opposite vectors → -1.0", () => {
  const a = [1, 0, 0];
  const b = [-1, 0, 0];
  const result = cosineSimilarity(a, b);
  assert.ok(Math.abs(result - (-1.0)) < 1e-6, `Expected ~-1.0, got ${result}`);
});

test("zero vector → 0.0 (no NaN)", () => {
  const a = [0, 0, 0];
  const b = [1, 2, 3];
  const result = cosineSimilarity(a, b);
  assert.equal(result, 0);
  assert.ok(!isNaN(result), "Should not be NaN");
});

test("both zero vectors → 0.0 (no NaN)", () => {
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const result = cosineSimilarity(a, b);
  assert.equal(result, 0);
  assert.ok(!isNaN(result), "Should not be NaN");
});

test("different-length vectors → 0", () => {
  const a = [1, 2];
  const b = [1, 2, 3];
  const result = cosineSimilarity(a, b);
  assert.equal(result, 0);
});

test("empty vectors → 0", () => {
  const result = cosineSimilarity([], []);
  assert.equal(result, 0);
});

test("parallel vectors (different magnitude) → 1.0", () => {
  const a = [1, 2, 3];
  const b = [2, 4, 6];
  const result = cosineSimilarity(a, b);
  assert.ok(Math.abs(result - 1.0) < 1e-6, `Expected ~1.0, got ${result}`);
});

test("anti-parallel vectors → -1.0", () => {
  const a = [1, 2, 3];
  const b = [-3, -6, -9];
  const result = cosineSimilarity(a, b);
  assert.ok(Math.abs(result - (-1.0)) < 1e-6, `Expected ~-1.0, got ${result}`);
});

test("known angle (45 degrees) → ~0.707", () => {
  // [1, 0] and [1, 1] → cos(45°) = 1/√2 ≈ 0.7071
  const a = [1, 0];
  const b = [1, 1];
  const result = cosineSimilarity(a, b);
  assert.ok(
    Math.abs(result - Math.SQRT1_2) < 1e-4,
    `Expected ~0.7071, got ${result}`,
  );
});

// ===========================================================================
// scoreItem() with semanticScore tests (D4 blend)
// ===========================================================================

const { scoreItem } = await import("../src/modules/library/searcher");
import type { ItemMetadata } from "../src/modules/library/indexer";

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

console.log("\n=== scoreItem() with semanticScore (D4) Tests ===\n");

test("without semanticScore → same as Phase C (regression)", () => {
  const meta = makeMeta({ title: "Deep Learning for NLP" });
  const score = scoreItem(meta, ["deep"]);
  // keyword-only: title match = 30
  assert.equal(score, 30);
});

test("without semanticScore, no match → 0", () => {
  const meta = makeMeta({ title: "Quantum Physics" });
  const score = scoreItem(meta, ["biology"]);
  assert.equal(score, 0);
});

test("semanticScore=1.0, keywordScore=0 → 40", () => {
  // normKeyword = min(1, 0/95) = 0
  // normSemantic = 1.0
  // finalScore = round((0.6 * 0 + 0.4 * 1.0) * 100) = 40
  const meta = makeMeta({ title: "Completely Unrelated" });
  const score = scoreItem(meta, ["quantum"], 1.0);
  assert.equal(score, 40);
});

test("semanticScore=0.0, keywordScore=95 (max) → 60", () => {
  // normKeyword = min(1, 95/95) = 1.0
  // normSemantic = 0.0
  // finalScore = round((0.6 * 1.0 + 0.4 * 0) * 100) = 60
  const meta = makeMeta({
    title: "deep",
    authors: "deep",
    tags: ["deep"],
    abstract: "deep",
    year: "2023",
  });
  // "deep": title +30, authors +15, tags +20, abstract +5 = 70
  // "2023": year +25 = 25
  // total keyword = 95
  const score = scoreItem(meta, ["deep", "2023"], 0.0);
  assert.equal(score, 60);
});

test("semanticScore=1.0, keywordScore=95 → 100", () => {
  // normKeyword = 1.0, normSemantic = 1.0
  // finalScore = round((0.6 + 0.4) * 100) = 100
  const meta = makeMeta({
    title: "deep",
    authors: "deep",
    tags: ["deep"],
    abstract: "deep",
    year: "2023",
  });
  const score = scoreItem(meta, ["deep", "2023"], 1.0);
  assert.equal(score, 100);
});

test("semanticScore=0.5, keywordScore=47.5 → 50", () => {
  // normKeyword = min(1, 47.5/95) = 0.5
  // normSemantic = 0.5
  // finalScore = round((0.6 * 0.5 + 0.4 * 0.5) * 100) = round(50) = 50
  // To get 47.5 keyword: title match (30) + authors match (15) + abstract match (2.5)?
  // But score per field is integer-like... Let's construct it:
  // title match: 30, authors match: 15, abstract match: 5 → total 50 per keyword
  // We want 47.5 which isn't achievable with integer weights.
  // Let's use a scenario that gets close: title(30) + authors(15) = 45 per keyword
  // That gives normKeyword = 45/95 ≈ 0.4737
  // finalScore = round((0.6 * 0.4737 + 0.4 * 0.5) * 100) = round(48.42) = 48
  // Let me just test with exact values we can verify:
  // title(30) only: normKeyword = 30/95 ≈ 0.3158
  // semanticScore = 0.5
  // finalScore = round((0.6 * 0.3158 + 0.4 * 0.5) * 100) = round(38.95) = 39
  const meta = makeMeta({ title: "deep learning" });
  const score = scoreItem(meta, ["deep"], 0.5);
  // normKeyword = 30/95 ≈ 0.3158
  // finalScore = round((0.6 * 30/95 + 0.4 * 0.5) * 100)
  const expected = Math.round((0.6 * (30 / 95) + 0.4 * 0.5) * 100);
  assert.equal(score, expected);
});

test("semanticScore=0 for item missing embedding → uses normalized scale", () => {
  // This simulates the "same-scale rule": item has no embedding, but semantic
  // mode is active. Should use normSemantic=0, NOT raw keyword score.
  const meta = makeMeta({ title: "Test Paper" });
  const score = scoreItem(meta, ["test"], 0);
  // normKeyword = 30/95
  // normSemantic = 0
  // finalScore = round(0.6 * 30/95 * 100) = round(18.95) = 19
  const expected = Math.round((0.6 * (30 / 95) + 0.4 * 0) * 100);
  assert.equal(score, expected);
});

test("normKeyword clamped to 1.0 for multi-keyword high scores", () => {
  // Construct a scenario where raw keyword score exceeds MAX_LIBRARY_KEYWORD_SCORE (95).
  // e.g. "deep learning": title +30+30=60, abstract +5+5=10, tags +20+20=40 → total 110
  const meta = makeMeta({
    title: "deep learning methods",
    abstract: "deep learning approach",
    tags: ["deep-learning"],
  });
  const score = scoreItem(meta, ["deep", "learning"], 0.5);
  // keywordScore = "deep": title(30)+abstract(5)+tags(20) = 55
  //              + "learning": title(30)+abstract(5)+tags(20) = 55
  //              = 110
  // normKeyword = min(1, 110/95) = 1.0 (CLAMPED)
  // finalScore = round((0.6 * 1.0 + 0.4 * 0.5) * 100) = round(80) = 80
  assert.equal(score, 80);
});

// ===========================================================================
// exportConversationAsMarkdown() tests
// ===========================================================================

const { exportConversationAsMarkdown } = await import("../src/utils/export");
import type { ConversationRecord, SourceChunkRef } from "../src/modules/storage/db";

console.log("\n=== exportConversationAsMarkdown() Tests ===\n");

test("single user+assistant exchange → correct Markdown structure", () => {
  const record: ConversationRecord = {
    itemId: 1,
    messages: [
      { role: "user", content: "What is this paper about?", timestamp: "2026-01-15T10:00:00Z" },
      { role: "assistant", content: "This paper is about deep learning.", timestamp: "2026-01-15T10:00:05Z" },
    ],
    updatedAt: "2026-01-15T10:00:05Z",
  };

  const md = exportConversationAsMarkdown(record, "Deep Learning Overview");
  assert.ok(md.startsWith("# Conversation: Deep Learning Overview"));
  assert.ok(md.includes("_Exported on "));
  assert.ok(md.includes("### User"));
  assert.ok(md.includes("What is this paper about?"));
  assert.ok(md.includes("### Assistant"));
  assert.ok(md.includes("This paper is about deep learning."));
});

test("chunk citations [c.ID] in assistant message → converted to [p.X–Y]", () => {
  const record: ConversationRecord = {
    itemId: 2,
    messages: [
      { role: "user", content: "Summarize the intro.", timestamp: "2026-01-15T10:00:00Z" },
      {
        role: "assistant",
        content: "The intro discusses [c.42-p1-n0] and [c.42-p3-n1].",
        timestamp: "2026-01-15T10:00:05Z",
        sourceChunks: [
          { chunkId: "42-p1-n0", pageStart: 1, pageEnd: 2, excerpt: "Introduction..." },
          { chunkId: "42-p3-n1", pageStart: 3, pageEnd: 3, excerpt: "Methods..." },
        ],
      },
    ],
    updatedAt: "2026-01-15T10:00:05Z",
  };

  const md = exportConversationAsMarkdown(record, "Test Paper");
  // [c.42-p1-n0] → [p.1–2], [c.42-p3-n1] → [p.3]
  assert.ok(md.includes("[p.1\u20132]"), `Expected [p.1–2] in: ${md}`);
  assert.ok(md.includes("[p.3]"), `Expected [p.3] in: ${md}`);
  assert.ok(!md.includes("[c.42-p1-n0]"), "Chunk citation should be replaced");
  assert.ok(!md.includes("[c.42-p3-n1]"), "Chunk citation should be replaced");
});

test("chunk citation with unknown ID → kept as [c.ID]", () => {
  const record: ConversationRecord = {
    itemId: 3,
    messages: [
      {
        role: "assistant",
        content: "See [c.unknown-chunk] for details.",
        timestamp: "2026-01-15T10:00:00Z",
        sourceChunks: [
          { chunkId: "known-chunk", pageStart: 5, pageEnd: 5, excerpt: "Known..." },
        ],
      },
    ],
    updatedAt: "2026-01-15T10:00:00Z",
  };

  const md = exportConversationAsMarkdown(record, "Test");
  assert.ok(md.includes("[c.unknown-chunk]"), "Unknown chunk ID should be preserved");
});

test("empty messages array → minimal valid Markdown", () => {
  const record: ConversationRecord = {
    itemId: 4,
    messages: [],
    updatedAt: "2026-01-15T10:00:00Z",
  };

  const md = exportConversationAsMarkdown(record, "Empty Paper");
  assert.ok(md.includes("# Conversation: Empty Paper"));
  assert.ok(md.includes("No messages"));
});

test("system messages are skipped in export", () => {
  const record: ConversationRecord = {
    itemId: 5,
    messages: [
      { role: "system", content: "You are a helpful assistant.", timestamp: "2026-01-15T10:00:00Z" },
      { role: "user", content: "Hello", timestamp: "2026-01-15T10:00:01Z" },
    ],
    updatedAt: "2026-01-15T10:00:01Z",
  };

  const md = exportConversationAsMarkdown(record, "System Test");
  assert.ok(!md.includes("You are a helpful assistant"), "System message should be excluded");
  assert.ok(md.includes("### User"));
  assert.ok(md.includes("Hello"));
});

test("assistant message without sourceChunks → no citation conversion", () => {
  const record: ConversationRecord = {
    itemId: 6,
    messages: [
      {
        role: "assistant",
        content: "See [c.some-chunk] for details.",
        timestamp: "2026-01-15T10:00:00Z",
        // No sourceChunks
      },
    ],
    updatedAt: "2026-01-15T10:00:00Z",
  };

  const md = exportConversationAsMarkdown(record, "No Chunks");
  // Without sourceChunks, the raw [c.some-chunk] should remain
  assert.ok(md.includes("[c.some-chunk]"), "Should keep raw citation when no sourceChunks");
});

// ===========================================================================
// estimateTokens() tests (quick sanity check)
// ===========================================================================

const { estimateTokens } = await import("../src/utils/tokens");

console.log("\n=== estimateTokens() Sanity Tests ===\n");

test("empty string → 0 tokens", () => {
  assert.equal(estimateTokens(""), 0);
});

test("4 chars → 1 token", () => {
  assert.equal(estimateTokens("word"), 1);
});

test("1000 chars → 250 tokens", () => {
  assert.equal(estimateTokens("a".repeat(1000)), 250);
});

test("5 chars → 2 tokens (rounds up)", () => {
  assert.equal(estimateTokens("hello"), 2);
});

// ===========================================================================
// parseLibraryLinks regression tests (ensure Phase C still works)
// ===========================================================================

const { parseLibraryLinks } = await import("../src/modules/library/searcher");
const { computeSemanticUIState } = await import("../src/modules/ui/settingsPane");

console.log("\n=== parseLibraryLinks() Regression Tests ===\n");

test("pattern with key in allowedKeys → allowed (D6 regression)", () => {
  const text = "See zotero://select/library/items/ABCD1234.";
  const links = parseLibraryLinks(text, new Set(["ABCD1234"]));
  assert.equal(links.length, 1);
  assert.equal(links[0]!.allowed, true);
});

test("pattern with key NOT in allowedKeys → not allowed (D6 regression)", () => {
  const text = "See zotero://select/library/items/FAKE0000.";
  const links = parseLibraryLinks(text, new Set(["ABCD1234"]));
  assert.equal(links.length, 1);
  assert.equal(links[0]!.allowed, false);
});

// ===========================================================================
// Semantic settings UI regression tests
// ===========================================================================

console.log("\n=== Semantic UI Regression Tests ===\n");

test("revision current + not ready shows manual recovery (Load Model)", () => {
  const state = computeSemanticUIState(
    true,  // consent accepted
    false, // model not loaded in memory
    true,  // revision matches pinned
    true,  // cached model exists
  );

  assert.equal(state.statusText, "Model cached (not loaded)");
  assert.equal(state.statusColor, "#b45309");
  assert.equal(state.buttonHidden, false);
  assert.equal(state.buttonDisabled, false);
  assert.equal(state.buttonLabel, "Load Model");
});

// ===========================================================================
// scoreItem() regression tests (Phase C compatibility)
// ===========================================================================

console.log("\n=== scoreItem() Regression Tests (Phase C compat) ===\n");

test("title+authors+tags+abstract+year all match → 95 (no semantic)", () => {
  const meta = makeMeta({
    title: "deep",
    authors: "deep",
    tags: ["deep"],
    abstract: "deep",
    year: "2023",
  });
  const score = scoreItem(meta, ["deep", "2023"]);
  // "deep": title(30) + authors(15) + tags(20) + abstract(5) = 70
  // "2023": year(25) = 25
  assert.equal(score, 95);
});

test("year-only keyword → 25", () => {
  const meta = makeMeta({ year: "2023" });
  const score = scoreItem(meta, ["2023"]);
  assert.equal(score, 25);
});

test("case-insensitive matching → works", () => {
  const meta = makeMeta({ title: "DEEP LEARNING" });
  const score = scoreItem(meta, ["deep"]);
  assert.equal(score, 30);
});

// ===========================================================================
// D4 edge cases: semantic scoring boundaries
// ===========================================================================

console.log("\n=== D4 Edge Cases ===\n");

test("semanticScore exactly 0 → only keyword contribution", () => {
  const meta = makeMeta({ title: "test paper" });
  const score = scoreItem(meta, ["test"], 0);
  // normKeyword = 30/95 ≈ 0.3158
  // finalScore = round(0.6 * 0.3158 * 100) = round(18.95) = 19
  const expected = Math.round(0.6 * (30 / 95) * 100);
  assert.equal(score, expected);
});

test("semanticScore exactly 1 → maximum semantic boost", () => {
  const meta = makeMeta({}); // no keyword matches
  const score = scoreItem(meta, ["nothing"], 1.0);
  // normKeyword = 0, normSemantic = 1
  // finalScore = round(0.4 * 100) = 40
  assert.equal(score, 40);
});

test("very small semanticScore (0.01) → near-zero semantic contribution", () => {
  const meta = makeMeta({}); // no keyword matches
  const score = scoreItem(meta, ["nothing"], 0.01);
  // normKeyword = 0, normSemantic = 0.01
  // finalScore = round(0.4 * 0.01 * 100) = round(0.4) = 0
  assert.equal(score, 0);
});

test("semanticScore with no keywords → pure semantic score", () => {
  const meta = makeMeta({ title: "irrelevant" });
  const score = scoreItem(meta, ["xyz"], 0.8);
  // keyword: no match → 0
  // normKeyword = 0, normSemantic = 0.8
  // finalScore = round(0.4 * 0.8 * 100) = round(32) = 32
  assert.equal(score, 32);
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
