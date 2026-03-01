/**
 * Ollama LLM provider — connects to a locally running Ollama server.
 *
 * Ollama exposes an OpenAI-compatible API at http://localhost:11434.
 * This is the default provider when detected, as it requires no API key
 * and keeps all data local (no cloud sharing).
 *
 * Streaming uses the /api/chat endpoint with `stream: true`, which returns
 * newline-delimited JSON objects.
 *
 * @module modules/llm/providers/ollama
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */
import type {
  ILLMProvider,
  LLMMessage,
  ChatOptions,
  StreamChunk,
} from "../types";

const DEFAULT_ENDPOINT = "http://localhost:11434";

/** Connection timeout (ms) for the initial fetch — prevents hanging if Ollama isn't running. */
const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Idle-read timeout (ms) — if no data arrives during streaming for this long,
 * abort. Set higher than cloud providers because Ollama may take time to
 * load/warm a model before the first token arrives.
 */
const IDLE_READ_TIMEOUT_MS = 120_000;

export class OllamaProvider implements ILLMProvider {
  readonly name = "Ollama";
  readonly isCloud = false;

  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  }

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    const response = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          ...(options.temperature != null && { temperature: options.temperature }),
          ...(options.maxTokens != null && { num_predict: options.maxTokens }),
        },
      }),
      signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as any;
    return data.message?.content ?? "";
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    // Use AbortController so we can cancel the timeout once headers arrive
    // (streaming the body can legitimately take much longer).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: options.model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: true,
          options: {
            ...(options.temperature != null && { temperature: options.temperature }),
            ...(options.maxTokens != null && { num_predict: options.maxTokens }),
          },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer); // Headers received — don't abort during streaming.
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Ollama response has no readable body.");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        let readResult: ReadableStreamReadResult;
        const readPromise = (reader as ReadableStreamDefaultReader<Uint8Array>).read();
        // Suppress the AbortError that fires after idle-timeout aborts the stream,
        // since Promise.race already picked up our descriptive timeout error.
        readPromise.catch(() => {});
        try {
          readResult = await Promise.race([
            readPromise,
            new Promise<never>((_, reject) => {
              idleTimer = setTimeout(() => {
                controller.abort(); // Cancel the stream so the pending read() settles.
                reject(new Error("Ollama stream idle timeout \u2014 no data received for 2 minutes."));
              }, IDLE_READ_TIMEOUT_MS);
            }),
          ]);
        } finally {
          clearTimeout(idleTimer);
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true } as TextDecodeOptions);
        const lines = buffer.split("\n");
        // Keep the last (possibly incomplete) line in the buffer.
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed) as any;
            const text = data.message?.content ?? "";
            const isDone = data.done === true;
            if (text || isDone) {
              yield { text, done: isDone };
            }
          } catch {
            // Skip malformed JSON lines.
          }
        }
      }

      // Process any remaining buffer.
      if (buffer.trim()) {
        try {
          const data = JSON.parse(buffer.trim()) as any;
          yield { text: data.message?.content ?? "", done: true };
        } catch {
          yield { text: "", done: true };
        }
      }
    } finally {
      controller.abort(); // Ensure stream is torn down on any exit path.
      try { reader.releaseLock(); } catch { /* already released or pending settled via abort */ }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
