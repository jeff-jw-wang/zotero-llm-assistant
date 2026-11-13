/**
 * Tests for hybrid library retrieval, long-text embedding, and the
 * grounded-vs-recalled answer contract.
 *
 * Runs standalone: `npx tsx test/library-retrieval.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * Two regressions are guarded here.
 *
 * 1. **The keyword gate.** `searchLibrary()` used to keep only items with
 *    `score > 0` and let semantic similarity merely re-rank those survivors,
 *    so an item sharing no literal word with the query was eliminated before
 *    embeddings were consulted — defeating the purpose of semantic search.
 *    Fusion must let a semantic-only match outrank a keyword-only one.
 *
 * 2. **Silent embedding truncation.** Chunks target 2048 characters but
 *    all-MiniLM-L6-v2 accepts 256 tokens (~1024 chars), so roughly half of
 *    every chunk never reached the encoder. Long text must now be windowed and
 *    pooled rather than cut.
 *
 * @see docs/MODERNIZATION_PLAN_2026.md — §3.3, §7.2
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Zotero global stubs — libraryPanel reads config/prefs at module scope.
// ---------------------------------------------------------------------------

const mockPrefs: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string) {
      return mockPrefs[key];
    },
    set(key: string, value: any) {
      mockPrefs[key] = value;
    },
  },
};
(globalThis as any).ztoolkit = { log: () => {} };
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

const { fuseRankings, RRF_K, scoreItem } = await import(
  "../src/modules/library/searcher"
);
const { windowText, meanPool, cosineSimilarity } = await import(
  "../src/modules/rag/embedder"
);
const { splitGeneralKnowledge } = await import(
  "../src/modules/ui/libraryPanel"
);

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

const rank = (keys: string[]) => keys;

// ---------------------------------------------------------------------------
// Rank fusion — removing the keyword gate
// ---------------------------------------------------------------------------

console.log("\n=== Rank fusion (keyword gate removal) ===\n");

test("an item found only semantically still appears in results", () => {
  // This is the case the old keyword gate dropped entirely.
  const fused = fuseRankings([rank(["kw-only"]), rank(["sem-only"])]);
  const keys = fused.map((f) => f.key);
  assert.ok(keys.includes("sem-only"), "semantic-only item must survive fusion");
  assert.ok(keys.includes("kw-only"));
});

test("an item in both lists outranks items in only one", () => {
  const fused = fuseRankings([
    rank(["kw-only", "both"]),
    rank(["sem-only", "both"]),
  ]);
  assert.equal(fused[0]!.key, "both");
});

test("a top semantic hit outranks a mid-ranked keyword hit", () => {
  const fused = fuseRankings([
    rank(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "target-kw"]),
    rank(["target-sem"]),
  ]);
  const keys = fused.map((f) => f.key);
  assert.ok(
    keys.indexOf("target-sem") < keys.indexOf("target-kw"),
    "rank 1 semantically should beat rank 11 by keyword",
  );
});

test("rank order within a single list is preserved", () => {
  const fused = fuseRankings([rank(["first", "second", "third"])]);
  assert.deepEqual(
    fused.map((f) => f.key),
    ["first", "second", "third"],
  );
});

test("fusion scores follow the 1/(k+rank) formula", () => {
  const fused = fuseRankings([rank(["only"])]);
  assert.ok(Math.abs(fused[0]!.score - 1 / (RRF_K + 1)) < 1e-12);
});

test("an empty list contributes nothing and does not throw", () => {
  const fused = fuseRankings([rank([]), rank(["x"])]);
  assert.equal(fused.length, 1);
  assert.equal(fused[0]!.key, "x");
});

test("no lists at all yields no results", () => {
  assert.deepEqual(fuseRankings([]), []);
});

test("ties break deterministically, so result order is stable", () => {
  const a = fuseRankings([rank(["x"]), rank(["y"])]);
  const b = fuseRankings([rank(["x"]), rank(["y"])]);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// Keyword scoring still behaves (now a contributor, not a gate)
// ---------------------------------------------------------------------------

console.log("\n=== Keyword scoring as a contributor ===\n");

const META = {
  itemId: 1,
  key: "ABC",
  title: "Deep Learning for Widgets",
  authors: "Smith, Jones",
  year: "2023",
  abstract: "We apply neural networks to widget manufacturing.",
  tags: ["ml"],
  doi: "",
  itemType: "journalArticle",
};

test("a title match still scores highest among field matches", () => {
  assert.ok(scoreItem(META, ["widgets"]) > scoreItem(META, ["neural"]));
});

test("a conceptually related but literally absent term scores zero", () => {
  // Precisely why this cannot be a gate: the paper IS about this.
  assert.equal(scoreItem(META, ["transformer"]), 0);
});

// ---------------------------------------------------------------------------
// Long-text embedding — the truncation fix
// ---------------------------------------------------------------------------

console.log("\n=== Long-text windowing ===\n");

test("short text yields exactly one window", () => {
  assert.deepEqual(windowText("short text"), ["short text"]);
});

test("a full-size chunk is split rather than truncated", () => {
  // chunker.ts targets 2048 chars; MiniLM accepts ~1024.
  const chunk = "x".repeat(2048);
  const windows = windowText(chunk);
  assert.ok(windows.length > 1, "a 2048-char chunk must produce >1 window");
});

test("windowing covers the entire input, including the tail", () => {
  const text = "A".repeat(1500) + "DISTINCTIVE_TAIL";
  const windows = windowText(text);
  assert.ok(
    windows.some((w) => w.includes("DISTINCTIVE_TAIL")),
    "the end of the text must appear in some window",
  );
});

test("windows overlap, so boundary sentences stay intact somewhere", () => {
  const windows = windowText("y".repeat(2000));
  const total = windows.reduce((n, w) => n + w.length, 0);
  assert.ok(total > 2000, "overlap means windows sum to more than the input");
});

test("every window fits the model's input limit", () => {
  for (const w of windowText("z".repeat(5000))) {
    assert.ok(w.length <= 900, `window of ${w.length} chars exceeds the limit`);
  }
});

// ---------------------------------------------------------------------------
// Mean pooling
// ---------------------------------------------------------------------------

console.log("\n=== Mean pooling ===\n");

test("a single vector passes through unchanged", () => {
  const v = [0.6, 0.8];
  assert.deepEqual(meanPool([v]), v);
});

test("pooled vectors are L2-normalised", () => {
  // Callers and cosineSimilarity assume unit vectors; the mean of unit
  // vectors is not itself a unit vector, so pooling must re-normalise.
  const pooled = meanPool([
    [1, 0, 0],
    [0, 1, 0],
  ]);
  const norm = Math.sqrt(pooled.reduce((n, x) => n + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `norm was ${norm}`);
});

test("pooling averages direction", () => {
  const pooled = meanPool([
    [1, 0],
    [0, 1],
  ]);
  assert.ok(Math.abs(pooled[0]! - pooled[1]!) < 1e-9);
});

test("identical vectors pool to themselves", () => {
  const v = [0.6, 0.8];
  const pooled = meanPool([v, v]);
  assert.ok(cosineSimilarity(pooled, v) > 0.999999);
});

test("opposing vectors pool without producing NaN", () => {
  const pooled = meanPool([
    [1, 0],
    [-1, 0],
  ]);
  assert.ok(pooled.every((x) => Number.isFinite(x)), "no NaN from zero norm");
});

test("an empty input yields an empty vector", () => {
  assert.deepEqual(meanPool([]), []);
});

// ---------------------------------------------------------------------------
// Grounded vs recalled answer contract
// ---------------------------------------------------------------------------

console.log("\n=== Grounded vs recalled separation ===\n");

test("a response with no heading is treated as entirely grounded", () => {
  const { grounded, recalled } = splitGeneralKnowledge("Just metadata facts.");
  assert.equal(grounded, "Just metadata facts.");
  assert.equal(recalled, "");
});

test("content after the heading is separated out", () => {
  const { grounded, recalled } = splitGeneralKnowledge(
    "You have Smith 2023.\n\n## From general knowledge\n\nIt used a GAN.",
  );
  assert.equal(grounded, "You have Smith 2023.");
  assert.equal(recalled, "It used a GAN.");
});

test("the heading text itself does not leak into either part", () => {
  const { grounded, recalled } = splitGeneralKnowledge(
    "Grounded.\n## From general knowledge (unverified)\nRecalled.",
  );
  assert.ok(!grounded.includes("general knowledge"));
  assert.ok(!recalled.includes("general knowledge"));
  assert.equal(recalled, "Recalled.");
});

test("a recalled-only answer still separates correctly", () => {
  const { grounded, recalled } = splitGeneralKnowledge(
    "## From general knowledge\nAll from memory.",
  );
  assert.equal(grounded, "");
  assert.equal(recalled, "All from memory.");
});

test("item links in the recalled section are preserved for whitelisting", () => {
  const { recalled } = splitGeneralKnowledge(
    "G.\n## From general knowledge\nSee zotero://select/library/items/ABCD1234",
  );
  assert.ok(recalled.includes("zotero://select/library/items/ABCD1234"));
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
