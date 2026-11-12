/**
 * Consuming a provider's streamed response, independent of any UI.
 *
 * Kept free of DOM and Zotero dependencies so the ordering rules below can be
 * unit-tested with a hand-written generator.
 *
 * @module modules/llm/stream
 */
import type { StreamChunk, TokenUsage } from "./types";

/** Callbacks fired while a stream is consumed. All are optional. */
export interface StreamHandlers {
  /**
   * Fired once, immediately before the first {@link StreamHandlers.onText},
   * when the first piece of answer text arrives. This is the moment to remove
   * a "waiting" indicator.
   *
   * It is deliberately *not* fired by the first stream event. Providers send
   * events that carry no text — a usage report before the answer starts, and
   * nothing at all while a model is thinking — and clearing the indicator on
   * those leaves the user looking at an empty bubble for the whole pause.
   */
  onFirstText?: () => void;
  /** Fired for each chunk that carries text, with the full text so far. */
  onText?: (fullText: string) => void;
}

/** True when a chunk carries answer text (as opposed to usage or keep-alive). */
export function hasAnswerText(chunk: StreamChunk): boolean {
  return typeof chunk.text === "string" && chunk.text.length > 0;
}

/**
 * Drains a chat stream, accumulating text and token usage.
 *
 * Usage arrives incrementally — input and cache counts early, output counts
 * at the end — so reports are merged rather than replaced.
 *
 * @returns The full text, merged usage (if any was reported), and whether any
 *   text arrived at all.
 */
export async function consumeChatStream(
  stream: AsyncIterable<StreamChunk>,
  handlers: StreamHandlers = {},
): Promise<{
  text: string;
  usage?: TokenUsage;
  sawText: boolean;
  stopReason?: string;
}> {
  let text = "";
  let usage: TokenUsage | undefined;
  let sawText = false;
  let stopReason: string | undefined;

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = { ...(usage ?? {}), ...chunk.usage };
    }
    if (chunk.stopReason) stopReason = chunk.stopReason;
    if (hasAnswerText(chunk)) {
      if (!sawText) {
        sawText = true;
        handlers.onFirstText?.();
      }
      text += chunk.text;
      handlers.onText?.(text);
    }
    if (chunk.done) break;
  }

  return {
    text,
    ...(usage && { usage }),
    sawText,
    ...(stopReason && { stopReason }),
  };
}

/**
 * Explains an answer that needs explaining: a refusal, an answer cut off at
 * the output limit, or no answer at all. Returns `undefined` for a normal
 * answer.
 *
 * Without this a refusal or an empty completion rendered as a blank bubble,
 * with nothing to tell the user whether to wait, retry or rephrase.
 *
 * @param text - The answer text received, possibly empty.
 * @param stopReason - The provider's stop reason, if reported. Understands
 *   Anthropic's `refusal` and `max_tokens`; anything else is treated as a
 *   normal stop.
 */
export function describeStop(
  text: string,
  stopReason?: string,
): string | undefined {
  const empty = text.trim().length === 0;

  if (stopReason === "refusal") {
    return empty
      ? "The model declined to answer this request. Try rephrasing the question."
      : "The model stopped partway and declined to continue. The answer above is incomplete.";
  }

  if (stopReason === "max_tokens") {
    return empty
      ? "The model reached its output limit before writing an answer, most " +
          "likely while thinking. Try a lower Effort setting, or a narrower question."
      : "The answer was cut off at the model's output limit. Ask it to continue, or ask a narrower question.";
  }

  if (empty) {
    return "The model returned an empty answer. Try asking again, or check the model chosen in Settings.";
  }

  return undefined;
}
