/**
 * Tests for prompt-prefix stability, cache breakpoints, and whole-paper mode.
 *
 * Runs standalone: `npx tsx test/caching.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * The property under test is the one the whole caching change rests on:
 * **the prompt prefix must be byte-identical across turns of a conversation
 * about the same paper.** Prompt caching is a prefix match, so a single
 * changed byte anywhere before the breakpoint invalidates everything after it
 * and the paper is re-billed at full price on every question — which is
 * exactly what the pre-0.3.0 design did, by recomputing the chunk selection
 * from the question each turn.
 *
 * @see docs/MODERNIZATION_PLAN_2026.md — §4
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Zotero global stubs — client.ts reads prefs at module scope via prefs.ts.
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

const { buildMessages, getSystemPrompt } = await import(
  "../src/modules/llm/client"
);
const { buildWholePaperContext } = await import("../src/modules/rag/pipeline");
const { AnthropicProvider } = await import(
  "../src/modules/llm/providers/anthropic"
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

const PAGES = [
  { page: 1, text: "Abstract. We study widgets." },
  { page: 2, text: "Introduction. Widgets matter because of reasons." },
  { page: 3, text: "Methods. We measured widgets with a ruler." },
];

/** The cacheable prefix: everything up to and including the last breakpoint. */
function cacheablePrefix(messages: any[]): string {
  const lastIdx = messages.reduce(
    (acc, m, i) => (m.cacheable ? i : acc),
    -1,
  );
  return JSON.stringify(messages.slice(0, lastIdx + 1));
}

/** Reaches the provider's private request builder for shape assertions. */
function buildAnthropicRequest(messages: any[]) {
  const provider: any = new AnthropicProvider("test-key");
  return provider.buildRequest(messages, { model: "claude-haiku-5-5" });
}

// ---------------------------------------------------------------------------
// Prefix stability — the core regression
// ---------------------------------------------------------------------------

console.log("\n=== Prompt-prefix stability ===\n");

test("the cacheable prefix is identical across different questions", () => {
  const ctx = buildWholePaperContext(PAGES);
  const a = buildMessages(ctx, "What did they measure?", [], "whole-paper");
  const b = buildMessages(ctx, "Why do widgets matter?", [], "whole-paper");
  assert.equal(cacheablePrefix(a), cacheablePrefix(b));
});

test("the cacheable prefix survives a growing conversation history", () => {
  const ctx = buildWholePaperContext(PAGES);
  const turn1 = buildMessages(ctx, "First question?", [], "whole-paper");
  const turn3 = buildMessages(
    ctx,
    "Third question?",
    [
      { role: "user", content: "First question?" },
      { role: "assistant", content: "First answer." },
      { role: "user", content: "Second question?" },
      { role: "assistant", content: "Second answer." },
    ],
    "whole-paper",
  );
  assert.equal(cacheablePrefix(turn1), cacheablePrefix(turn3));
});

test("history and question land after the last breakpoint", () => {
  const ctx = buildWholePaperContext(PAGES);
  const messages = buildMessages(
    ctx,
    "Volatile question text",
    [{ role: "user", content: "Earlier turn" }],
    "whole-paper",
  );
  const prefix = cacheablePrefix(messages);
  assert.ok(
    !prefix.includes("Volatile question text"),
    "the question must not be inside the cached prefix",
  );
  assert.ok(
    !prefix.includes("Earlier turn"),
    "history must not be inside the cached prefix",
  );
});

test("the document text IS inside the cached prefix", () => {
  const ctx = buildWholePaperContext(PAGES);
  const messages = buildMessages(ctx, "Question?", [], "whole-paper");
  assert.ok(cacheablePrefix(messages).includes("measured widgets with a ruler"));
});

test("the system prompt contains no per-request interpolation", () => {
  // A timestamp or id in the system prompt is the classic silent invalidator.
  for (const mode of ["whole-paper", "chunk-rag"] as const) {
    const prompt = getSystemPrompt(mode);
    assert.ok(
      !/\d{4}-\d{2}-\d{2}|\d{10,}/.test(prompt),
      `${mode} system prompt must not embed a date or epoch`,
    );
  }
});

// ---------------------------------------------------------------------------
// Breakpoint placement
// ---------------------------------------------------------------------------

console.log("\n=== Cache breakpoints ===\n");

test("system and document are the breakpoints, and nothing else is", () => {
  const messages = buildMessages(
    buildWholePaperContext(PAGES),
    "Question?",
    [{ role: "user", content: "Earlier" }],
    "whole-paper",
  );
  const flagged = messages.filter((m) => m.cacheable);
  assert.equal(flagged.length, 2);
  assert.equal(flagged[0]!.role, "system");
  assert.equal(flagged[1]!.role, "user");
  assert.ok(flagged[1]!.content.includes("<document>"));
});

