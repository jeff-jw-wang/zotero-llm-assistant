/**
 * Tests for prompt planning and context assembly (plan defects D5, D6, D7 and
 * the context policy in docs/MODERNIZATION_PLAN_2026.md §5.2).
 *
 * Runs standalone: `npx tsx test/budget.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * The properties under test:
 *
 *   1. **The prompt fits.** For the default Ollama settings, with six history
 *      messages present, the assembled prompt plus the reply reserve stays
 *      inside the context size — including the tokenizer margin.
 *   2. **Cost is bounded.** Two limits, independent of the model's window, cap
 *      the whole-paper size and the retrieved-context size.
 *   3. **The prefix is stable in retrieval mode.** The core of sections is
 *      chosen once; later questions change only the supplement, which sits
 *      outside the cacheable prefix.
 */

import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Zotero global stubs — pipeline.ts pulls in modules that read prefs.
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

const {
  planPrompt,
  tokenizerFactor,
  fitHistory,
  promptTokens,
  DEFAULT_CLOUD_WHOLE_PAPER_MAX,
  DEFAULT_CLOUD_RETRIEVED_MAX,
  LOCAL_DOCUMENT_SHARE,
} = await import("../src/modules/llm/budget");
const { resolveInputBudget, DEFAULT_OUTPUT_RESERVE } = await import(
  "../src/modules/llm/models"
);
const { assembleContext, buildWholePaperContext } = await import(
  "../src/modules/rag/pipeline"
);
const { chunkPages } = await import("../src/modules/rag/chunker");
const { estimateTokens } = await import("../src/utils/tokens");
const { describeSelection, describeDroppedHistory } = await import(
  "../src/modules/rag/notes"
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

const OLLAMA_NUM_CTX = 16_384;

/** The plan for a provider/model exactly as the request path derives it. */
function planFor(
  provider: any,
  modelId: string,
  window: number,
  opts: { numCtx?: number; whole?: number; retrieved?: number } = {},
) {
  const resolved = resolveInputBudget(provider, modelId, window, opts.numCtx);
  const plan = planPrompt({
    provider,
    modelId,
    inputBudget: resolved.budget,
    localNumCtx: opts.numCtx,
    wholePaperLimit: opts.whole,
    retrievedLimit: opts.retrieved,
  });
  return { plan, resolved };
}

/**
 * A synthetic paper. Each page has its own made-up keyword so a question can
 * target one page, and enough filler to be several hundred tokens long.
 */
function makePages(count: number, charsPerPage = 2400) {
  const pages = [];
  for (let i = 1; i <= count; i++) {
    const head = `Section ${i} discusses keyword${i}x in detail. `;
    const filler = `Finding ${i} holds under the stated conditions and keyword${i}x applies. `;
    let text = head;
    while (text.length < charsPerPage) text += filler;
    pages.push({ page: i, text: text.slice(0, charsPerPage) });
  }
  return pages;
}

function paper(count: number, charsPerPage?: number) {
  const pages = makePages(count, charsPerPage);
  return { pages, chunks: chunkPages(pages, "TESTKEY"), totalPages: count };
}

/** `n` alternating user/assistant messages of `chars` characters each. */
function makeHistory(n: number, chars: number) {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `turn ${i} `.padEnd(chars, "h"),
  }));
}

/** The cacheable prefix: everything up to and including the last breakpoint. */
function cacheablePrefix(messages: any[]): string {
  const lastIdx = messages.reduce((acc, m, i) => (m.cacheable ? i : acc), -1);
  return JSON.stringify(messages.slice(0, lastIdx + 1));
}

/** Real tokens the request may need: prompt (with margin) plus the reply. */
function worstCaseRealTokens(result: any, plan: any, window: number): number {
  const reserve = Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(window / 4));
  return Math.ceil(result.stats.promptTokens * plan.factor) + reserve;
}

// ---------------------------------------------------------------------------
// Tokenizer margin (D7)
// ---------------------------------------------------------------------------

console.log("\n=== Tokenizer margin (D7) ===\n");

