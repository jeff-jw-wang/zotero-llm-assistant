/**
 * Markdown export utility for conversation history.
 *
 * `exportConversationAsMarkdown()` is a pure function — no Zotero dependency,
 * no side effects. It converts a ConversationRecord into formatted Markdown
 * suitable for saving or sharing.
 *
 * Chunk citation markers `[c.xxxxxxxx]` in assistant messages are converted
 * to human-readable page references `[p.X–Y]` using stored sourceChunks.
 *
 * @module utils/export
 */
import type { ConversationRecord, SourceChunkRef } from "../modules/storage/db";

/**
 * Exports a ConversationRecord as Markdown text.
 *
 * Format:
 *   # Conversation: {paperTitle}
 *   _Exported on {date}_
 *
 *   ### User (timestamp)
 *   {content}
 *
 *   ### Assistant (timestamp)
 *   {content}
 *   Sources: [p.3–5], [p.12]
 *
 * @param record - The conversation record to export.
 * @param paperTitle - The title of the paper (shown in the header).
 * @returns Formatted Markdown string.
 */
export function exportConversationAsMarkdown(
  record: ConversationRecord,
  paperTitle: string,
): string {
  const lines: string[] = [];

  // Header.
  lines.push(`# Conversation: ${paperTitle}`);
  lines.push(`_Exported on ${new Date().toISOString().slice(0, 10)}_`);
  lines.push("");

  if (record.messages.length === 0) {
    lines.push("_No messages in this conversation._");
    return lines.join("\n");
  }

  for (const msg of record.messages) {
    if (msg.role === "system") continue; // Skip system messages in export.

    const roleLabel = msg.role === "user" ? "User" : "Assistant";
    const timestamp = msg.timestamp
      ? new Date(msg.timestamp).toLocaleString()
      : "";

    lines.push(`### ${roleLabel}${timestamp ? ` (${timestamp})` : ""}`);
    lines.push("");

    // Convert chunk citation markers to page references.
    let content = msg.content;
    if (msg.role === "assistant" && msg.sourceChunks) {
      content = replaceChunkCitations(content, msg.sourceChunks);
    }

    lines.push(content);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Replaces `[c.xxxxxxxx]` chunk citation markers with `[p.X–Y]` page references.
 *
 * @param text - Text with chunk citation markers.
 * @param sourceChunks - Source chunk references for this message.
 * @returns Text with human-readable page references.
 */
function replaceChunkCitations(
  text: string,
  sourceChunks: SourceChunkRef[],
): string {
  // Build a lookup map: chunkId → SourceChunkRef.
  const chunkMap = new Map<string, SourceChunkRef>();
  for (const chunk of sourceChunks) {
    chunkMap.set(chunk.chunkId, chunk);
  }

  // Replace [c.ID] markers.
  return text.replace(/\[c\.([\w-]+)\]/g, (_match, chunkId: string) => {
    const ref = chunkMap.get(chunkId);
    if (!ref) return `[c.${chunkId}]`; // Keep original if not found.

    if (ref.pageStart === ref.pageEnd) {
      return `[p.${ref.pageStart}]`;
    }
    return `[p.${ref.pageStart}–${ref.pageEnd}]`;
  });
}
