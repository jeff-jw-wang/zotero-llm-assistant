/**
 * Wording of the short notes the reader panel shows about what was sent.
 *
 * Kept apart from the panel so the text can be unit-tested without a DOM.
 *
 * @module modules/rag/notes
 */

/** The pipeline stats these notes read. */
interface SelectionStats {
  totalPages: number;
  totalChunks: number;
  selectedChunks: number;
  supplementChunks: number;
}

/**
 * Says how much of a large paper was sent, for chunk-rag mode.
 *
 * @example "Paper: 212 pages, 480 sections. Sent 12 of them (3 picked for this question)."
 */
export function describeSelection(stats: SelectionStats): string {
  const picked =
    stats.supplementChunks > 0
      ? ` (${stats.supplementChunks} picked for this question)`
      : "";
  return (
    `Paper: ${stats.totalPages} pages, ${stats.totalChunks} sections. ` +
    `Sent ${stats.selectedChunks} of them${picked}.`
  );
}

/** Says that earlier conversation was left out to fit the model's context. */
export function describeDroppedHistory(dropped: number): string {
  return (
    `Left out ${dropped} earlier message${dropped === 1 ? "" : "s"} of this ` +
    "conversation so the request fits the model's context."
  );
}
