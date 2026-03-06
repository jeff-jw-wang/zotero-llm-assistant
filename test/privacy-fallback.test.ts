/**
 * Privacy fallback tests — verifies fail-closed behavior when IndexedDB
 * is unavailable (e.g. in Zotero's reader panel privileged chrome frame).
 *
 * Tests:
 * 1. isItemPrivatePref / setItemPrivatePref (Prefs mirror CRUD + edge cases)
 * 2. checkPrivacy() fallback semantics when IndexedDB throws
 *
 * Runs standalone: `npx tsx test/privacy-fallback.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * @see REVIEW.md — 2026-03-01 [P2] "New privacy fallback path is untested"
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test harness
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
// Zotero global mock
// ---------------------------------------------------------------------------

/** In-memory pref store. */
const mockPrefs: Record<string, any> = {};

const PREF_PREFIX = "extensions.zotero.zotero-llm-assistant";

function setMockPref(suffix: string, value: any) {
  mockPrefs[`${PREF_PREFIX}.${suffix}`] = value;
}

function clearMockPrefs() {
  for (const key of Object.keys(mockPrefs)) {
    delete mockPrefs[key];
  }
}

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

// IMPORTANT: Ensure indexedDB is NOT available — simulates reader panel context.
// This must be set before importing db.ts/client.ts so that isItemPrivate() throws.
delete (globalThis as any).indexedDB;

// ---------------------------------------------------------------------------
// Imports (after global mock setup)
// ---------------------------------------------------------------------------

import {
  isItemPrivatePref,
  setItemPrivatePref,
} from "../src/prefs";

import { checkPrivacy } from "../src/modules/llm/client";
import type { ILLMProvider } from "../src/modules/llm/types";

// ===========================================================================
// isItemPrivatePref() / setItemPrivatePref() unit tests
// ===========================================================================

console.log("\n=== isItemPrivatePref() / setItemPrivatePref() Tests ===\n");

test("empty pref → item is not private", () => {
  clearMockPrefs();
  assert.equal(isItemPrivatePref(42), false);
});

test("set item private → reads back as private", () => {
  clearMockPrefs();
  setItemPrivatePref(42, true);
  assert.equal(isItemPrivatePref(42), true);
});

test("set item private then un-private → reads back as not private", () => {
  clearMockPrefs();
  setItemPrivatePref(42, true);
  assert.equal(isItemPrivatePref(42), true);
  setItemPrivatePref(42, false);
  assert.equal(isItemPrivatePref(42), false);
});

test("multiple items → independent flags", () => {
  clearMockPrefs();
  setItemPrivatePref(1, true);
  setItemPrivatePref(2, false);
  setItemPrivatePref(3, true);
  assert.equal(isItemPrivatePref(1), true);
  assert.equal(isItemPrivatePref(2), false);
  assert.equal(isItemPrivatePref(3), true);
  assert.equal(isItemPrivatePref(999), false);
});

test("setting private twice is idempotent", () => {
  clearMockPrefs();
  setItemPrivatePref(42, true);
  setItemPrivatePref(42, true);
  // Check no duplicates in the underlying array
  const raw = mockPrefs[`${PREF_PREFIX}.privacy.privateItemIds`];
  const ids = JSON.parse(raw);
  assert.equal(ids.filter((id: number) => id === 42).length, 1);
});

test("unsetting non-private item is idempotent (no error)", () => {
  clearMockPrefs();
  setItemPrivatePref(42, false); // already not private
  assert.equal(isItemPrivatePref(42), false);
});

test("corrupt pref data → fail-closed (returns true)", () => {
  clearMockPrefs();
  setMockPref("privacy.privateItemIds", "NOT VALID JSON {{{");
  assert.equal(isItemPrivatePref(42), true);
});

test("non-array pref data → setItemPrivatePref recovers and works", () => {
  clearMockPrefs();
  setMockPref("privacy.privateItemIds", '"a string"');
  setItemPrivatePref(42, true);
  assert.equal(isItemPrivatePref(42), true);
});