test("Claude models get a 1.35 factor; everything else at least 1.15", () => {
  assert.equal(tokenizerFactor("anthropic", "claude-haiku-5-5"), 1.35);
  assert.equal(tokenizerFactor("anthropic", "some-future-model"), 1.35);
  assert.equal(tokenizerFactor("custom", "claude-sonnet-5-5"), 1.35);
  assert.equal(tokenizerFactor("ollama", "qwen3.5:4b"), 1.15);
  assert.equal(tokenizerFactor("openai", "gpt-6-luna"), 1.15);
  assert.equal(tokenizerFactor("gemini", "gemini-flash-latest"), 1.15);
});

test("a full Haiku 5.5 prompt stays under the 100K price band in real tokens", () => {
  const { plan } = planFor("anthropic", "claude-haiku-5-5", 1_000_000);
  // The most estimated tokens the plan will ever allow, converted to real.
  assert.ok(
    plan.promptCapacity * plan.factor <= 100_000,
    `capacity ${plan.promptCapacity} est → ${plan.promptCapacity * plan.factor} real`,
  );
  // The old logic allowed 92K *estimated*, i.e. ~124K real.
  assert.ok(plan.promptCapacity < 92_000);
});

// ---------------------------------------------------------------------------
// Limits (D6)
// ---------------------------------------------------------------------------

console.log("\n=== Context limits independent of the window (D6) ===\n");

test("a 1M-token cloud model is held to the default limits, not to its window", () => {
  const { plan } = planFor("anthropic", "claude-sonnet-5-5", 1_000_000);
  assert.equal(plan.wholePaperMax, DEFAULT_CLOUD_WHOLE_PAPER_MAX);
  assert.equal(plan.retrievedMax, DEFAULT_CLOUD_RETRIEVED_MAX);
  assert.equal(plan.coreMax + plan.supplementMax, plan.retrievedMax);
});

test("Ollama defaults are a share of the context size", () => {
  const { plan } = planFor("ollama", "qwen3.5:4b", 262_144, {
    numCtx: OLLAMA_NUM_CTX,
  });
  const expected = Math.floor(OLLAMA_NUM_CTX * LOCAL_DOCUMENT_SHARE);
  assert.equal(plan.wholePaperMax, expected);
  assert.equal(plan.retrievedMax, expected);
});

test("the model's advertised 256K window does not enlarge a local plan", () => {
  const small = planFor("ollama", "m", 32_768, { numCtx: OLLAMA_NUM_CTX }).plan;
  const huge = planFor("ollama", "m", 262_144, { numCtx: OLLAMA_NUM_CTX }).plan;
  assert.deepEqual(small, huge);
});

test("the user's settings override the defaults", () => {
  const { plan } = planFor("openai", "gpt-6-luna", 400_000, {
    whole: 30_000,
    retrieved: 10_000,
  });
  assert.equal(plan.wholePaperMax, 30_000);
  assert.equal(plan.retrievedMax, 10_000);
});

test("a setting of 0 means automatic", () => {
  const auto = planFor("openai", "gpt-6-luna", 400_000).plan;
  const zero = planFor("openai", "gpt-6-luna", 400_000, { whole: 0, retrieved: 0 }).plan;
  assert.deepEqual(auto, zero);
});

test("a setting larger than the model can hold is clamped, leaving room to talk", () => {
  const { plan } = planFor("ollama", "m", 262_144, {
    numCtx: OLLAMA_NUM_CTX,
    whole: 500_000,
    retrieved: 500_000,
  });
  assert.ok(plan.wholePaperMax < plan.promptCapacity);
  assert.ok(plan.retrievedMax < plan.promptCapacity);
  assert.ok(plan.promptCapacity - plan.wholePaperMax >= 1_000);
});

test("whole-paper boundary: at the limit is sent whole, one token over is not", () => {
  const { pages, chunks, totalPages } = paper(12);
  const exact = estimateTokens(buildWholePaperContext(pages));

  const at = planFor("anthropic", "claude-sonnet-5-5", 1_000_000, { whole: exact }).plan;
  const over = planFor("anthropic", "claude-sonnet-5-5", 1_000_000, { whole: exact - 1 }).plan;

  const base = { pages, chunks, totalPages, question: "What is keyword3x about", history: [] };
  assert.equal(assembleContext({ ...base, plan: at }).mode, "whole-paper");
  assert.equal(assembleContext({ ...base, plan: over }).mode, "chunk-rag");
});

