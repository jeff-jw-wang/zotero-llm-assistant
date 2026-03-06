/**
 * Ollama LLM provider — connects to a locally running Ollama server.
 *
 * Ollama exposes an OpenAI-compatible API at http://localhost:11434.
 * This is the default provider when detected, as it requires no API key
 * and keeps all data local (no cloud sharing).
 *
 * Transport: non-stream calls use `httpPost()` (wraps Zotero.HTTP.request so
 * they route correctly through system proxy and Zotero's network stack).
 * Streaming uses direct XMLHttpRequest with `onprogress` for incremental
 * NDJSON reading — the Fetch API's ReadableStream is unreliable in Zotero's
 * privileged chrome context (Issue #3).
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
import { httpPost, httpGet } from "../../../utils/http";

const DEFAULT_ENDPOINT = "http://localhost:11434";
const DEFAULT_NUM_CTX = 16_384;

/** Connection timeout (ms) — fires if no response data arrives within this window. */
const CONNECTION_TIMEOUT_MS = 15_000;

/**
 * Idle-read timeout (ms) — if no new data arrives during streaming for this long,
 * abort. Higher than cloud providers because Ollama may need time to load/warm
 * a model before the first token arrives.
 */
const IDLE_READ_TIMEOUT_MS = 120_000;

export class OllamaProvider implements ILLMProvider {
  readonly name = "Ollama";
  readonly isCloud = false;

  private endpoint: string;

  constructor(endpoint?: string) {
    this.endpoint = (endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  }

  /**
   * Sends a non-streaming chat request via Zotero.HTTP.request (XHR-based).
   * Used directly when streaming is unavailable, and as the fallback when
   * chatStream() fails.
   */
  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    let response;
    try {
      response = await httpPost(
        `${this.endpoint}/api/chat`,
      JSON.stringify({
        model: options.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          num_ctx: DEFAULT_NUM_CTX,
          ...(options.temperature != null && { temperature: options.temperature }),
          ...(options.maxTokens != null && { num_predict: options.maxTokens }),
        },
      }),
        { "Content-Type": "application/json" },
        CONNECTION_TIMEOUT_MS,
      );
    } catch (err: any) {
      // Transport error — connection refused, DNS failure, timeout.
      throw new Error(
        `Cannot connect to Ollama at ${this.endpoint}. ` +
          "Make sure Ollama is running (ollama serve). " +
          `Details: ${(err as Error)?.message ?? err}`,
      );
    }

    if (!response.ok) {
      // Status 0 means the request was blocked or connection was refused at
      // the transport layer (e.g. Zotero's chrome security, CSP, or Ollama not running).
      if (response.status === 0) {
        throw new Error(
          `Cannot connect to Ollama at ${this.endpoint}. ` +
            "Make sure Ollama is running (ollama serve).",
        );
      }
      throw new Error(`Ollama error ${response.status}: ${response.text}`);
    }

