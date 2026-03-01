/**
 * Deterministic tests for the chunker, pipeline scoring, and citation parsing.
 *
 * Runs standalone: `npx tsx test/chunker.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * All tests exercise pure functions only (no DOM, no Zotero runtime).
 *
 * @see PLAN_PHASE_B.md — Step 6
 */

import assert from "node:assert/strict";
import {
  chunkPages,
  makeChunkCiteRegex,
  CHUNK_ID_PATTERN,
  TARGET_CHUNK_CHARS,
  type Chunk,
} from "../src/modules/rag/chunker";
import { parseCitedChunkIds } from "../src/modules/ui/readerPanel";
import type { ExtractedPage } from "../src/modules/rag/extractor";

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

function makePages(...texts: string[]): ExtractedPage[] {
  return texts.map((text, i) => ({ page: i + 1, text }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log("\n=== Chunker Tests ===\n");

// --- 1. Chunk determinism ---
test("same input produces same chunk IDs and boundaries", () => {
  const pages = makePages(
    "This is page one with some content about machine learning.",
    "Page two discusses neural networks and deep learning architectures.",
  );
  const key = "TESTKEY1";

  const run1 = chunkPages(pages, key);
  const run2 = chunkPages(pages, key);

  assert.equal(run1.length, run2.length, "chunk count should match");
  for (let i = 0; i < run1.length; i++) {
    assert.equal(run1[i]!.id, run2[i]!.id, `chunk ${i} ID should match`);
    assert.equal(run1[i]!.text, run2[i]!.text, `chunk ${i} text should match`);
    assert.equal(run1[i]!.pageStart, run2[i]!.pageStart, `chunk ${i} pageStart should match`);
    assert.equal(run1[i]!.pageEnd, run2[i]!.pageEnd, `chunk ${i} pageEnd should match`);
  }
});

// --- 2. Page-range mapping ---
test("chunk spanning \\f boundary has correct pageStart/pageEnd", () => {
  // Two short pages that will be merged into a single chunk (both < TARGET_CHUNK_CHARS).
  const pages = makePages(
    "Abstract: This paper presents a novel approach.",
    "We evaluate on three benchmarks.",
  );
  const chunks = chunkPages(pages, "TESTKEY2");

  // With short text, everything should fit in one chunk.
  assert.equal(chunks.length, 1, "should produce one chunk");
  assert.equal(chunks[0]!.pageStart, 1, "pageStart should be 1");
  assert.equal(chunks[0]!.pageEnd, 2, "pageEnd should be 2");
});

test("multiple pages produce correct per-chunk page ranges", () => {
  // Create pages that are long enough to each be their own chunk.
  const longText = "Lorem ipsum ".repeat(200); // ~2400 chars
  const pages = makePages(longText, longText, "Short page three.");
  const chunks = chunkPages(pages, "TESTKEY3");

  // Each long page should be its own chunk; short page may merge with last.
  assert.ok(chunks.length >= 2, `expected >= 2 chunks, got ${chunks.length}`);
  assert.equal(chunks[0]!.pageStart, 1, "first chunk starts at page 1");
  assert.equal(chunks[0]!.pageEnd, 1, "first chunk ends at page 1");
});

// --- 3. Oversized paragraph ---
test("single paragraph > TARGET_CHUNK_CHARS is split", () => {
  // Create a single very long paragraph (no \n\n, no sentence boundaries for extra long).
  const longSentences: string[] = [];
  for (let i = 0; i < 60; i++) {
    longSentences.push(
      `Sentence number ${i} provides additional information about the experiment.`,
    );
  }
  const longText = longSentences.join(" "); // ~4500 chars, no paragraph breaks
  const pages = makePages(longText);
  const chunks = chunkPages(pages, "TESTKEY4");

  assert.ok(chunks.length >= 2, `expected >= 2 chunks for oversized text, got ${chunks.length}`);
  for (const chunk of chunks) {
    // Allow a small margin for word-boundary splits.
    assert.ok(
      chunk.text.length <= TARGET_CHUNK_CHARS + 100,
      `chunk text (${chunk.text.length} chars) should be near TARGET_CHUNK_CHARS`,
    );
  }
});

// --- 4. Empty input ---
test("empty pages produce empty chunk array", () => {
  const chunks = chunkPages([], "TESTKEY5");
  assert.equal(chunks.length, 0, "should return empty array");
});

test("pages with only whitespace produce empty chunk array", () => {
  const pages = makePages("   ", "\n\n\t  ");
  const chunks = chunkPages(pages, "TESTKEY6");
  assert.equal(chunks.length, 0, "should return empty array for whitespace-only pages");
});

// --- 5. Collision handling ---
test("different attachment keys produce different chunk IDs", () => {
  const pages = makePages("Same text on page one.");
  const chunksA = chunkPages(pages, "KEY_A");
  const chunksB = chunkPages(pages, "KEY_B");

  assert.equal(chunksA.length, 1);
  assert.equal(chunksB.length, 1);
  assert.notEqual(
    chunksA[0]!.id,
    chunksB[0]!.id,
    "different keys should produce different IDs",
  );
});

test("chunk IDs are 8-hex-char format (or with collision suffix)", () => {
  const pages = makePages(
    "Page one content.",
    "Page two content.",
    "Page three content.",
  );
  const chunks = chunkPages(pages, "TESTKEY7");
  const idRe = new RegExp(`^${CHUNK_ID_PATTERN}$`);

  for (const chunk of chunks) {
    assert.match(chunk.id, idRe, `chunk ID "${chunk.id}" should match pattern`);
  }
});

// --- 6. Citation parsing ---
console.log("\n=== Citation Parsing Tests ===\n");

test("parseCitedChunkIds extracts unique IDs in order", () => {
  const text = "According to [c.abc12345] and confirmed by [c.abc12345] and also [c.def67890].";
  const ids = parseCitedChunkIds(text);
  assert.deepEqual(ids, ["abc12345", "def67890"]);
});

test("parseCitedChunkIds returns empty for no citations", () => {
  const ids = parseCitedChunkIds("This text has no citations at all.");
  assert.deepEqual(ids, []);
});

test("parseCitedChunkIds handles collision-suffix IDs", () => {
  const text = "See [c.abc12345-1] and [c.abc12345-2] and original [c.abc12345].";
  const ids = parseCitedChunkIds(text);
  assert.deepEqual(ids, ["abc12345-1", "abc12345-2", "abc12345"]);
});

test("parseCitedChunkIds ignores legacy [p.N] markers", () => {
  const text = "Chunk [c.aabbccdd] and legacy [p.5] marker.";
  const ids = parseCitedChunkIds(text);
  assert.deepEqual(ids, ["aabbccdd"]);
});

test("parseCitedChunkIds normalizes uppercase hex to lowercase", () => {
  const text = "See [c.AABB1122] and [c.ccDD3344] mixed case.";
  const ids = parseCitedChunkIds(text);
  assert.deepEqual(ids, ["aabb1122", "ccdd3344"]);
});

// --- 7. Whitelist filtering ---
console.log("\n=== Whitelist Filtering Tests ===\n");

test("cited-chunk extraction filters against whitelist correctly", () => {
  // Use valid hex IDs (only [0-9a-f] characters, exactly 8 chars).
  const text = "See [c.aa11bb22] and [c.cc33dd44] and [c.ee55ff66].";
  const citedIds = parseCitedChunkIds(text);

  // Simulate a whitelist with only "aa11bb22" and "ee55ff66" (not "cc33dd44").
  const whitelist = new Map([
    ["aa11bb22", { pageStart: 1, pageEnd: 2, excerpt: "First chunk" }],
    ["ee55ff66", { pageStart: 5, pageEnd: 5, excerpt: "Third chunk" }],
  ]);

  const filtered = citedIds.filter((id) => whitelist.has(id));
  assert.deepEqual(filtered, ["aa11bb22", "ee55ff66"]);
});

test("whitelist filtering excludes all IDs when whitelist is empty", () => {
  const text = "See [c.abc12345] and [c.def67890].";
  const citedIds = parseCitedChunkIds(text);
  const whitelist = new Map<string, { pageStart: number; pageEnd: number; excerpt: string }>();
  const filtered = citedIds.filter((id) => whitelist.has(id));
  assert.deepEqual(filtered, []);
});

// --- 8. Regex pattern tests ---
console.log("\n=== Regex Pattern Tests ===\n");

test("makeChunkCiteRegex matches standard chunk IDs", () => {
  const re = makeChunkCiteRegex();
  const text = "Content [c.a1b2c3d4] here.";
  const match = re.exec(text);
  assert.ok(match, "should match");
  assert.equal(match![1], "a1b2c3d4");
});

test("makeChunkCiteRegex matches collision-suffix IDs", () => {
  const re = makeChunkCiteRegex();
  const text = "Content [c.a1b2c3d4-1] here.";
  const match = re.exec(text);
  assert.ok(match, "should match collision suffix");
  assert.equal(match![1], "a1b2c3d4-1");
});

test("makeChunkCiteRegex matches uppercase hex IDs", () => {
  const re = makeChunkCiteRegex();
  const text = "Content [c.A1B2C3D4] here.";
  const match = re.exec(text);
  assert.ok(match, "should match uppercase hex");
  assert.equal(match![1], "A1B2C3D4");
});

test("makeChunkCiteRegex does not match invalid IDs", () => {
  const re = makeChunkCiteRegex();
  // Too short (7 chars).
  assert.equal(re.exec("Content [c.a1b2c3d] here."), null);
  // Contains non-hex chars (g, h, i, j are outside a-f/A-F).
  re.lastIndex = 0;
  assert.equal(re.exec("Content [c.g1h2i3j4] here."), null);
});

test("fresh regex instances avoid lastIndex bugs", () => {
  const re1 = makeChunkCiteRegex();
  const text = "[c.aaaaaaaa] and [c.bbbbbbbb]";

  // Partially consume re1.
  re1.exec(text);
  assert.ok(re1.lastIndex > 0, "re1 should have advanced lastIndex");

  // Fresh instance should start from 0.
  const re2 = makeChunkCiteRegex();
  assert.equal(re2.lastIndex, 0, "fresh instance should start at 0");
  const match = re2.exec(text);
  assert.ok(match, "fresh instance should find first match");
  assert.equal(match![1], "aaaaaaaa");
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