test("retrieved-context boundary: core plus supplement never exceed the limit", () => {
  const { pages, chunks, totalPages } = paper(200);
  for (const retrieved of [2_000, 6_000, 24_000]) {
    const { plan } = planFor("anthropic", "claude-sonnet-5-5", 1_000_000, {
      whole: 1_000,
      retrieved,
    });
    const result = assembleContext({
      pages,
      chunks,
      totalPages,
      question: "Explain keyword150x and keyword151x and keyword152x",
      history: [],
      plan,
    });
    assert.equal(result.mode, "chunk-rag");
    const sent =
      result.stats.contextTokens +
      (estimateTokens(result.messages.at(-1)!.content) -
        estimateTokens("Explain keyword150x and keyword151x and keyword152x"));
    assert.ok(sent <= retrieved, `limit ${retrieved}, sent ${sent}`);
    assert.ok(result.stats.contextTokens <= plan.coreMax);
  }
});

test("a 400-page document on a 1M model sends ~24K tokens, not ~990K", () => {
  const { pages, chunks, totalPages } = paper(400);
  const { plan } = planFor("anthropic", "claude-sonnet-5-5", 1_000_000);
  const result = assembleContext({
    pages, chunks, totalPages, question: "Summarise keyword9x", history: [], plan,
  });
  assert.equal(result.mode, "chunk-rag");
  assert.ok(result.stats.promptTokens <= DEFAULT_CLOUD_RETRIEVED_MAX + 1_000);
});

// ---------------------------------------------------------------------------
// The prompt fits (D5)
// ---------------------------------------------------------------------------

console.log("\n=== The prompt fits the Ollama context (D5) ===\n");

test("default Ollama settings, large paper, six history messages: fits", () => {
  const { pages, chunks, totalPages } = paper(60);
  const { plan, resolved } = planFor("ollama", "qwen3.5:4b", 262_144, {
    numCtx: OLLAMA_NUM_CTX,
  });
  const history = makeHistory(6, 2_400); // ~600 tokens each
  const result = assembleContext({
    pages, chunks, totalPages, question: "How does keyword30x relate to keyword31x", history, plan,
  });
  assert.equal(result.mode, "chunk-rag");
  assert.equal(result.stats.historyDropped, 0, "ordinary history should all fit");
  assert.equal(resolved.window, OLLAMA_NUM_CTX);
  const real = worstCaseRealTokens(result, plan, OLLAMA_NUM_CTX);
  assert.ok(real <= OLLAMA_NUM_CTX, `needs ${real} of ${OLLAMA_NUM_CTX}`);
});

test("default Ollama settings, small paper sent whole, six history messages: fits", () => {
  const { pages, chunks, totalPages } = paper(8);
  const { plan } = planFor("ollama", "qwen3.5:4b", 262_144, { numCtx: OLLAMA_NUM_CTX });
  const result = assembleContext({
    pages, chunks, totalPages, question: "What is the main finding", history: makeHistory(6, 2_400), plan,
  });
  assert.equal(result.mode, "whole-paper");
  const real = worstCaseRealTokens(result, plan, OLLAMA_NUM_CTX);
  assert.ok(real <= OLLAMA_NUM_CTX, `needs ${real} of ${OLLAMA_NUM_CTX}`);
});

test("very long history is trimmed, oldest first, until the prompt fits", () => {
  const { pages, chunks, totalPages } = paper(60);
  const { plan } = planFor("ollama", "qwen3.5:4b", 262_144, { numCtx: OLLAMA_NUM_CTX });
  const history = makeHistory(6, 8_000); // ~2,000 tokens each: cannot all fit
  const result = assembleContext({
    pages, chunks, totalPages, question: "How does keyword30x work", history, plan,
  });
  assert.ok(result.stats.historyDropped > 0);
  assert.ok(result.stats.historyDropped < 6, "recent turns should survive");
  const real = worstCaseRealTokens(result, plan, OLLAMA_NUM_CTX);
  assert.ok(real <= OLLAMA_NUM_CTX, `needs ${real} of ${OLLAMA_NUM_CTX}`);
  // The newest message is the one kept.
  const sentText = JSON.stringify(result.messages);
  assert.ok(sentText.includes("turn 5 "));
  assert.ok(!sentText.includes("turn 0 "));
});