test("breakpoint count stays within the 4-per-request API limit", () => {
  const messages = buildMessages(
    buildWholePaperContext(PAGES),
    "Question?",
    Array.from({ length: 10 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `turn ${i}`,
    })),
    "whole-paper",
  );
  assert.ok(messages.filter((m) => m.cacheable).length <= 4);
});

test("no document means no document breakpoint", () => {
  const messages = buildMessages("", "Question?", [], "chunk-rag");
  assert.equal(messages.filter((m) => m.cacheable).length, 1);
});

// ---------------------------------------------------------------------------
// Anthropic request shape
// ---------------------------------------------------------------------------

console.log("\n=== Anthropic cache_control shape ===\n");

test("cacheable messages carry cache_control; others stay plain strings", () => {
  const messages = buildMessages(
    buildWholePaperContext(PAGES),
    "Question?",
    [],
    "whole-paper",
  );
  const req: any = buildAnthropicRequest(messages);

  // System is an array of blocks, with the breakpoint.
  assert.ok(Array.isArray(req.system));
  assert.equal(req.system[0].cache_control.type, "ephemeral");

  // The document message is block-form with cache_control.
  const docMsg = req.messages.find(
    (m: any) => Array.isArray(m.content) && m.content[0]?.cache_control,
  );
  assert.ok(docMsg, "document message should carry a cache_control breakpoint");
  assert.ok(docMsg.content[0].text.includes("<document>"));

  // The volatile question stays a bare string — no breakpoint.
  const last = req.messages[req.messages.length - 1];
  assert.equal(typeof last.content, "string");
  assert.equal(last.content, "Question?");
});

test("the cache TTL is long enough for a reading session", () => {
  const messages = buildMessages("doc text", "Q?", [], "whole-paper");
  const req: any = buildAnthropicRequest(messages);
  // The 5-minute default expires between questions; 1h is what actually hits.
  assert.equal(req.system[0].cache_control.ttl, "1h");
});

test("max_tokens is no longer the truncating 4096 default", () => {
  const req: any = buildAnthropicRequest(
    buildMessages("doc", "Q?", [], "whole-paper"),
  );
  assert.ok(req.max_tokens >= 16_000, `max_tokens was ${req.max_tokens}`);
});

test("effort is omitted unless explicitly requested", () => {
  const provider: any = new AnthropicProvider("k");
  const without = provider.buildRequest([{ role: "user", content: "hi" }], {
    model: "claude-haiku-5-5",
  });
  assert.equal(without.output_config, undefined);

  const with_ = provider.buildRequest([{ role: "user", content: "hi" }], {
    model: "claude-haiku-5-5",
    effort: "low",
  });
  assert.equal(with_.output_config.effort, "low");
});

// ---------------------------------------------------------------------------
// Whole-paper context rendering
// ---------------------------------------------------------------------------

console.log("\n=== Whole-paper context ===\n");

test("every page gets a [p.N] marker", () => {
  const ctx = buildWholePaperContext(PAGES);
  assert.ok(ctx.includes("[p.1]"));
  assert.ok(ctx.includes("[p.2]"));
  assert.ok(ctx.includes("[p.3]"));
});

test("rendering is question-independent and deterministic", () => {
  assert.equal(buildWholePaperContext(PAGES), buildWholePaperContext(PAGES));
});

test("blank pages are dropped but numbering is preserved", () => {
  const ctx = buildWholePaperContext([
    { page: 1, text: "First." },
    { page: 2, text: "   " },
    { page: 3, text: "Third." },
  ]);
  assert.ok(!ctx.includes("[p.2]"), "blank page should not be emitted");
  assert.ok(ctx.includes("[p.3]"), "later pages keep their real numbers");
});

test("an empty document renders as empty, not as a stray marker", () => {
  assert.equal(buildWholePaperContext([]), "");
});

// ---------------------------------------------------------------------------
// Citation scheme per mode
// ---------------------------------------------------------------------------

console.log("\n=== Citation instructions per mode ===\n");

test("whole-paper mode asks for page citations", () => {
  const prompt = getSystemPrompt("whole-paper");
  assert.match(prompt, /\[p\.12\]/);
  assert.ok(!/\[c\./.test(prompt), "should not ask for chunk IDs");
});

test("chunk-rag mode asks for chunk citations", () => {
  const prompt = getSystemPrompt("chunk-rag");
  assert.match(prompt, /\[c\.a3f7c012\]/);
});

test("both modes keep the untrusted-data guardrail", () => {
  for (const mode of ["whole-paper", "chunk-rag"] as const) {
    assert.match(getSystemPrompt(mode), /UNTRUSTED USER DATA/, mode);
  }
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
