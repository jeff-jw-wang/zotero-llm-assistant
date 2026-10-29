/**
 * Shared types for the LLM provider abstraction layer.
 *
 * All providers implement ILLMProvider so the rest of the plugin is decoupled
 * from any specific API format. Streaming is supported on all providers via
 * an async generator that yields StreamChunk objects.
 *
 * @module modules/llm/types
 */

/** A single message in an LLM chat conversation. */
export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A chunk of streamed output from the LLM. */
export interface StreamChunk {
  /** The incremental text delta for this chunk. */
  text: string;
  /** True if this is the final chunk (stream is done). */
  done: boolean;
}

/** Options passed to a chat completion request. */
export interface ChatOptions {
  /** The model identifier, resolved by `resolveModelId()` in client.ts. */
  model: string;
  /** Maximum tokens to generate. Omit for provider default. */
  maxTokens?: number;
  /** Temperature (0.0 – 2.0). Omit for provider default. */
  temperature?: number;
  /** If true, stream the response. Default: true. */
  stream?: boolean;
  /**
   * Reasoning effort, for providers that expose it (currently Anthropic's
   * `output_config.effort`). Omit to use the model's own default — Haiku 5.5
   * and Opus 5.5 default to "medium", most others to "high".
   *
   * This is the main quality/cost dial on current models: lower effort means
   * fewer reasoning tokens and a cheaper, faster answer. Grounded Q&A over a
   * supplied paper rarely needs more than "low" or "medium".
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Unified interface that every LLM provider must implement.
 *
 * Usage:
 *   const provider = new OllamaProvider(config);
 *   for await (const chunk of provider.chatStream(messages, options)) {
 *     appendToUI(chunk.text);
 *   }
 */
export interface ILLMProvider {
  /** Human-readable provider name (e.g. "Ollama", "Google Gemini"). */
  readonly name: string;

  /** Whether this provider sends data to a cloud API (vs. local). */
  readonly isCloud: boolean;

  /**
   * Sends a chat completion request and returns the full response.
   * Prefer chatStream() for user-facing interactions.
   */
  chat(messages: LLMMessage[], options: ChatOptions): Promise<string>;

  /**
   * Sends a chat completion request and yields streamed response chunks.
   * The final chunk has `done: true`.
   */
  chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /**
   * Tests connectivity to the provider.
   * Returns true if the provider is reachable and configured correctly.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Configuration for an LLM provider, loaded from Zotero.Prefs.
 */
export interface ProviderConfig {
  provider: "ollama" | "gemini" | "openai" | "anthropic" | "custom";
  apiKey?: string;
  endpoint?: string;
  model: string;
}