test("it also fits at small and large context sizes", () => {
  const { pages, chunks, totalPages } = paper(60);
  for (const numCtx of [4_096, 8_192, 32_768, 65_536]) {
    const { plan } = planFor("ollama", "m", 262_144, { numCtx });
    const result = assembleContext({
      pages, chunks, totalPages, question: "Explain keyword12x", history: makeHistory(6, 2_400), plan,
    });
    const real = worstCaseRealTokens(result, plan, numCtx);
    assert.ok(real <= numCtx, `numCtx ${numCtx}: needs ${real}`);
  }
});

test("trimming history never changes the document block", () => {
  const { pages, chunks, totalPages } = paper(60);
  const { plan } = planFor("ollama", "m", 262_144, { numCtx: OLLAMA_NUM_CTX });
  const first = assembleContext({
    pages, chunks, totalPages, question: "Explain keyword12x", history: [], plan,
  });
  const later = assembleContext({
    pages, chunks, totalPages, question: "Explain keyword12x further",
    history: makeHistory(6, 8_000), plan, previousCore: first.core,
  });
  assert.equal(cacheablePrefix(first.messages), cacheablePrefix(later.messages));
});

// ---------------------------------------------------------------------------
// fitHistory
// ---------------------------------------------------------------------------

console.log("\n=== fitHistory ===\n");

test("keeps everything when it fits", () => {
  const h = makeHistory(4, 400);
  assert.equal(fitHistory(h, 10_000).length, 4);
});

test("drops oldest first and keeps order", () => {
  const h = makeHistory(6, 400); // ~108 tokens each
  const kept = fitHistory(h, 250);
  assert.equal(kept.length, 2);
  assert.deepEqual(kept, h.slice(4));
});

test("never starts with an assistant message", () => {
  const h = makeHistory(6, 400);
  const kept = fitHistory(h, 350); // room for three: assistant, user, assistant
  assert.equal(kept[0]!.role, "user");
  assert.equal(kept.length, 2);
});

test("a zero or negative allowance keeps nothing", () => {
  assert.deepEqual(fitHistory(makeHistory(4, 400), 0), []);
  assert.deepEqual(fitHistory(makeHistory(4, 400), -50), []);
});

// ---------------------------------------------------------------------------
// Stable core + supplement (§5.2)
// ---------------------------------------------------------------------------

console.log("\n=== Stable core plus per-question supplement (§5.2) ===\n");

const BIG = paper(120);
const CLOUD = planFor("anthropic", "claude-haiku-5-5", 1_000_000, {
  whole: 1_000,
  retrieved: 8_000,
}).plan;

function ask(question: string, history: any[], previousCore?: any) {
  return assembleContext({ ...BIG, question, history, plan: CLOUD, previousCore });
}

test("the cacheable prefix is identical across questions in retrieval mode", () => {
  const t1 = ask("Explain keyword20x", []);
  const t2 = ask(
    "Now explain keyword90x",
    [
      { role: "user", content: "Explain keyword20x" },
      { role: "assistant", content: "It is about finding 20." },
    ],
    t1.core,
  );
  const t3 = ask(
    "And keyword55x",
    [
      { role: "user", content: "Explain keyword20x" },
      { role: "assistant", content: "It is about finding 20." },
      { role: "user", content: "Now explain keyword90x" },
      { role: "assistant", content: "It is about finding 90." },
    ],
    t2.core,
  );
  assert.equal(t1.mode, "chunk-rag");
  assert.equal(cacheablePrefix(t1.messages), cacheablePrefix(t2.messages));
  assert.equal(cacheablePrefix(t2.messages), cacheablePrefix(t3.messages));
  assert.deepEqual(t1.core, t3.core);
});

test("the supplement changes with the question and sits outside the prefix", () => {
  const t1 = ask("Explain keyword20x", []);
  const t2 = ask(
    "Now explain keyword90x",
    [{ role: "user", content: "Explain keyword20x" }, { role: "assistant", content: "ok" }],
    t1.core,
  );
  assert.ok(t2.stats.supplementChunks > 0, "expected sections picked for the question");
  const last = t2.messages.at(-1)!;
  assert.equal(last.role, "user");
  assert.ok(!last.cacheable);
  assert.match(last.content, /^<additional_sections>\n/);
  assert.match(last.content, /keyword90x/);
  assert.ok(last.content.endsWith("\n\nNow explain keyword90x"));
  assert.ok(!cacheablePrefix(t2.messages).includes("keyword90x"));
});

