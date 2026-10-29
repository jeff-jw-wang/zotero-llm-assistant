/**
 * Anthropic LLM provider — connects to the Anthropic Messages API.
 *
 * Uses the /v1/messages REST endpoint directly (no SDK dependency).
 * The endpoint is hardcoded to https://api.anthropic.com — it is not
 * user-configurable and is exempt from SSRF checks.
 *
 * Key differences from OpenAI:
 * - Auth: `x-api-key` header (not Bearer token)
 * - System messages are extracted to a top-level `system` field
 * - `max_tokens` is required (not optional)
 * - Streaming uses SSE with typed events (content_block_delta / message_stop)
 * - Response body uses `content[0].text` (not `choices[0].message.content`)
 *
 * @module modules/llm/providers/anthropic
 * @see https://docs.anthropic.com/en/api/messages
 */
import type {
  ILLMProvider,
  LLMMessage,
  ChatOptions,
  StreamChunk,
} from "../types";
import { httpGet, httpPost } from "../../../utils/http";

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODELS_ENDPOINT = "https://api.anthropic.com/v1/models?limit=1";
const API_VERSION = "2023-06-01";
/**
 * Default output cap for non-streaming requests.
 *
 * Was 4096, which truncated long answers mid-sentence. Current guidance is
 * ~16K for non-streaming (keeps the response under HTTP timeouts) and ~64K
 * for streaming, where timeouts are not a concern.
 */
const DEFAULT_MAX_TOKENS = 16_000;

/** Default output cap for streaming requests. */
const DEFAULT_STREAM_MAX_TOKENS = 64_000;

/** Connection timeout (ms) for the initial fetch. */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Idle-read timeout (ms) — abort if no streaming data arrives for this long. */
const IDLE_READ_TIMEOUT_MS = 60_000;

export class AnthropicProvider implements ILLMProvider {
  readonly name = "Anthropic";
  readonly isCloud = true;

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Converts our LLMMessage[] to Anthropic's request format.
   * System messages are extracted to the top-level `system` field.
   * user/assistant messages go to the `messages` array (roles unchanged).
   *
   * `system` is sent as an **array of content blocks**, not a bare string.
   * Functionally identical today, but only the array form can carry
   * `cache_control`, which Phase 2 needs to cache the stable prompt prefix.
   *
   * @param defaultMaxTokens - Output cap when the caller does not set one;
   *   differs between streaming and non-streaming requests.
   */
  private buildRequest(
    messages: LLMMessage[],
    options: ChatOptions,
    defaultMaxTokens: number = DEFAULT_MAX_TOKENS,
  ) {
    const systemParts: string[] = [];
    const apiMessages: Array<{ role: string; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return {
      model: options.model,
      max_tokens: options.maxTokens ?? defaultMaxTokens,
      ...(systemParts.length > 0 && {
        system: [{ type: "text", text: systemParts.join("\n\n") }],
      }),
      ...(options.temperature != null && { temperature: options.temperature }),
      // Omitted unless the user opts in, so the model's own default applies.
      ...(options.effort && { output_config: { effort: options.effort } }),
      messages: apiMessages,
    };
  }

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    const body = this.buildRequest(messages, options);

    const res = await httpPost(ENDPOINT, JSON.stringify(body), {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": API_VERSION,
    }, CONNECTION_TIMEOUT_MS);

    if (!res.ok) {
      throw new Error(`Anthropic error ${res.status}: ${res.text}`);
    }

    const data = res.json();
    return data.content?.[0]?.text ?? "";
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body = {
      ...this.buildRequest(messages, options, DEFAULT_STREAM_MAX_TOKENS),
      stream: true,
    };

    // Use AbortController so we can cancel the timeout once headers arrive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer); // Headers received — don't abort during streaming.
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Anthropic error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Anthropic response has no readable body.");
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
                reject(new Error("Anthropic stream idle timeout \u2014 no data received for 60 s."));
              }, IDLE_READ_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true } as TextDecodeOptions);

        // Anthropic SSE format: "event: <type>\ndata: {json}\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");
          let eventType = "";
          let dataStr = "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7);
            } else if (line.startsWith("data: ")) {
              dataStr = line.slice(6);
            }
          }

          // Terminal: message_stop
          if (eventType === "message_stop") {
            yield { text: "", done: true };
            return;
          }

          // Content delta
          if (eventType === "content_block_delta" && dataStr) {
            try {
              const data = JSON.parse(dataStr) as any;
              const text = data.delta?.text ?? "";
              if (text) {
                yield { text, done: false };
              }
            } catch {
              // Skip malformed SSE events.
            }
          }
        }
      }

      // Signal completion if stream ended without message_stop.
      yield { text: "", done: true };
    } finally {
      controller.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      // Probe /v1/models rather than sending a Messages request. A Messages
      // ping has to name a model, which means hardcoding one that goes stale
      // and then fails for a reason unrelated to the key. Listing models is
      // model-agnostic, free, and verifies reachability and the key at once.
      const res = await httpGet(MODELS_ENDPOINT, {
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      }, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }
}
