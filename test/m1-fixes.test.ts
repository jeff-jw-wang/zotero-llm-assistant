/**
 * Tests for provider request and response handling: the M1 defect fixes that
 * are not about model selection (those live in models.test.ts), and the M2
 * fixes D10 and D11 plus the Ollama request settings from §5.2.
 *
 * Runs standalone: `npx tsx test/m1-fixes.test.ts`
 * No test framework dependency — uses Node's built-in assert.
 *
 * Covers, by defect number in docs/MODERNIZATION_PLAN_2026.md §4:
 *   D2 — the configured Ollama context size is sent in the request.
 *   D4 — Anthropic non-streaming answers survive a leading thinking block.
 *   D8 — the progress note is cleared by answer text, not by a usage report.
 *   D3 — button labels in the settings locale file use the attribute form.
 *   D10 — the output-token request is clamped to the model's limit.
 *   D11 — refusals and empty answers are explained, not shown blank.
 *   §5.2 — Ollama requests carry keep_alive, and think:false where it applies.
 *
 * No network: providers are driven through a stubbed `Zotero.HTTP.request`
 * and a stubbed `fetch`, and the request bodies they send are captured.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Zotero global stubs
// ---------------------------------------------------------------------------

const mockPrefs: Record<string, any> = {};

/** Every request sent through Zotero.HTTP.request or fetch, newest last. */
const sent: Array<{ url: string; body: any }> = [];
/** What the next non-streaming request returns. */
let nextResponse: any = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string) {
      return mockPrefs[key];
    },
    set(key: string, value: any) {
      mockPrefs[key] = value;
    },
  },
  HTTP: {
    async request(_method: string, url: string, opts: any) {
      sent.push({ url, body: opts?.body ? JSON.parse(opts.body) : undefined });
      const text = JSON.stringify(nextResponse);
      return { status: 200, responseText: text, response: text };
    },
  },
};
(globalThis as any).ztoolkit = { log: () => {} };
(globalThis as any).addon = {
  data: { config: { addonRef: "zotero-llm-assistant" } },
};

const PREFIX = "extensions.zotero.zotero-llm-assistant";

const { OllamaProvider, DEFAULT_NUM_CTX } = await import(
  "../src/modules/llm/providers/ollama"
);
const { AnthropicProvider, extractAnthropicText } = await import(
  "../src/modules/llm/providers/anthropic"
);
const { createProvider } = await import("../src/modules/llm/client");
const { consumeChatStream, hasAnswerText, describeStop } = await import(
  "../src/modules/llm/stream"
);
const { chatOptionsFromModelInfo } = await import("../src/modules/llm/client");
const { clampMaxTokens } = await import("../src/modules/llm/types");
const { KEEP_ALIVE } = await import("../src/modules/llm/providers/ollama");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

const MESSAGES = [
  { role: "system" as const, content: "You answer questions about a paper." },
  { role: "user" as const, content: "What is the main finding?" },
];

/** Replaces global fetch with one that records the body and streams `lines`. */
function stubStreamingFetch(lines: string[]): void {
  (globalThis as any).fetch = async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(lines.join("\n") + "\n", { status: 200 });
  };
}

// ---------------------------------------------------------------------------
// D2 — Ollama context size
// ---------------------------------------------------------------------------

console.log("\n=== D2: Ollama request carries the configured context size ===\n");

await test("buildRequestBody sends the context size it was constructed with", () => {
  const provider = new OllamaProvider("http://localhost:11434", 8192);
  const body: any = provider.buildRequestBody(MESSAGES, { model: "qwen3.5:4b" }, true);
  assert.equal(body.options.num_ctx, 8192);
  assert.equal(body.model, "qwen3.5:4b");
  assert.equal(body.stream, true);
});

await test("a missing or invalid context size falls back to the default, never to none", () => {
  for (const bad of [undefined, 0, -1, NaN]) {
    const provider = new OllamaProvider("http://localhost:11434", bad as any);
    const body: any = provider.buildRequestBody(MESSAGES, { model: "m" }, false);
    assert.equal(body.options.num_ctx, DEFAULT_NUM_CTX);
  }
});