test("supplement sections are not already in the core", () => {
  const t1 = ask("Explain keyword20x", []);
  const t2 = ask(
    "Explain keyword20x again and keyword90x",
    [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    t1.core,
  );
  const supplement = t2.messages.at(-1)!.content;
  for (const id of t1.core!.chunkIds) {
    assert.ok(!supplement.includes(`[c.${id} `), `core chunk ${id} repeated`);
  }
});

test("citations validate against core and supplement together", () => {
  const t1 = ask("Explain keyword20x", []);
  const t2 = ask(
    "Now explain keyword90x",
    [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    t1.core,
  );
  const cited = [...JSON.stringify(t2.messages).matchAll(/\[c\.([0-9a-f]+) /g)].map((m) => m[1]!);
  assert.ok(cited.length > t1.core!.chunkIds.length);
  for (const id of cited) {
    assert.ok(t2.chunkWhitelist.has(id), `chunk ${id} was sent but is not citable`);
  }
  assert.equal(t2.chunkWhitelist.size, new Set(cited).size);
});

test("a question with no link to any other section gets no supplement", () => {
  const t1 = ask("Explain keyword20x", []);
  const t2 = ask(
    "Thanks",
    [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    t1.core,
  );
  assert.equal(t2.stats.supplementChunks, 0);
  assert.equal(t2.messages.at(-1)!.content, "Thanks");
});

test("the first question's best matches are in the core", () => {
  const t1 = ask("Explain keyword77x", []);
  assert.ok(cacheablePrefix(t1.messages).includes("keyword77x"));
});

test("a new conversation chooses a new core", () => {
  const t1 = ask("Explain keyword20x", []);
  const fresh = ask("Explain keyword90x", [], t1.core);
  assert.notDeepEqual(fresh.core!.chunkIds, t1.core!.chunkIds);
  assert.ok(cacheablePrefix(fresh.messages).includes("keyword90x"));
});

test("a core chosen for a different size is not reused", () => {
  const t1 = ask("Explain keyword20x", []);
  const bigger = planFor("anthropic", "claude-haiku-5-5", 1_000_000, {
    whole: 1_000,
    retrieved: 16_000,
  }).plan;
  const t2 = assembleContext({
    ...BIG,
    question: "Explain keyword90x",
    history: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }],
    plan: bigger,
    previousCore: t1.core,
  });
  assert.equal(t2.core!.coreMax, bigger.coreMax);
  assert.ok(t2.core!.chunkIds.length > t1.core!.chunkIds.length);
});

test("a core naming chunks that no longer exist is not reused", () => {
  const stale = { chunkIds: ["deadbeef"], coreMax: CLOUD.coreMax };
  const t = ask("Explain keyword20x", [{ role: "user", content: "q" }, { role: "assistant", content: "a" }], stale);
  assert.ok(!t.core!.chunkIds.includes("deadbeef"));
  assert.ok(t.core!.chunkIds.length > 0);
});

test("whole-paper mode has no core and no supplement", () => {
  const small = paper(4);
  const { plan } = planFor("anthropic", "claude-haiku-5-5", 1_000_000);
  const r = assembleContext({ ...small, question: "Explain keyword2x", history: [], plan });
  assert.equal(r.mode, "whole-paper");
  assert.equal(r.core, undefined);
  assert.equal(r.stats.supplementChunks, 0);
  assert.equal(r.messages.at(-1)!.content, "Explain keyword2x");
});

test("promptTokens in the stats matches the messages", () => {
  const t1 = ask("Explain keyword20x", []);
  assert.equal(t1.stats.promptTokens, promptTokens(t1.messages));
});

// ---------------------------------------------------------------------------
// Notes shown to the user
// ---------------------------------------------------------------------------

console.log("\n=== Notes ===\n");

test("the selection note says how much was sent and how much was picked", () => {
  assert.equal(
    describeSelection({ totalPages: 212, totalChunks: 480, selectedChunks: 12, supplementChunks: 3 }),
    "Paper: 212 pages, 480 sections. Sent 12 of them (3 picked for this question).",
  );
  assert.equal(
    describeSelection({ totalPages: 212, totalChunks: 480, selectedChunks: 9, supplementChunks: 0 }),
    "Paper: 212 pages, 480 sections. Sent 9 of them.",
  );
});

test("the dropped-history note handles singular and plural", () => {
  assert.match(describeDroppedHistory(1), /1 earlier message of/);
  assert.match(describeDroppedHistory(4), /4 earlier messages of/);
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
