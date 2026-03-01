/**
 * OpenAI-compatible LLM provider — connects to OpenAI or any OpenAI-compatible endpoint.
 *
 * Used for both the "openai" and "custom" provider selections (D1 in Phase C plan).
 * Custom endpoints instantiate this same class with a user-supplied base URL.
 *
 * Streaming uses the /v1/chat/completions endpoint with `stream: true`, which
 * returns Server-Sent Events (SSE) with `data: {json}` lines terminated by
 * `data: [DONE]`.
 *
 * Runtime SSRF guard (D2): `validateEndpointURL()` is called at the top of both
 * `chat()` and `chatStream()` to reject blocked endpoints even if they were
 * stored before the blocklist was updated.
 *
 * @module modules/llm/providers/openai
 * @see https://platform.openai.com/docs/api-reference/chat/create
 */
import type {
  ILLMProvider,
  LLMMessage,
  ChatOptions,
  StreamChunk,
} from "../types";
import { validateEndpointURL } from "../../../utils/url";
import { httpPost, httpGet } from "../../../utils/http";

const DEFAULT_ENDPOINT = "https://api.openai.com";

/** Connection timeout (ms) for the initial fetch. */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Idle-read timeout (ms) — abort if no streaming data arrives for this long. */
const IDLE_READ_TIMEOUT_MS = 60_000;

export class OpenAIProvider implements ILLMProvider {
  readonly name = "OpenAI";
  readonly isCloud = true;

  private endpoint: string;
  private apiKey: string;

  constructor(endpoint: string, apiKey: string) {
    // Normalize: strip trailing slashes, then strip trailing "/v1" to avoid
    // double-path issues when user enters "https://api.example.com/v1".
    this.endpoint = (endpoint || DEFAULT_ENDPOINT)
      .replace(/\/+$/, "")
      .replace(/\/v1$/, "");
    this.apiKey = apiKey;
  }

  /**
   * Validates the endpoint against SSRF policy.
   * Called at the top of every request method (D2: static fail-closed at request time).
   */
  private assertEndpointSafe(): void {
    const r = validateEndpointURL(this.endpoint);
    if (!r.valid) {
      throw new Error(r.error ?? "Invalid endpoint URL.");
    }
  }

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    this.assertEndpointSafe();

    const url = `${this.endpoint}/v1/chat/completions`;
    const payload = JSON.stringify({
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      ...(options.temperature != null && { temperature: options.temperature }),
      ...(options.maxTokens != null && { max_tokens: options.maxTokens }),
    });

    // Use Zotero.HTTP.request via httpPost — more reliable in the extension
    // context than fetch() which may not route through system proxy/network.
    const res = await httpPost(url, payload, {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    }, CONNECTION_TIMEOUT_MS);

    if (!res.ok) {
      throw new Error(`OpenAI error ${res.status}: ${res.text}`);
    }

    const data = res.json();
    return data.choices?.[0]?.message?.content ?? "";
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.assertEndpointSafe();

    // Use AbortController so we can cancel the timeout once headers arrive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          ...(options.temperature != null && { temperature: options.temperature }),
          ...(options.maxTokens != null && { max_tokens: options.maxTokens }),
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer); // Headers received — don't abort during streaming.
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("OpenAI response has no readable body.");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let readResult: ReadableStreamReadResult;
        const readPromise = (reader as ReadableStreamDefaultReader<Uint8Array>).read();
        readPromise.catch(() => {}); // Suppress AbortError after idle-timeout abort.
        try {
          readResult = await Promise.race([
            readPromise,
            new Promise<never>((_, reject) => {
              idleTimer = setTimeout(() => {
                controller.abort();
                reject(new Error("OpenAI stream idle timeout \u2014 no data received for 60 s."));
              }, IDLE_READ_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true } as TextDecodeOptions);

        // OpenAI SSE format: "data: {json}\n\n" terminated by "data: [DONE]\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const line of event.split("\n")) {
            if (!line.startsWith("data: ")) continue;

            const payload = line.slice(6); // Remove "data: " prefix

            // Terminal signal.
            if (payload === "[DONE]") {
              yield { text: "", done: true };
              return;
            }

            try {
              const data = JSON.parse(payload) as any;
              const text = data.choices?.[0]?.delta?.content ?? "";
              const finishReason = data.choices?.[0]?.finish_reason;
              if (text || finishReason) {
                yield { text, done: finishReason != null };
              }
            } catch {
              // Skip malformed SSE events.
            }
          }
        }
      }

      // Signal completion if stream ended without [DONE].
      yield { text: "", done: true };
    } finally {
      controller.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const r = validateEndpointURL(this.endpoint);
      if (!r.valid) return false;

      const res = await httpGet(`${this.endpoint}/v1/models`, {
        Authorization: `Bearer ${this.apiKey}`,
      }, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }
}
