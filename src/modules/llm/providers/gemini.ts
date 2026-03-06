/**
 * Google Gemini LLM provider — connects to the Gemini API (generativelanguage.googleapis.com).
 *
 * Uses the generateContent / streamGenerateContent REST endpoints directly
 * (no SDK dependency) so the bundle stays small and avoids Node.js-only packages.
 *
 * The free tier (Google AI Studio key) allows 60 req/min and 1K req/day on
 * Gemini Flash — generous enough for paper Q&A usage.
 *
 * @module modules/llm/providers/gemini
 * @see https://ai.google.dev/gemini-api/docs
 */
import type {
  ILLMProvider,
  LLMMessage,
  ChatOptions,
  StreamChunk,
} from "../types";
import { httpPost, httpGet } from "../../../utils/http";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Connection timeout (ms) for the initial fetch. */
const CONNECTION_TIMEOUT_MS = 30_000;

/** Idle-read timeout (ms) — abort if no streaming data arrives for this long. */
const IDLE_READ_TIMEOUT_MS = 60_000;

/**
 * Formats a Gemini API error into a user-friendly message.
 * Prevents dumping raw JSON error bodies into the chat UI.
 */
function formatGeminiError(status: number, rawText: string): Error {
  if (status === 429) {
    return new Error(
      "Gemini API quota exceeded. The free tier has limited requests per day.\n" +
        "• Wait a few minutes and try again, or\n" +
        "• Switch to Ollama (local, unlimited) in Settings.",
    );
  }
  if (status === 403) {
    return new Error(
      "Gemini API access denied. Check that your API key is valid in Settings.",
    );
  }
  // For other errors, try to extract a short message from the JSON body.
  try {
    const data = JSON.parse(rawText);
    const msg: string =
      data?.error?.message ?? data?.error?.status ?? rawText.slice(0, 200);
    return new Error(`Gemini error (${status}): ${msg}`);
  } catch {
    return new Error(`Gemini error (${status}): ${rawText.slice(0, 200)}`);
  }
}

export class GeminiProvider implements ILLMProvider {
  readonly name = "Google Gemini";
  readonly isCloud = true;

  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Converts our LLMMessage[] to Gemini's content format.
   * Gemini uses "user" and "model" roles (not "assistant").
   * System messages are passed via the systemInstruction field.
   */
  private buildRequest(messages: LLMMessage[], options: ChatOptions) {
    const systemParts: string[] = [];
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        systemParts.push(msg.content);
      } else {
        contents.push({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        });
      }
    }

    return {
      ...(systemParts.length > 0 && {
        systemInstruction: {
          parts: systemParts.map((text) => ({ text })),
        },
      }),
      contents,
      generationConfig: {
        ...(options.maxTokens != null && { maxOutputTokens: options.maxTokens }),
        ...(options.temperature != null && { temperature: options.temperature }),
      },
    };
  }

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    const url = `${BASE_URL}/${options.model}:generateContent?key=${this.apiKey}`;
    const body = this.buildRequest(messages, options);

    const res = await httpPost(url, JSON.stringify(body), {
      "Content-Type": "application/json",
    }, CONNECTION_TIMEOUT_MS);

    if (!res.ok) {
      throw formatGeminiError(res.status, res.text);
    }

    const data = res.json();
    return (
      data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    );
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const url = `${BASE_URL}/${options.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const body = this.buildRequest(messages, options);

    // Use AbortController so we can cancel the timeout once headers arrive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer); // Headers received — don't abort during streaming.
    }

    if (!response.ok) {
      const text = await response.text();
      throw formatGeminiError(response.status, text);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Gemini response has no readable body.");
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
                reject(new Error("Gemini stream idle timeout \u2014 no data received for 60 s."));
              }, IDLE_READ_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true } as TextDecodeOptions);

        // Gemini SSE format: "data: {json}\n\n"
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const dataLine = event
            .split("\n")
            .find((line) => line.startsWith("data: "));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(6); // Remove "data: " prefix
          try {
            const data = JSON.parse(jsonStr) as any;
            const text =
              data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
            const finishReason = data.candidates?.[0]?.finishReason;
            yield {
              text,
              done: finishReason === "STOP" || finishReason === "MAX_TOKENS",
            };
          } catch {
            // Skip malformed SSE events.
          }
        }
      }

      // Signal completion.
      yield { text: "", done: true };
    } finally {
      controller.abort();
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      // Light-weight check: list models.
      const res = await httpGet(`${BASE_URL}?key=${this.apiKey}`, {}, 5000);
      return res.ok;
    } catch {
      return false;
    }
  }
}
