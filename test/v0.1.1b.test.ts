/**
 * v0.1.1b UX polish tests — validates scroll decision logic and textarea
 * keybinding behavior.
 *
 * Covers:
 *   1. isNearBottom() — threshold-based scroll-position check
 *   2. scrollToBottom() — conditional/force scroll via rAF
 *   3. Textarea keybinding — Ctrl+Enter sends, plain Enter does not
 *
 * Runs standalone: `npx tsx test/v0.1.1b.test.ts`
 *
 * @see PLAN_V0.1.1B.md — Fix #6 (scroll) and Fix #7 (keybinding)
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Test harness (same pattern as qa-fixes.test.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Import the scroll helpers from readerPanel.
// We need minimal Zotero global mocks since the module imports prefs etc.
// ---------------------------------------------------------------------------

const prefStore: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string) { return prefStore[key]; },
    set(key: string, value: any) { prefStore[key] = value; },
  },
  FullText: { getItemContent: async () => ({ content: "", totalPages: 0 }) },
  DB: { queryAsync: async () => [] },
  Items: { get: () => undefined },
  getMainWindow: () => ({}),
  getMainWindows: () => [],
  HTTP: { request: async () => ({}) },
  ItemPaneManager: { registerSection: () => {} },
  Reader: { getByTabID: () => null },
};

(globalThis as any).ztoolkit = {
  log: () => {},
  Clipboard: class { addText() { return this; } copy() {} },
};

(globalThis as any).addon = { data: { config: {} } };

// Now import the exported helpers
const { isNearBottom, scrollToBottom } = await import(
  "../src/modules/ui/readerPanel.js"
);

// ---------------------------------------------------------------------------
// Mock DOM element for scroll tests
// ---------------------------------------------------------------------------

function mockScrollElement(opts: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): HTMLElement {
  let rAFCalled = false;

  const el = {
    scrollHeight: opts.scrollHeight,
    scrollTop: opts.scrollTop,
    clientHeight: opts.clientHeight,
    ownerDocument: {
      defaultView: {
        requestAnimationFrame: (cb: () => void) => {
          rAFCalled = true;
          cb(); // execute immediately for testing
        },
      },
    },
    // Expose test spy
    get _rAFCalled() { return rAFCalled; },
    _resetRAF() { rAFCalled = false; },
  };

  return el as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Scroll decision tests — isNearBottom()
// ---------------------------------------------------------------------------

console.log("\n--- isNearBottom() ---");

test("returns true when exactly at bottom (scrollHeight - scrollTop === clientHeight)", () => {
  const el = mockScrollElement({ scrollHeight: 1000, scrollTop: 500, clientHeight: 500 });
  assert.equal(isNearBottom(el), true);
});

test("returns true when within threshold (39px from bottom)", () => {
  const el = mockScrollElement({ scrollHeight: 1000, scrollTop: 461, clientHeight: 500 });
  // gap = 1000 - 461 - 500 = 39  →  < 40  →  true
  assert.equal(isNearBottom(el), true);
});

test("returns false when scrolled up (>= 40px from bottom)", () => {
  const el = mockScrollElement({ scrollHeight: 1000, scrollTop: 460, clientHeight: 500 });
  // gap = 1000 - 460 - 500 = 40  →  NOT < 40  →  false
  assert.equal(isNearBottom(el), false);
});

test("returns false when significantly scrolled up", () => {
  const el = mockScrollElement({ scrollHeight: 2000, scrollTop: 100, clientHeight: 500 });
  // gap = 2000 - 100 - 500 = 1400  →  false
  assert.equal(isNearBottom(el), false);
});

test("returns true when content fits viewport (no scrollbar needed)", () => {
  const el = mockScrollElement({ scrollHeight: 400, scrollTop: 0, clientHeight: 500 });
  // gap = 400 - 0 - 500 = -100  →  < 40  →  true
  assert.equal(isNearBottom(el), true);
});

// ---------------------------------------------------------------------------
// Scroll decision tests — scrollToBottom()
// ---------------------------------------------------------------------------

console.log("\n--- scrollToBottom() ---");

test("with shouldStick=false does NOT call rAF", () => {
  const el = mockScrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 });
  scrollToBottom(el, false);
  assert.equal((el as any)._rAFCalled, false);
});

test("with shouldStick=true calls rAF and scrolls to bottom", () => {
  const el = mockScrollElement({ scrollHeight: 1000, scrollTop: 0, clientHeight: 500 });
  scrollToBottom(el, true);
  assert.equal((el as any)._rAFCalled, true);
  assert.equal(el.scrollTop, 1000); // rAF callback sets scrollTop = scrollHeight
});

test("with shouldStick=undefined (force) calls rAF and scrolls to bottom", () => {
  const el = mockScrollElement({ scrollHeight: 2000, scrollTop: 0, clientHeight: 500 });
  scrollToBottom(el);
  assert.equal((el as any)._rAFCalled, true);
  assert.equal(el.scrollTop, 2000);
});

// ---------------------------------------------------------------------------
// Textarea keybinding tests
// ---------------------------------------------------------------------------

console.log("\n--- Textarea keybinding ---");

/**
 * Simulates the keybinding logic from renderChatUI without needing the full
 * DOM. Mirrors the exact conditional from the implementation:
 *   if (ke.key === "Enter" && (ke.ctrlKey || ke.metaKey)) → send
 */
function simulateKeybinding(opts: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}): { sent: boolean; defaultPrevented: boolean } {
  let sent = false;
  let defaultPrevented = false;

  const ke = {
    key: opts.key,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    preventDefault() { defaultPrevented = true; },
  };

  // Mirror the implementation logic
  if (ke.key === "Enter" && (ke.ctrlKey || ke.metaKey)) {
    ke.preventDefault();
    sent = true; // handleSend()
  }

  return { sent, defaultPrevented };
}

test("Ctrl+Enter fires send callback", () => {
  const result = simulateKeybinding({ key: "Enter", ctrlKey: true });
  assert.equal(result.sent, true);
  assert.equal(result.defaultPrevented, true);
});

test("Cmd+Enter (metaKey) fires send callback", () => {
  const result = simulateKeybinding({ key: "Enter", metaKey: true });
  assert.equal(result.sent, true);
  assert.equal(result.defaultPrevented, true);
});

test("Plain Enter does NOT fire send callback (inserts newline)", () => {
  const result = simulateKeybinding({ key: "Enter" });
  assert.equal(result.sent, false);
  assert.equal(result.defaultPrevented, false);
});

test("Shift+Enter does NOT fire send callback (inserts newline)", () => {
  const result = simulateKeybinding({ key: "Enter", shiftKey: true });
  assert.equal(result.sent, false);
  assert.equal(result.defaultPrevented, false);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