    const data = response.json() as any;
    return data.message?.content ?? "";
  }

  /**
   * Streams the chat response as an async generator of StreamChunk objects.
   *
   * Prefers XHR-based streaming (XMLHttpRequest + onprogress) which works
   * reliably in Zotero's chrome context. Falls back to fetch()-based streaming
   * for test environments where XMLHttpRequest is unavailable.
   */
  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const body = JSON.stringify({
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        num_ctx: DEFAULT_NUM_CTX,
        ...(options.temperature != null && { temperature: options.temperature }),
        ...(options.maxTokens != null && { num_predict: options.maxTokens }),
      },
    });

    // Use XHR-based streaming in Zotero (avoids fetch() reliability issues).
    // Fall back to fetch() in test environments where XMLHttpRequest is unavailable.
    if ((globalThis as any).XMLHttpRequest) {
      yield* this.xhrChatStream(body);
    } else {
      yield* this.fetchChatStream(body);
    }
  }

  /**
   * XHR-based NDJSON streaming via XMLHttpRequest + onprogress.
   *
   * Uses two timers:
   *   - Connection timer (15s): aborts if no data arrives at all (Ollama not running).
   *   - Idle timer (120s): resets on each onprogress; aborts if streaming stalls.
   *
   * The generator converts the event-based XHR API to an async iterator using
   * a queue + signal pattern (single-threaded JS, no actual race conditions).
   */
  private async *xhrChatStream(
    body: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const endpoint = this.endpoint; // Capture 'this' for use in closures.
    const url = `${endpoint}/api/chat`;

    const chunks: StreamChunk[] = [];
    let xhrDone = false;
    let xhrError: Error | null = null;
    let signal: (() => void) | null = null;
    let parseBuffer = "";
    let processedLen = 0;

    /** Wakes up the awaiting generator on new data or completion. */
    function notify(): void {
      if (signal) {
        const s = signal;
        signal = null;
        s();
      }
    }

    /** Parses newly arrived NDJSON text from the XHR response buffer. */
    function drainBuffer(newText: string): void {
      parseBuffer += newText;
      const lines = parseBuffer.split("\n");
      parseBuffer = lines.pop() ?? ""; // Keep last incomplete line.
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed) as any;
          chunks.push({
            text: data.message?.content ?? "",
            done: data.done === true,
          });
        } catch {
          // Skip malformed NDJSON lines.
        }
      }
    }

    const xhr = new ((globalThis as any).XMLHttpRequest)();
    xhr.open("POST", url, true /* async */);
    xhr.setRequestHeader("Content-Type", "application/json");

    // --- Connection timer: fires if Ollama never sends any data. ---
    let connectionTimerCleared = false;
    const connectionTimer = setTimeout(() => {
      if (!connectionTimerCleared) {
        xhr.abort();
        xhrError = new Error(
          `Ollama connection timed out at ${endpoint}. Is Ollama running?`,
        );
        xhrDone = true;
        notify();
      }
    }, CONNECTION_TIMEOUT_MS);

    // --- Idle timer: resets on each onprogress; fires if streaming stalls. ---
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    function resetIdleTimer(): void {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        xhr.abort();
        xhrError = new Error(
          "Ollama stream idle timeout — no data received for 2 minutes.",
        );
        xhrDone = true;
        notify();
      }, IDLE_READ_TIMEOUT_MS);
    }

    function clearAllTimers(): void {
      if (!connectionTimerCleared) {
        clearTimeout(connectionTimer);
        connectionTimerCleared = true;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    xhr.onprogress = () => {
      // Clear connection timer on first data received.
      if (!connectionTimerCleared) {
        clearTimeout(connectionTimer);
        connectionTimerCleared = true;
      }
      resetIdleTimer();

      const newText = (xhr.responseText as string).slice(processedLen);
      processedLen = (xhr.responseText as string).length;
      drainBuffer(newText);
      notify();
    };

    xhr.onload = () => {
      clearAllTimers();

      // Status 0 means the request was blocked or connection was refused at
      // the transport layer (chrome CSP, Ollama not running, etc.). Treat
      // this as a network error so the caller's retry logic (shouldRetryNonStream)
      // can fall back to the non-stream Zotero.HTTP.request path.
      if (xhr.status === 0) {
        xhrError = new Error(
          `Ollama network error: cannot connect to ${endpoint}. ` +
            "Make sure Ollama is running (ollama serve).",
        );
        xhrDone = true;
        notify();
        return;
      }

      // Flush any remaining partial line from the buffer.
      if (parseBuffer.trim()) {
        try {
          const data = JSON.parse(parseBuffer.trim()) as any;
          chunks.push({ text: data.message?.content ?? "", done: true });
        } catch {
          chunks.push({ text: "", done: true });
        }
        parseBuffer = "";
      }

      // Guarantee the generator always receives a final done:true chunk.
      if (chunks.length === 0 || !chunks[chunks.length - 1]!.done) {
        chunks.push({ text: "", done: true });
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        xhrError = new Error(
          `Ollama error ${xhr.status}: ${(xhr.responseText as string).slice(0, 200)}`,
        );
      }

      xhrDone = true;
      notify();
    };

    xhr.onerror = () => {
      clearAllTimers();
      xhrError = new Error(
        `Ollama network connection failed. Is Ollama running at ${endpoint}?`,
      );
      xhrDone = true;
      notify();
    };

    xhr.send(body);

    // --- Async generator loop ---
    // Processes the queue driven by XHR events; suspends between events.
    try {
      while (true) {
        // Drain queued chunks first.
        if (chunks.length > 0) {
          const chunk = chunks.shift()!;
          yield chunk;
          if (chunk.done) return;
          continue;
        }
        // Check terminal states.
        if (xhrError) throw xhrError;
        if (xhrDone) return;
        // Wait for the next notify() call from an XHR event handler.
        // Signal is set synchronously before we await, so no race condition.
        await new Promise<void>((r) => {
          signal = r;
        });
      }
    } finally {
      // Ensure XHR is aborted if the generator is abandoned (e.g. thrown or cancelled).
      clearAllTimers();
      if (!xhrDone) {
        xhr.abort();
      }
    }
  }

  /**
   * fetch()-based NDJSON streaming.
   * Fallback for test environments where XMLHttpRequest is unavailable.
   */
  private async *fetchChatStream(
    body: string,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Ollama response has no readable body.");

    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await (
          reader as ReadableStreamDefaultReader<Uint8Array>
        ).read();
        if (done) break;

        buf += decoder.decode(value, { stream: true } as TextDecodeOptions);
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed) as any;
            const text = data.message?.content ?? "";
            const isDone = data.done === true;
            if (text || isDone) yield { text, done: isDone };
          } catch {
            // Skip malformed NDJSON lines.
          }
        }
      }

      // Flush remaining buffer.
      if (buf.trim()) {
        try {
          const data = JSON.parse(buf.trim()) as any;
          yield { text: data.message?.content ?? "", done: true };
        } catch {
          yield { text: "", done: true };
        }
      }
    } finally {
      controller.abort();
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  /**
   * Tests connectivity by checking the Ollama model list endpoint.
   * Uses Zotero.HTTP.request (via httpGet) so it routes through the system proxy.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await httpGet(
        `${this.endpoint}/api/tags`,
        {},
        3_000,
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