await test("non-streaming chat() puts the configured size on the wire", async () => {
  sent.length = 0;
  nextResponse = { message: { content: "ok" }, done: true };
  const provider = new OllamaProvider("http://localhost:11434", 32768);
  const answer = await provider.chat(MESSAGES, { model: "qwen3.5:4b" });
  assert.equal(answer, "ok");
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.url.endsWith("/api/chat"));
  assert.equal(sent[0]!.body.options.num_ctx, 32768);
  assert.equal(sent[0]!.body.stream, false);
});

await test("streaming chatStream() puts the configured size on the wire", async () => {
  sent.length = 0;
  stubStreamingFetch([
    JSON.stringify({ message: { content: "Hel" }, done: false }),
    JSON.stringify({ message: { content: "lo" }, done: true }),
  ]);
  const provider = new OllamaProvider("http://localhost:11434", 4096);
  let text = "";
  for await (const chunk of provider.chatStream(MESSAGES, { model: "m" })) {
    text += chunk.text;
  }
  assert.equal(text, "Hello");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.body.options.num_ctx, 4096);
  assert.equal(sent[0]!.body.stream, true);
});

await test("createProvider() passes the llm.ollama.numCtx preference through", async () => {
  mockPrefs[`${PREFIX}.llm.provider`] = "ollama";
  mockPrefs[`${PREFIX}.llm.ollama.endpoint`] = "http://localhost:11434";
  mockPrefs[`${PREFIX}.llm.ollama.numCtx`] = 24576;

  sent.length = 0;
  nextResponse = { message: { content: "ok" }, done: true };
  await createProvider().chat(MESSAGES, { model: "m" });
  assert.equal(sent[0]!.body.options.num_ctx, 24576);

  // Changing the setting changes the next request.
  mockPrefs[`${PREFIX}.llm.ollama.numCtx`] = 8192;
  sent.length = 0;
  await createProvider().chat(MESSAGES, { model: "m" });
  assert.equal(sent[0]!.body.options.num_ctx, 8192);
});

// ---------------------------------------------------------------------------
// D3 — settings buttons must have a label
// ---------------------------------------------------------------------------

console.log("\n=== D3: settings controls have labels ===\n");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FTL = readFileSync(
  join(ROOT, "addon/locale/en-US/preferences.ftl"),
  "utf8",
);
const XHTML = readFileSync(
  join(ROOT, "addon/content/preferences.xhtml"),
  "utf8",
);

/**
 * Splits a Fluent file into messages: the inline value (text after `=` on the
 * first line) and the names of any attributes on the indented lines below it.
 */
function parseFtl(source: string): Map<string, { value: string; attrs: string[] }> {
  const messages = new Map<string, { value: string; attrs: string[] }>();
  let current: { value: string; attrs: string[] } | undefined;
  for (const line of source.split("\n")) {
    const head = /^([a-zA-Z][\w-]*)\s*=\s*(.*)$/.exec(line);
    if (head) {
      current = { value: head[2]!.trim(), attrs: [] };
      messages.set(head[1]!, current);
      continue;
    }
    const attr = /^\s+\.([\w-]+)\s*=/.exec(line);
    if (attr && current) current.attrs.push(attr[1]!);
  }
  return messages;
}

const ftl = parseFtl(FTL);

/** l10n IDs used on XUL elements that show their text through `label`. */
const labelled = [...XHTML.matchAll(/<(button|checkbox)\b[^>]*?data-l10n-id="([^"]+)"/g)].map(
  (m) => ({ tag: m[1]!, id: m[2]! }),
);

await test("the settings pane has label-bearing controls to check", () => {
  assert.ok(labelled.length >= 6, `found only ${labelled.length}`);
  assert.equal(
    labelled.filter((c) => c.id === "pref-detect-models").length,
    4,
    "expected four Detect buttons",
  );
});

await test("every button and checkbox message sets .label, not a bare value", () => {
  // A XUL button shows its `label` attribute. A Fluent message with only a
  // value sets the element's text content instead, which a button ignores,
  // leaving it blank.
  for (const { tag, id } of labelled) {
    const message = ftl.get(id);
    assert.ok(message, `<${tag}> uses "${id}", which preferences.ftl does not define`);
    assert.ok(
      message.attrs.includes("label"),
      `"${id}" is used on a <${tag}> but has no .label attribute`,
    );
  }
});

