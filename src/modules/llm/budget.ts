/**
 * Prompt planning: how much of a model's context each part of a request may use.
 *
 * Pure — no network, no preferences, no Zotero — so every boundary is unit
 * tested (`test/budget.test.ts`).
 *
 * This replaces the rule "send whatever fits the window", which had three
 * problems (docs/MODERNIZATION_PLAN_2026.md §4, D5–D7):
 *
 *   - **D5.** Only an output reserve was subtracted from the window. The
 *     system prompt, the conversation history and the question came on top of
 *     a document block that had already filled the budget, so a local prompt
 *     could exceed the context Ollama allocated and be silently truncated.
 *   - **D6.** Nothing bounded cost. On a 1M-token model one question could
 *     carry ~990K tokens of retrieved text.
 *   - **D7.** Sizes are estimated at 4 characters per token, which runs low.
 *     Claude's current tokenizer counts about 30% more, enough to push an
 *     "88K" request over Haiku's 100K price band.
 *
 * ## Units
 *
 * Everything here is in **estimated tokens** — `estimateTokens()` units,
 * characters ÷ 4 — because that is the only measure the plugin can compute.
 * The gap to real tokens is handled once, in {@link tokenizerFactor}: the real
 * allowance is divided by the factor to get the estimated allowance.
 *
 * ## Priorities
 *
 * The document block must be **the same on every turn** of a conversation, or
 * prompt caching (cloud) and prompt-state reuse (Ollama) are lost. So the
 * document limits depend only on the model and the settings, never on the
 * conversation. What gives way as a conversation grows is the history:
 *
 *   document  >  question  >  per-question supplement  >  history (oldest first)
 *
 * @module modules/llm/budget
 */
import type { ProviderName } from "../../prefs";
import type { LLMMessage } from "./types";
import { estimateTokens } from "../../utils/tokens";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default largest document sent whole to a cloud model, in estimated tokens.
 * A long journal article is 15–25K; this admits a short thesis chapter and
 * stops well short of a whole book. On Sonnet-class pricing one uncached
 * request of this size is about ten cents.
 */
export const DEFAULT_CLOUD_WHOLE_PAPER_MAX = 60_000;

/**
 * Default largest retrieved-sections context for a cloud model, in estimated
 * tokens. v0.1.1b capped this at 32K; the uncapped branch allowed ~990K.
 */
export const DEFAULT_CLOUD_RETRIEVED_MAX = 24_000;

/**
 * Share of the Ollama context size given to the document by default, for
 * both modes. The rest holds the reply, the conversation and the tokenizer
 * margin. Sized for a machine with no usable GPU, where reading the prompt
 * dominates the wait: a smaller document is a faster first answer.
 */
export const LOCAL_DOCUMENT_SHARE = 0.4;

/**
 * Real tokens per estimated token, for models whose tokenizer is known to
 * count well above the 4-characters-per-token estimate.
 */
const CLAUDE_TOKENIZER_FACTOR = 1.35;

/**
 * Real tokens per estimated token assumed everywhere else: the estimate runs
 * low on academic text (equations, citations, names), so 15% is held back.
 */
const DEFAULT_TOKENIZER_FACTOR = 1.15;

/**
 * Estimated tokens always kept free for the system prompt, the question and
 * some conversation, however large the document limits are set.
 */
const CONVERSATION_RESERVE = 2_000;

/** …but never more than this share of a small context. */
const CONVERSATION_RESERVE_SHARE = 0.2;

/** Most estimated tokens the per-question supplement may use. */
const SUPPLEMENT_MAX_TOKENS = 1_800;

/** …and never more than this share of the retrieved-context limit. */
const SUPPLEMENT_SHARE = 0.25;

/** Estimated per-message framing overhead (role markers, wrappers). */
const MESSAGE_OVERHEAD_TOKENS = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inputs to {@link planPrompt}. */
export interface PromptPlanInput {
  provider: ProviderName;
  modelId: string;
  /**
   * Real tokens available for the whole prompt: the context window (after any
   * price-band cap, and after the Ollama context size) minus the output
   * reserve. This is `budget` from `resolveInputBudget()`.
   */
  inputBudget: number;
  /** Configured Ollama context size, for the local default limits. */
  localNumCtx?: number;
  /**
   * User setting: largest document to send whole, in estimated tokens.
   * `0` or `undefined` means "use the default for this provider".
   */
  wholePaperLimit?: number;
  /**
   * User setting: largest retrieved-sections context, in estimated tokens.
   * `0` or `undefined` means "use the default for this provider".
   */
  retrievedLimit?: number;
}

