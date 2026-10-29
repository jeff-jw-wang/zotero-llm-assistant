/**
 * Lightweight token counter — estimates token count without a full tokenizer.
 *
 * Accurate tokenizers like tiktoken require large WASM files (~1MB) unsuitable
 * for a plugin bundle. This approximation (4 chars ≈ 1 token for English prose)
 * is sufficient for deciding when to truncate paper context before LLM calls.
 * The estimate errs slightly high (safe side: we truncate earlier than necessary).
 *
 * **Token budgets no longer live here.** This module used to own a
 * `MODEL_TOKEN_CAPS` table keyed on exact model IDs, with an 8K fallback for
 * anything it did not recognise — so every model released after the table was
 * last edited silently received an 8K input budget regardless of its real
 * context window. Budgets now come from `modules/llm/models.ts`, which asks
 * the provider and only falls back to inference. See
 * `resolveInputBudget()` there and `getInputBudget()` in `modules/llm/client.ts`.
 *
 * @module utils/tokens
 */

const CHARS_PER_TOKEN = 4;

/** Estimates the number of tokens in a string. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Average chunk size in tokens — used for dynamic topK calculation.
 * Each chunk targets ~512 tokens; this constant matches chunker.ts
 * TARGET_CHUNK_CHARS (2048 chars / 4 chars-per-token).
 */
export const AVG_CHUNK_TOKENS = 512;

/**
 * Returns the maximum number of chunks to select for a given input budget.
 *
 * Dynamic topK = floor(budget / avgChunkTokens). Caps the NUMBER of chunks in
 * addition to the token budget, preventing the LLM from receiving a flood of
 * tiny chunks that individually fit in the budget but together overwhelm the
 * prompt structure. Minimum 1 so at least one chunk is always included.
 *
 * @param inputBudget - Usable input tokens, from `resolveInputBudget()`.
 *
 * @example
 *   getTopKCapForBudget(16_000)   // 31
 *   getTopKCapForBudget(92_000)   // 179  (Haiku 5.5 under its 100K price band)
 */
export function getTopKCapForBudget(inputBudget: number): number {
  return Math.max(1, Math.floor(inputBudget / AVG_CHUNK_TOKENS));
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