await test("every data-l10n-id in the settings pane is defined", () => {
  for (const m of XHTML.matchAll(/data-l10n-id="([^"]+)"/g)) {
    assert.ok(ftl.has(m[1]!), `"${m[1]}" is not defined in preferences.ftl`);
  }
});

// ---------------------------------------------------------------------------
// D4 — Anthropic non-streaming text extraction
// ---------------------------------------------------------------------------

console.log("\n=== D4: Anthropic answers survive a leading thinking block ===\n");

/** A response as a thinking-enabled model returns it: thinking first. */
const THINKING_FIRST = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "The main finding is X [p.3]." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 1000 },
};

await test("text is found when the first block is a thinking block", () => {
  assert.equal(extractAnthropicText(THINKING_FIRST), "The main finding is X [p.3].");
});

await test("several text blocks are joined in order; other blocks are skipped", () => {
  const data = {
    content: [
      { type: "thinking", thinking: "..." },
      { type: "text", text: "First. " },
      { type: "redacted_thinking", data: "abc" },
      { type: "tool_use", id: "t1", name: "x", input: {} },
      { type: "text", text: "Second." },
    ],
  };
  assert.equal(extractAnthropicText(data), "First. Second.");
});

await test("a plain single-text response still works", () => {
  assert.equal(
    extractAnthropicText({ content: [{ type: "text", text: "Hello" }] }),
    "Hello",
  );
});

await test("no text blocks, or a malformed body, yields an empty string", () => {
  assert.equal(extractAnthropicText({ content: [{ type: "thinking", thinking: "x" }] }), "");
  assert.equal(extractAnthropicText({ content: [] }), "");
  assert.equal(extractAnthropicText({}), "");
  assert.equal(extractAnthropicText(undefined), "");
  assert.equal(extractAnthropicText({ content: "not a list" }), "");
});

await test("chat() returns the answer and usage from a thinking-first response", async () => {
  sent.length = 0;
  nextResponse = THINKING_FIRST;
  const provider = new AnthropicProvider("test-key");
  const answer = await provider.chat(MESSAGES, { model: "claude-haiku-5-5" });
  assert.equal(answer, "The main finding is X [p.3].");
  assert.equal(provider.lastChatUsage()?.cacheReadTokens, 1000);
  assert.equal(sent[0]!.body.model, "claude-haiku-5-5");
});

// ---------------------------------------------------------------------------
// D8 — the progress note is cleared by text, not by the first event
// ---------------------------------------------------------------------------

console.log("\n=== D8: only answer text clears the progress note ===\n");

async function* streamOf(chunks: any[]) {
  for (const c of chunks) yield c;
}

await test("hasAnswerText is false for usage-only and empty chunks", () => {
  assert.equal(hasAnswerText({ text: "", done: false, usage: { inputTokens: 5 } }), false);
  assert.equal(hasAnswerText({ text: "", done: true }), false);
  assert.equal(hasAnswerText({ text: "a", done: false }), true);
});

await test("a leading usage report does not count as the first text", async () => {
  // What Anthropic sends with a thinking model: usage first, then a pause,
  // then text.
  const events: string[] = [];
  const result = await consumeChatStream(
    streamOf([
      { text: "", done: false, usage: { inputTokens: 1200, cacheReadTokens: 1000 } },
      { text: "", done: false },
      { text: "Hel", done: false },
      { text: "lo", done: false },
      { text: "", done: false, usage: { outputTokens: 40 } },
      { text: "", done: true },
    ]),
    {
      onFirstText: () => events.push("first"),
      onText: (t: string) => events.push(`text:${t}`),
    },
  );
  assert.deepEqual(events, ["first", "text:Hel", "text:Hello"]);
  assert.equal(result.text, "Hello");
  assert.equal(result.sawText, true);
});

await test("usage reports are merged, not replaced", async () => {
  const result = await consumeChatStream(
    streamOf([
      { text: "", done: false, usage: { inputTokens: 1200, cacheReadTokens: 1000 } },
      { text: "ok", done: false },
      { text: "", done: true, usage: { outputTokens: 40 } },
    ]),
  );
  assert.deepEqual(result.usage, {
    inputTokens: 1200,
    cacheReadTokens: 1000,
    outputTokens: 40,
  });
});

