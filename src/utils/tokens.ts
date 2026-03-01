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

/** Maximum usable tokens per provider model (input context budget). */
export const MODEL_TOKEN_CAPS: Record<string, number> = {
  // OpenAI
  "gpt-4o-mini": 32_000,   // conservative; actual 128K but large PDFs get expensive
  "gpt-4o": 32_000,
  // Gemini
  "gemini-2.0-flash": 64_000,
  "gemini-1.5-flash": 64_000,
  "gemini-1.5-pro": 64_000,
  // Anthropic
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
