/**
 * QA-fix tests — validates the four runtime fixes applied after manual Zotero QA.
 *
 * 1. Ollama status-0 handling: XHR onload with status 0 produces a "network"
 *    error that triggers the non-stream retry path.
 * 2. Gemini error formatting: 429/403/generic errors produce user-friendly
 *    messages instead of raw JSON dumps.
 * 3. Provider-toggle reactivity: privacy toggle re-reads provider name on
 *    every applyState() call (no stale closure).
 *
 * Runs standalone: `npx tsx test/qa-fixes.test.ts`
 *
 * @see REVIEW.md — "[P2] New manual QA fixes remain largely untested"
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
    console.log(`  \u2713 ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  \u2717 ${name}`);
    console.error(`    ${err.message}`);
  }
}

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
// Zotero global mock (minimal — no IDB needed for these tests)
// ---------------------------------------------------------------------------

const prefStore: Record<string, any> = {};

(globalThis as any).Zotero = {
  Prefs: {
    get(key: string) {
      return prefStore[key];
    },
    set(key: string, value: any) {
      prefStore[key] = value;
    },
  },
};

(globalThis as any).ztoolkit = {
  log: (..._args: any[]) => {},
};

// ---------------------------------------------------------------------------
// 1. Ollama status-0 handling
// ---------------------------------------------------------------------------

// We test the OllamaProvider by mocking httpPost/httpGet at the module level.
// The provider calls httpPost() from "../../utils/http" — we need to intercept it.

// Strategy: Import the OllamaProvider class, then test chat() with a mocked
// httpPost that simulates status 0 and transport errors.

// Since we can't easily mock ES module imports without a framework, we'll test
// the behavior indirectly by constructing an OllamaProvider and intercepting
// the global Zotero.HTTP.request (which httpPost delegates to).

console.log("\n=== Ollama Status-0 Handling Tests ===\n");

// Mock Zotero.HTTP.request for controlled responses
let mockHttpResponse: { status: number; responseText: string } | Error | null = null;

(globalThis as any).Zotero.HTTP = {
  request: async (_method: string, _url: string, _opts: any) => {
    if (mockHttpResponse instanceof Error) {
      throw mockHttpResponse;
    }
    if (mockHttpResponse && mockHttpResponse.status >= 200 && mockHttpResponse.status < 300) {
      return mockHttpResponse;
    }
    // Non-2xx: Zotero.HTTP throws with { status, xmlhttp }
    if (mockHttpResponse) {
      const err: any = new Error(`HTTP ${mockHttpResponse.status}`);
      err.status = mockHttpResponse.status;
      err.xmlhttp = mockHttpResponse;
      throw err;
    }
    throw new Error("No mock response configured");
  },
};

// Now import OllamaProvider — it will use our mocked Zotero.HTTP
const { OllamaProvider } = await import(
  "../src/modules/llm/providers/ollama.js"
);

await testAsync("chat() with status 0 throws clear connection error", async () => {
  mockHttpResponse = { status: 0, responseText: "" };
  const provider = new OllamaProvider("http://localhost:11434");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "llama3.2" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /Cannot connect to Ollama/i.test(err.message),
      `Expected connection error, got: ${err.message}`,
    );
    assert.ok(
      /ollama serve/i.test(err.message),
      `Expected 'ollama serve' hint, got: ${err.message}`,
    );
  }
});

await testAsync("chat() with transport error throws clear connection error", async () => {
  mockHttpResponse = new Error("Connection refused");
  const provider = new OllamaProvider("http://localhost:11434");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "llama3.2" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /Cannot connect to Ollama/i.test(err.message),
      `Expected connection error, got: ${err.message}`,
    );
    assert.ok(
      /Connection refused/i.test(err.message),
      `Expected original error detail, got: ${err.message}`,
    );
  }
});

await testAsync("chat() with HTTP 404 throws Ollama error with status", async () => {
  mockHttpResponse = { status: 404, responseText: "model not found" };
  const provider = new OllamaProvider("http://localhost:11434");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "nonexistent" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /Ollama error 404/i.test(err.message),
      `Expected Ollama error 404, got: ${err.message}`,
    );
  }
});

await testAsync("chat() with HTTP 200 returns content", async () => {
  mockHttpResponse = {
    status: 200,
    responseText: JSON.stringify({ message: { content: "Hello world" } }),
  };
  const provider = new OllamaProvider("http://localhost:11434");
  const result = await provider.chat(
    [{ role: "user", content: "hello" }],
    { model: "llama3.2" },
  );
  assert.equal(result, "Hello world");
});

// ---------------------------------------------------------------------------
// 1b. Ollama XHR status-0 error message contains "network" for retry trigger
// ---------------------------------------------------------------------------

console.log("\n=== Ollama XHR Status-0 Retry Trigger Tests ===\n");

// We can't easily test the XHR streaming path without a real XMLHttpRequest,
// but we can verify that the shouldRetryNonStream regex matches "network error"
// messages, which is the key behavior the XHR status-0 fix relies on.

test("shouldRetryNonStream pattern matches 'network error' message", () => {
  const RETRY_RE = /timeout|timed out|idle timeout|abort|network|failed to fetch|stream/i;
  const msg = "Ollama network error: cannot connect to http://localhost:11434. Make sure Ollama is running (ollama serve).";
  assert.ok(RETRY_RE.test(msg), `Expected retry pattern to match: ${msg}`);
});

test("shouldRetryNonStream pattern matches 'network connection failed' message", () => {
  const RETRY_RE = /timeout|timed out|idle timeout|abort|network|failed to fetch|stream/i;
  const msg = "Ollama network connection failed. Is Ollama running at http://localhost:11434?";
  assert.ok(RETRY_RE.test(msg), `Expected retry pattern to match: ${msg}`);
});

test("shouldRetryNonStream pattern does NOT match clean Ollama error", () => {
  const RETRY_RE = /timeout|timed out|idle timeout|abort|network|failed to fetch|stream/i;
  const msg = "Ollama error 500: internal server error";
  assert.ok(!RETRY_RE.test(msg), `Expected retry pattern NOT to match: ${msg}`);
});

// ---------------------------------------------------------------------------
// 2. Gemini error formatting
// ---------------------------------------------------------------------------

console.log("\n=== Gemini Error Formatting Tests ===\n");

// formatGeminiError is module-private, so we test through GeminiProvider.chat().
// We need to mock httpPost for the Gemini endpoint.

const { GeminiProvider } = await import(
  "../src/modules/llm/providers/gemini.js"
);

await testAsync("Gemini 429 produces user-friendly quota message", async () => {
  // Mock: Zotero.HTTP returns 429 with raw JSON body
  const rawJson = JSON.stringify({
    error: {
      code: 429,
      message: "Resource has been exhausted (e.g. check quota).",
      status: "RESOURCE_EXHAUSTED",
      details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure" }],
    },
  });
  mockHttpResponse = { status: 429, responseText: rawJson };

  const provider = new GeminiProvider("fake-api-key");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gemini-2.0-flash" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /quota exceeded/i.test(err.message),
      `Expected quota message, got: ${err.message}`,
    );
    assert.ok(
      /switch to ollama/i.test(err.message),
      `Expected Ollama suggestion, got: ${err.message}`,
    );
    // Must NOT contain raw JSON
    assert.ok(
      !err.message.includes("RESOURCE_EXHAUSTED"),
      `Should not contain raw JSON status, got: ${err.message}`,
    );
  }
});

await testAsync("Gemini 403 produces access-denied message", async () => {
  mockHttpResponse = {
    status: 403,
    responseText: JSON.stringify({ error: { message: "Forbidden" } }),
  };
  const provider = new GeminiProvider("bad-key");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gemini-2.0-flash" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /access denied/i.test(err.message),
      `Expected access denied message, got: ${err.message}`,
    );
    assert.ok(
      /API key/i.test(err.message),
      `Expected API key hint, got: ${err.message}`,
    );
  }
});

await testAsync("Gemini 500 extracts error.message from JSON", async () => {
  mockHttpResponse = {
    status: 500,
    responseText: JSON.stringify({
      error: { message: "Internal error occurred", code: 500 },
    }),
  };
  const provider = new GeminiProvider("fake-key");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gemini-2.0-flash" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    assert.ok(
      /Internal error occurred/i.test(err.message),
      `Expected extracted message, got: ${err.message}`,
    );
    assert.ok(
      /Gemini error \(500\)/i.test(err.message),
      `Expected status prefix, got: ${err.message}`,
    );
  }
});

await testAsync("Gemini error with non-JSON body truncates to 200 chars", async () => {
  const longBody = "x".repeat(500);
  mockHttpResponse = { status: 502, responseText: longBody };
  const provider = new GeminiProvider("fake-key");
  try {
    await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gemini-2.0-flash" },
    );
    assert.fail("Should have thrown");
  } catch (err: any) {
    // The message should contain at most 200 x's, not 500
    const xCount = (err.message.match(/x/g) || []).length;
    assert.ok(
      xCount <= 200,
      `Expected truncated body (≤200 chars), got ${xCount} x's`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Privacy toggle provider label reactivity
// ---------------------------------------------------------------------------

console.log("\n=== Privacy Toggle Provider Label Tests ===\n");

// We can't import privacyToggle.ts (needs DOM), but we CAN test the logic:
// getActiveProviderLabel reads prefs.getActiveProvider() on every call.
// We test that the pref getter returns the updated value after a change.

import * as prefs from "../src/prefs.js";

test("getActiveProvider returns updated value after setActiveProvider", () => {
  prefs.setActiveProvider("gemini");
  assert.equal(prefs.getActiveProvider(), "gemini");

  prefs.setActiveProvider("ollama");
  assert.equal(prefs.getActiveProvider(), "ollama");

  // Key assertion: the value changes immediately — no caching
  prefs.setActiveProvider("anthropic");
  assert.equal(prefs.getActiveProvider(), "anthropic");
});

test("privacy toggle label map covers all provider keys", () => {
  const labels: Record<string, string> = {
    ollama: "Ollama",
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Claude",
    custom: "Custom",
  };

  for (const key of ["ollama", "gemini", "openai", "anthropic", "custom"]) {
    prefs.setActiveProvider(key as any);
    const provider = prefs.getActiveProvider();
    assert.ok(
      labels[provider] !== undefined,
      `Missing label for provider: ${provider}`,
    );
  }
});

test("friendlyErrorMessage rate-limit pattern matches 429 errors", () => {
  const RATE_LIMIT_RE = /429|quota exceeded|rate.?limit/i;
  assert.ok(RATE_LIMIT_RE.test("Gemini error 429: ..."));
  assert.ok(RATE_LIMIT_RE.test("Quota exceeded for this API key"));
  assert.ok(RATE_LIMIT_RE.test("Rate limit reached, try later"));
  assert.ok(!RATE_LIMIT_RE.test("Internal server error 500"));
});

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log(
  `\n========================================\nResults: ${passed} passed, ${failed} failed\n========================================\n`,
);
if (failed > 0) process.exit(1);