await test("a stream with no text never fires onFirstText", async () => {
  let fired = 0;
  const result = await consumeChatStream(
    streamOf([
      { text: "", done: false, usage: { inputTokens: 10 } },
      { text: "", done: true },
    ]),
    { onFirstText: () => fired++ },
  );
  assert.equal(fired, 0);
  assert.equal(result.sawText, false);
  assert.equal(result.text, "");
});

await test("consumption stops at the done chunk", async () => {
  const result = await consumeChatStream(
    streamOf([
      { text: "a", done: false },
      { text: "b", done: true },
      { text: "never", done: false },
    ]),
  );
  assert.equal(result.text, "ab");
});

await test("a stream error propagates so the non-streaming fallback can run", async () => {
  async function* failing() {
    yield { text: "par", done: false };
    throw new Error("network error");
  }
  await assert.rejects(() => consumeChatStream(failing()), /network error/);
});

// ---------------------------------------------------------------------------
// D10 — max_tokens clamped to the model's limit
// ---------------------------------------------------------------------------

console.log("\n=== D10: output request is clamped to the model's limit ===\n");

/** Reaches the provider's private request builder for shape assertions. */
function anthropicRequest(options: any, defaultMax?: number): any {
  const provider: any = new AnthropicProvider("test-key");
  return defaultMax === undefined
    ? provider.buildRequest(MESSAGES, options)
    : provider.buildRequest(MESSAGES, options, defaultMax);
}

await test("clampMaxTokens lowers a request above the limit and leaves others alone", () => {
  assert.equal(clampMaxTokens(64_000, 8_192), 8_192);
  assert.equal(clampMaxTokens(16_000, 64_000), 16_000);
  assert.equal(clampMaxTokens(16_000, undefined), 16_000);
  assert.equal(clampMaxTokens(16_000, 0), 16_000);
  assert.equal(clampMaxTokens(16_000, NaN), 16_000);
});

await test("an older model with a 4,096 limit is not asked for the 64K streaming default", () => {
  const body = anthropicRequest(
    { model: "claude-3-haiku-20240307", modelMaxOutputTokens: 4_096 },
    64_000,
  );
  assert.equal(body.max_tokens, 4_096);
});

await test("a current model keeps the defaults", () => {
  const opts = { model: "claude-haiku-5-5", modelMaxOutputTokens: 128_000 };
  assert.equal(anthropicRequest(opts).max_tokens, 16_000);
  assert.equal(anthropicRequest(opts, 64_000).max_tokens, 64_000);
});

await test("an unknown limit leaves the default untouched", () => {
  assert.equal(anthropicRequest({ model: "claude-haiku-5-5" }, 64_000).max_tokens, 64_000);
});

await test("an explicit maxTokens is clamped too", () => {
  const body = anthropicRequest({
    model: "m",
    maxTokens: 50_000,
    modelMaxOutputTokens: 8_192,
  });
  assert.equal(body.max_tokens, 8_192);
});

await test("discovery's output limit is carried into the chat options", () => {
  assert.deepEqual(
    chatOptionsFromModelInfo("anthropic", { maxOutputTokens: 8_192 }),
    { modelMaxOutputTokens: 8_192 },
  );
  assert.deepEqual(chatOptionsFromModelInfo("anthropic", undefined), {});
  assert.deepEqual(chatOptionsFromModelInfo("openai", {}), {});
});

// ---------------------------------------------------------------------------
// D11 — refusals and empty completions
// ---------------------------------------------------------------------------

console.log("\n=== D11: refusals and empty answers are explained ===\n");

await test("a normal answer needs no explanation", () => {
  assert.equal(describeStop("The finding is X.", "end_turn"), undefined);
  assert.equal(describeStop("The finding is X.", undefined), undefined);
  assert.equal(describeStop("The finding is X.", "stop_sequence"), undefined);
});

await test("a refusal with no text says the model declined", () => {
  assert.match(describeStop("", "refusal")!, /declined to answer/);
});

await test("a refusal after partial text says the answer is incomplete", () => {
  assert.match(describeStop("The paper says", "refusal")!, /incomplete/);
});

await test("running out of output before any text points at the effort setting", () => {
  assert.match(describeStop("", "max_tokens")!, /Effort/);
});

await test("an answer cut off at the limit says so", () => {
  assert.match(describeStop("Long answer", "max_tokens")!, /cut off/);
});