/** Allowances for one request, all in estimated tokens. */
export interface PromptPlan {
  /** Real tokens per estimated token assumed for this model. */
  factor: number;
  /** Estimated tokens the entire prompt may use. */
  promptCapacity: number;
  /** Largest document that is sent whole. Larger documents use retrieval. */
  wholePaperMax: number;
  /** Largest retrieved context: {@link coreMax} + {@link supplementMax}. */
  retrievedMax: number;
  /** Largest stable core of retrieved sections (cached prefix). */
  coreMax: number;
  /** Largest per-question supplement (outside the cached prefix). */
  supplementMax: number;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Real tokens per estimated token for a model.
 *
 * 1.35 for Claude models: the current tokenizer counts roughly 30% more tokens
 * than characters ÷ 4 (Anthropic's API reference, 2026-10-06). Applied to
 * every Claude model rather than a list of IDs, because under-counting is the
 * expensive direction — it crosses Haiku's 100K price band. 1.15 elsewhere.
 */
export function tokenizerFactor(provider: ProviderName, modelId: string): number {
  if (provider === "anthropic" || /^claude-/.test(modelId.trim().toLowerCase())) {
    return CLAUDE_TOKENIZER_FACTOR;
  }
  return DEFAULT_TOKENIZER_FACTOR;
}

function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : undefined;
}

/**
 * Computes the allowances for a request.
 *
 * The document limits are the user's setting (or the provider default),
 * clamped so that the system prompt, the question and some conversation
 * always still fit. They do **not** depend on the conversation, so the same
 * document block is produced on every turn.
 */
export function planPrompt(input: PromptPlanInput): PromptPlan {
  const factor = tokenizerFactor(input.provider, input.modelId);
  const promptCapacity = Math.max(0, Math.floor(input.inputBudget / factor));

  const reserve = Math.min(
    CONVERSATION_RESERVE,
    Math.floor(promptCapacity * CONVERSATION_RESERVE_SHARE),
  );
  const documentCeiling = Math.max(0, promptCapacity - reserve);

  const isLocal = input.provider === "ollama";
  const localDefault = positive(input.localNumCtx)
    ? Math.floor(positive(input.localNumCtx)! * LOCAL_DOCUMENT_SHARE)
    : Math.floor(documentCeiling * LOCAL_DOCUMENT_SHARE);

  const wholeLimit =
    positive(input.wholePaperLimit) ??
    (isLocal ? localDefault : DEFAULT_CLOUD_WHOLE_PAPER_MAX);
  const retrievedLimit =
    positive(input.retrievedLimit) ??
    (isLocal ? localDefault : DEFAULT_CLOUD_RETRIEVED_MAX);

  const wholePaperMax = Math.min(wholeLimit, documentCeiling);
  const retrievedMax = Math.min(retrievedLimit, documentCeiling);
  const supplementMax = Math.min(
    SUPPLEMENT_MAX_TOKENS,
    Math.floor(retrievedMax * SUPPLEMENT_SHARE),
  );

  return {
    factor,
    promptCapacity,
    wholePaperMax,
    retrievedMax,
    coreMax: retrievedMax - supplementMax,
    supplementMax,
  };
}

// ---------------------------------------------------------------------------
// Measuring and fitting
// ---------------------------------------------------------------------------

/** Estimated tokens of one message, including framing overhead. */
export function messageTokens(message: Pick<LLMMessage, "content">): number {
  return estimateTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
}

/** Estimated tokens of a whole message array. */
export function promptTokens(messages: ReadonlyArray<Pick<LLMMessage, "content">>): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/**
 * Keeps the most recent conversation messages that fit in `maxTokens`.
 *
 * Messages are kept whole and in order; older ones are dropped first. The
 * result never begins with an assistant message, so a dropped question does
 * not leave its answer dangling at the top of the conversation.
 *
 * @param history - Earlier messages, oldest first, without the current question.
 * @param maxTokens - Estimated tokens the history may use. `<= 0` keeps none.
 */
export function fitHistory<T extends Pick<LLMMessage, "role" | "content">>(
  history: readonly T[],
  maxTokens: number,
): T[] {
  const kept: T[] = [];
  let used = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const cost = messageTokens(history[i]!);
    if (used + cost > maxTokens) break;
    kept.unshift(history[i]!);
    used += cost;
  }

  while (kept.length > 0 && kept[0]!.role === "assistant") {
    kept.shift();
  }

  return kept;
}