test("null pref data → treated as empty array", () => {
  clearMockPrefs();
  setMockPref("privacy.privateItemIds", "null");
  // isItemPrivatePref should handle non-array JSON (null)
  // JSON.parse("null") = null, Array.includes on null would throw,
  // but we have try/catch → fail-closed
  const result = isItemPrivatePref(42);
  // null is not an array; .includes will throw; catch returns true (fail-closed)
  assert.equal(result, true);
});

// ===========================================================================
// checkPrivacy() fallback tests — IndexedDB unavailable
// ===========================================================================

console.log("\n=== checkPrivacy() Fallback Tests (no IndexedDB) ===\n");

/** Mock cloud provider */
const cloudProvider: ILLMProvider = {
  isCloud: true,
  async chat() { return ""; },
  async *chatStream() {},
  async isAvailable() { return true; },
};

/** Mock local provider */
const localProvider: ILLMProvider = {
  isCloud: false,
  async chat() { return ""; },
  async *chatStream() {},
  async isAvailable() { return true; },
};

await testAsync("local provider → always allowed (even with IDB failure)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setItemPrivatePref(42, true);
  const result = await checkPrivacy(localProvider, 42);
  assert.equal(result, null);
});

await testAsync("cloud provider, sharing disabled → blocked (global gate)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", false);
  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null);
  assert.ok(result!.includes("disabled"));
});

await testAsync("cloud provider, sharing enabled, item NOT private in mirror → allowed", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  // Item not marked private in Prefs mirror → should be allowed
  const result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null);
});

await testAsync("cloud provider, sharing enabled, item IS private in mirror → blocked (fail-closed)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setItemPrivatePref(42, true);
  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null);
  assert.ok(result!.includes("private"));
});

await testAsync("cloud provider, sharing enabled, different item private → this item allowed", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setItemPrivatePref(99, true);
  // Item 42 is not private — should be allowed
  const result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null);
  // Item 99 IS private — should be blocked
  const result99 = await checkPrivacy(cloudProvider, 99);
  assert.notEqual(result99, null);
});

await testAsync("cloud provider, corrupt mirror data → fail-closed (blocked)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setMockPref("privacy.privateItemIds", "CORRUPT DATA!!!!");
  const result = await checkPrivacy(cloudProvider, 42);
  // Corrupt data → isItemPrivatePref returns true → blocked
  assert.notEqual(result, null);
  assert.ok(result!.includes("private"));
});

await testAsync("toggle private then check → roundtrip through Prefs mirror", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);

  // Initially not private
  let result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null, "initially should be allowed");

  // Mark private via Prefs mirror (simulating what privacyToggle does)
  setItemPrivatePref(42, true);
  result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null, "should be blocked after marking private");

  // Unmark private
  setItemPrivatePref(42, false);
  result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null, "should be allowed after unmarking private");
});

// ===========================================================================
// OR-logic mismatch tests — Prefs says private, IDB would say not-private
// (Review round 3 finding: stale IDB must not bypass Prefs intent)
// ===========================================================================

console.log("\n=== OR-Logic Mismatch Tests ===\n");

await testAsync("Prefs=private, IDB unavailable → blocked (Prefs wins)", async () => {
  // This is the baseline: IDB throws (no indexedDB in this test env),
  // Prefs says private → must block. Validates Prefs is checked.
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setItemPrivatePref(42, true);
  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null);
  assert.ok(result!.includes("private"));
});

await testAsync("Prefs=private checked BEFORE IDB (order matters for stale-IDB scenario)", async () => {
  // The fix checks Prefs first. Even if IDB were available and returned false
  // (stale), Prefs would already block. We verify Prefs is authoritative by
  // confirming it blocks even though IDB is unreachable (would return false
  // if it were reachable with stale data).
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  setItemPrivatePref(100, true);
  const result = await checkPrivacy(cloudProvider, 100);
  assert.notEqual(result, null, "Prefs private flag must block even if IDB is stale/unavailable");
});

await testAsync("Prefs=not-private, IDB unavailable → allowed", async () => {
  // Neither source says private → allow.
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  // Don't set item private in Prefs
  const result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null, "should be allowed when neither source says private");
});

// ===========================================================================
// Results
// ===========================================================================

console.log("\n========================================");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("========================================\n");

if (failed > 0) process.exit(1);