await test("an empty answer with no reason still gets a message", () => {
  assert.match(describeStop("", undefined)!, /empty answer/);
  assert.match(describeStop("  \n", "end_turn")!, /empty answer/);
});

await test("the stop reason travels from the stream to the caller", async () => {
  const result = await consumeChatStream(
    streamOf([
      { text: "", done: false, usage: { inputTokens: 10 } },
      { text: "", done: true, stopReason: "refusal" },
    ]),
  );
  assert.equal(result.stopReason, "refusal");
  assert.equal(result.sawText, false);
});

/** A fetch stub that streams Anthropic server-sent events. */
function stubAnthropicSse(events: Array<{ event: string; data: any }>): void {
  (globalThis as any).fetch = async (url: string, init: any) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const body = events
      .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join("");
    return new Response(body, { status: 200 });
  };
}

await test("Anthropic streaming reports a refusal's stop reason", async () => {
  stubAnthropicSse([
    { event: "message_start", data: { message: { usage: { input_tokens: 50 } } } },
    {
      event: "message_delta",
      data: { delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } },
    },
    { event: "message_stop", data: {} },
  ]);
  const provider = new AnthropicProvider("test-key");
  const result = await consumeChatStream(
    provider.chatStream(MESSAGES, { model: "claude-haiku-5-5" }),
  );
  assert.equal(result.text, "");
  assert.equal(result.stopReason, "refusal");
  assert.match(describeStop(result.text, result.stopReason)!, /declined/);
});

await test("Anthropic streaming skips thinking deltas and keeps the text", async () => {
  stubAnthropicSse([
    { event: "message_start", data: { message: { usage: { input_tokens: 50 } } } },
    { event: "content_block_delta", data: { delta: { type: "thinking_delta", thinking: "hmm" } } },
    { event: "content_block_delta", data: { delta: { type: "text_delta", text: "Answer." } } },
    { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: {} },
  ]);
  const provider = new AnthropicProvider("test-key");
  const result = await consumeChatStream(
    provider.chatStream(MESSAGES, { model: "claude-haiku-5-5" }),
  );
  assert.equal(result.text, "Answer.");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage?.outputTokens, 9);
  assert.equal(describeStop(result.text, result.stopReason), undefined);
});

await test("Anthropic non-streaming exposes the stop reason", async () => {
  nextResponse = { content: [], stop_reason: "refusal", usage: {} };
  const provider = new AnthropicProvider("test-key");
  const answer = await provider.chat(MESSAGES, { model: "claude-haiku-5-5" });
  assert.equal(answer, "");
  assert.equal(provider.lastChatStopReason(), "refusal");
});

// ---------------------------------------------------------------------------
// §5.2 — Ollama request settings
// ---------------------------------------------------------------------------

console.log("\n=== §5.2: Ollama keep_alive and think ===\n");

await test("every Ollama request asks to keep the model loaded", () => {
  const provider = new OllamaProvider("http://localhost:11434", 16384);
  for (const stream of [true, false]) {
    const body: any = provider.buildRequestBody(MESSAGES, { model: "m" }, stream);
    assert.equal(body.keep_alive, KEEP_ALIVE);
  }
  assert.equal(KEEP_ALIVE, "30m");
});

await test("think:false is sent for a model that can think", () => {
  const options = {
    model: "qwen3.5:4b",
    ...chatOptionsFromModelInfo("ollama", {
      capabilities: ["completion", "thinking", "vision"],
    }),
  };
  const provider = new OllamaProvider("http://localhost:11434", 16384);
  const body: any = provider.buildRequestBody(MESSAGES, options, true);
  assert.equal(body.think, false);
});

await test("think is not sent for a model that cannot think, or is unknown", () => {
  const provider = new OllamaProvider("http://localhost:11434", 16384);
  for (const info of [{ capabilities: ["completion"] }, {}, undefined]) {
    const options = { model: "m", ...chatOptionsFromModelInfo("ollama", info as any) };
    const body: any = provider.buildRequestBody(MESSAGES, options, true);
    assert.ok(!("think" in body), JSON.stringify(info));
  }
});

await test("think is never set for cloud providers", () => {
  assert.deepEqual(
    chatOptionsFromModelInfo("anthropic", { capabilities: ["thinking"] }),
    {},
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
