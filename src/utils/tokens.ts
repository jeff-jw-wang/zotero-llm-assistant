/**
 * Lightweight token counter — estimates token count without a full tokenizer.
 *
 * Accurate tokenizers like tiktoken require large WASM files (~1MB) unsuitable
 * for a plugin bundle. This approximation (4 chars ≈ 1 token for English prose)
 * is sufficient for deciding when to truncate paper context before LLM calls.
 * The estimate errs slightly high (safe side: we truncate earlier than necessary).
 *
 * Per-model token caps:
 *   - GPT-4o-mini: 128K context, reserve 4K for response → 124K usable
 *   - Gemini 2.0 Flash: 1M context, reserve 8K for response → practical cap at 64K
 *   - Ollama models: vary; conservative default of 8K
 *
 * @module utils/tokens
 */

const CHARS_PER_TOKEN = 4;

/** Estimates the number of tokens in a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Maximum usable tokens per provider model (input context budget).
 *
 * Caps are conservative — well below the hard API limits — to:
 *   - Stay under free-tier quota for Gemini (60 req/min, 1M tokens/min)
 *   - Control cost for paid providers (OpenAI, Anthropic)
 *   - Give Ollama enough context without hitting VRAM limits
 *
 * Free Gemini note (#10): each full-paper request at 64K tokens quickly
 * exhausts the per-minute quota. Cap at 16K (≈ 31 chunks of ~512 tokens)
 * so even rapid back-and-forth stays under the free limit.
 */
export const MODEL_TOKEN_CAPS: Record<string, number> = {
  // OpenAI (128K context; 32K cap controls cost on paid API)
  "gpt-4o-mini": 32_000,
  "gpt-4o": 32_000,
  // Gemini (1M context; 16K cap to stay under free-tier per-minute quota)
  "gemini-2.0-flash": 16_000,
  "gemini-1.5-flash": 16_000,
  "gemini-1.5-pro": 16_000,
  // Anthropic (200K context; 32K cap controls cost on paid API)
  "claude-sonnet-4-6": 32_000,
  "claude-haiku-4-5-20251001": 32_000,
};

/** Default cap for Ollama and unknown models. */
const DEFAULT_TOKEN_CAP = 8_000;

/** Returns the token cap for a given model identifier. */
export function getTokenCap(model: string): number {
  return MODEL_TOKEN_CAPS[model] ?? DEFAULT_TOKEN_CAP;
}

/**
 * Average chunk size in tokens — used for dynamic topK calculation.
 * Each chunk targets ~512 tokens; this constant matches chunker.ts TARGET_TOKENS.
 */
export const AVG_CHUNK_TOKENS = 512;

/**
 * Returns the maximum number of chunks to select for a given model.
 *
 * Dynamic topK = floor(contextBudget / avgChunkTokens).
 * Caps the NUMBER of chunks in addition to the token budget, preventing the
 * LLM from receiving a flood of tiny chunks that individually fit in the budget
 * but together overwhelm the prompt structure. Minimum 1 to always include
 * at least one chunk.
 *
 * @example
 *   getTopKCap("gemini-2.0-flash")  // floor(16000/512) = 31
 *   getTopKCap("gpt-4o-mini")       // floor(32000/512) = 62
 *   getTopKCap("llama3.2")          // floor(8000/512)  = 15
 */
export function getTopKCap(model: string): number {
  return Math.max(1, Math.floor(getTokenCap(model) / AVG_CHUNK_TOKENS));
}

/**
 * Truncates text to fit within a token budget.
 * Splits by paragraphs, adding each until the budget is exhausted.
 *
 * @returns The truncated text and whether truncation occurred.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }

  const paragraphs = text.split(/\n{2,}/);
  const kept: string[] = [];
  let used = 0;

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);
    if (used + paraTokens > maxTokens) break;
    kept.push(para);
    used += paraTokens;
  }

  return { text: kept.join("\n\n"), truncated: true };
}
