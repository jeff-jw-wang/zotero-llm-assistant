/**
 * Privacy OR-logic mismatch tests — validates that checkPrivacy() blocks
 * when EITHER IndexedDB or Prefs says private, even when they disagree.
 *
 * Unlike privacy-fallback.test.ts (which deletes indexedDB entirely), this
 * file provides a minimal fake IndexedDB so isItemPrivate() succeeds with
 * controlled return values. This directly tests the stale-IDB scenario:
 *   - IDB returns false (stale), Prefs returns true → must block
 *   - IDB returns true, Prefs returns false → must block
 *
 * Runs standalone: `npx tsx test/privacy-mismatch.test.ts`
 *
 * @see REVIEW.md — round 4 [P2] "OR-logic mismatch tests do not validate
 *   the claimed stale-IDB scenario"
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

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

const mockPrefs: Record<string, any> = {};
const PREF_PREFIX = "extensions.zotero.zotero-llm-assistant";

function setMockPref(suffix: string, value: any) {
  mockPrefs[`${PREF_PREFIX}.${suffix}`] = value;
}

function clearMockPrefs() {
  for (const key of Object.keys(mockPrefs)) delete mockPrefs[key];
}

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string, _global?: boolean) { return mockPrefs[key]; },
    set(key: string, value: any, _global?: boolean) { mockPrefs[key] = value; },
  },
};

(globalThis as any).ztoolkit = { log: () => {} };
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

// ---------------------------------------------------------------------------
// Fake IndexedDB — minimal mock that makes isItemPrivate() succeed
// ---------------------------------------------------------------------------

/**
 * Controlled privacy store: itemId → isPrivate.
 * Set values here before calling checkPrivacy() to simulate stale/fresh IDB.
 */
const fakePrivacyStore: Map<number, boolean> = new Map();

/**
 * Minimal mock for IDBObjectStore.get() — returns a PrivacyRecord-like object
 * from fakePrivacyStore, or undefined if not present (meaning "not private").
 */
function makeFakeIDB() {
  const fakeRequest = (result: any) => {
    const req: any = { result };
    // Simulate async success via microtask.
    Promise.resolve().then(() => {
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  };

  const fakeStore = {
    get(key: number) {
      const isPrivate = fakePrivacyStore.get(key) ?? false;
      return fakeRequest({ itemId: key, isPrivate });
    },
    put(record: any) {
      fakePrivacyStore.set(record.itemId, record.isPrivate);
      return fakeRequest(undefined);
    },
  };

  const fakeTx = {
    objectStore(_name: string) { return fakeStore; },
  };

  const fakeDB = {
    transaction(_stores: string | string[], _mode?: string) { return fakeTx; },
    objectStoreNames: { contains: () => true },
  };

  // Mock IDBFactory.open() — returns the fakeDB immediately.
  const fakeOpenRequest: any = {};

  const fakeIDBFactory = {
    open(_name: string, _version?: number) {
      Promise.resolve().then(() => {
        fakeOpenRequest.result = fakeDB;
        if (fakeOpenRequest.onsuccess) fakeOpenRequest.onsuccess({ target: fakeOpenRequest });
      });
      return fakeOpenRequest;
    },
  };

  return fakeIDBFactory;
}

// Install fake IndexedDB BEFORE importing db.ts/client.ts.
(globalThis as any).indexedDB = makeFakeIDB();

// ---------------------------------------------------------------------------
// Imports (after mock setup — so db.ts sees indexedDB as available)
// ---------------------------------------------------------------------------

import { isItemPrivatePref, setItemPrivatePref } from "../src/prefs";
import { checkPrivacy } from "../src/modules/llm/client";
import type { ILLMProvider } from "../src/modules/llm/types";

// Also grab isItemPrivate to verify our mock actually works.
import { isItemPrivate } from "../src/modules/storage/db";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const cloudProvider: ILLMProvider = {
  isCloud: true,
  async chat() { return ""; },
  async *chatStream() {},
  async isAvailable() { return true; },
};

// ===========================================================================
// Verify fake IDB actually works
// ===========================================================================

console.log("\n=== Fake IDB Sanity Checks ===\n");

await testAsync("isItemPrivate() returns false for unknown item", async () => {
  fakePrivacyStore.clear();
  const result = await isItemPrivate(777);
  assert.equal(result, false);
});

await testAsync("isItemPrivate() returns true for item set private in fake IDB", async () => {
  fakePrivacyStore.clear();
  fakePrivacyStore.set(42, true);
  const result = await isItemPrivate(42);
  assert.equal(result, true);
});

// ===========================================================================
// Stale-IDB mismatch tests
// ===========================================================================

console.log("\n=== Stale-IDB Mismatch Tests (OR-logic) ===\n");

await testAsync("IDB=false (stale), Prefs=true → BLOCKED (Prefs wins)", async () => {
  // User toggled private → Prefs updated → IDB write failed → IDB still says false.
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  fakePrivacyStore.clear();
  fakePrivacyStore.set(42, false); // IDB: stale, says NOT private
  setItemPrivatePref(42, true);    // Prefs: says IS private (latest intent)

  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null, "must block: Prefs says private even though IDB says not");
  assert.ok(result!.includes("private"));
});

await testAsync("IDB=true, Prefs=false → BLOCKED (IDB wins)", async () => {
  // Edge case: IDB has privacy flag from a previous session, Prefs mirror was
  // somehow cleared (e.g. pref reset). OR-logic means we still block.
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  fakePrivacyStore.clear();
  fakePrivacyStore.set(42, true);  // IDB: says IS private
  setItemPrivatePref(42, false);   // Prefs: says NOT private

  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null, "must block: IDB says private even though Prefs says not");
  assert.ok(result!.includes("private"));
});

await testAsync("IDB=false, Prefs=false → ALLOWED (neither says private)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  fakePrivacyStore.clear();
  fakePrivacyStore.set(42, false);
  // Prefs: not set → defaults to false

  const result = await checkPrivacy(cloudProvider, 42);
  assert.equal(result, null, "should be allowed when both sources say not private");
});

await testAsync("IDB=true, Prefs=true → BLOCKED (both agree)", async () => {
  clearMockPrefs();
  setMockPref("privacy.cloudSharingEnabled", true);
  fakePrivacyStore.clear();
  fakePrivacyStore.set(42, true);
  setItemPrivatePref(42, true);

  const result = await checkPrivacy(cloudProvider, 42);
  assert.notEqual(result, null, "must block: both sources agree item is private");
});

// ===========================================================================
// Results
// ===========================================================================

console.log("\n========================================");
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log("========================================\n");

if (failed > 0) process.exit(1);
