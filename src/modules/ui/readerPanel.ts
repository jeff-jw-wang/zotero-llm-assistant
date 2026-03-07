/**
 * Reader panel — registers the LLM Assistant tab in Zotero's PDF reader sidebar.
 *
 * This is the primary UI surface. It appears as a collapsible section in the
 * item pane when a PDF is open in the reader. The panel is disabled in the
 * library item info pane (tabType !== "reader").
 *
 * Panel lifecycle:
 *   onInit       - called once when the section is first created for an item
 *   onItemChange - called when the selected item changes; enables/disables panel
 *   onRender     - called to (re-)render the panel content
 *   onDestroy    - called when the panel is removed
 *
 * Flow per question:
 *   1. Show onboarding if first run
 *   2. Build RAG context via pipeline (extract → chunk → score → select)
 *   3. Check privacy (block cloud call if restricted)
 *   4. Call LLM with streaming
 *   5. Render streamed response; parse chunk citations against whitelist
 *   6. Save conversation + cited source chunks to IndexedDB
 *
 * Citation safety:
 *   Only chunk IDs present in chunkWhitelist (the chunks actually sent to the
 *   LLM) are rendered as clickable page-jump links. Unknown [c.ID] markers are
 *   shown as struck-through text ("Citation not in source"). Legacy [p.N]
 *   markers from Phase A conversations are rendered as styled (non-clickable)
 *   text for backward compatibility.
 *
 * @module modules/ui/readerPanel
 * @see docs/ARCHITECTURE.md
 */
import { config } from "../../../package.json";
import { getLocaleID } from "../../utils/locale";
import { h } from "../../utils/dom";
import { isOnboardingDone, renderOnboarding } from "./onboarding";
import { renderPrivacyToggle } from "./privacyToggle";
import {
  buildRAGContext,
  type ChunkMeta,
} from "../rag/pipeline";
import { makeChunkCiteRegex, CHUNK_ID_PATTERN } from "../rag/chunker";
import {
  createProvider,
  checkPrivacy,
  getChatOptions,
} from "../llm/client";
import { OllamaProvider } from "../llm/providers/ollama";
import {
  appendMessage as dbAppendMessage,
  getConversation,
  type SourceChunkRef,
} from "../storage/db";
import { estimateTokens } from "../../utils/tokens";
import * as prefs from "../../prefs";

/** Timeout boundary for non-critical DB calls in UI code paths. */
const DB_OP_TIMEOUT_MS = 2_000;
const OLLAMA_STATUS_NOTE_ID = "llm-ollama-status-note";
const MAX_CONTEXT_HISTORY_MESSAGES = 6;

// ---------------------------------------------------------------------------
// Panel registration
// ---------------------------------------------------------------------------

/**
 * Registers the LLM Assistant section in the reader item pane.
 * Called once from hooks.onStartup().
 */
export function registerReaderPanel(): void {
  Zotero.ItemPaneManager.registerSection({
    paneID: "llm-assistant",
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("assistant-panel-head"),
      icon: "chrome://zotero/skin/16/universal/book.svg",
    },
    sidenav: {
      l10nID: getLocaleID("assistant-panel-sidenav"),
      icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
    },
    bodyXHTML: `
      <html:div id="llm-root" style="display:flex;flex-direction:column;height:400px;min-height:200px;max-height:800px;resize:vertical;overflow:hidden;font-family:system-ui,sans-serif;font-size:13px;">
        <html:div id="llm-header" style="display:flex;justify-content:space-between;align-items:center;padding:4px 8px;border-bottom:1px solid #ddd;min-height:26px;flex-shrink:0;">
          <html:span style="font-weight:600;color:#333;">LLM Assistant</html:span>
          <html:div style="display:flex;align-items:center;gap:6px;">
            <html:div id="llm-provider-select"></html:div>
            <html:div id="llm-privacy-toggle"></html:div>
          </html:div>
        </html:div>
        <html:div id="llm-body" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;"></html:div>
      </html:div>
    `,
    onInit: ({ body, item }) => {
      ztoolkit.log("LLM Assistant panel init for item:", item?.id);
    },
    onItemChange: ({ item, setEnabled, tabType }) => {
      // Only enable in the reader tab (PDF viewer), not the library info pane.
      setEnabled(tabType === "reader");
      // Note: we intentionally do NOT clear the pipeline's extraction/chunk
      // cache here. Cache entries are content-hashed and deterministic for
      // the same PDF, so switching between papers benefits from caching.
      // The cache is module-scoped and lives for the session; it's cleared
      // on plugin shutdown or can be cleared per-item via clearItemCache(id)
      // if a PDF is re-indexed.
      return true;
    },
    onRender: ({ body, item }) => {
      if (!item) return;
      renderPanel(body, item);
    },
    onToggle: ({ item }) => {
      ztoolkit.log("LLM Assistant panel toggled for item:", item?.id);
    },
    onDestroy: () => {
      ztoolkit.log("LLM Assistant panel destroyed");
    },
  });
}

// ---------------------------------------------------------------------------
// Panel rendering
// ---------------------------------------------------------------------------

function renderPanel(body: HTMLElement, item: Zotero.Item): void {
  const doc = body.ownerDocument;
  const llmBody = body.querySelector<HTMLElement>("#llm-body");
  if (!llmBody) {
    ztoolkit.log("renderPanel: #llm-body not found in body element");
    return;
  }

  try {
    if (!isOnboardingDone()) {
      renderOnboarding(llmBody, doc!, () => renderChatUI(llmBody, doc!, item));
      return;
    }

    renderChatUI(llmBody, doc!, item);
  } catch (err: any) {
    // Surface errors visibly in the panel so they don't silently disappear.
    ztoolkit.log("renderPanel error:", err);
    llmBody.innerHTML = "";
    const errEl = h(doc!,"div");
    errEl.style.cssText =
      "padding:16px;color:#c00;font-size:12px;white-space:pre-wrap;";
    errEl.textContent = `⚠ Panel render error:\n${err?.message ?? String(err)}\n\nCheck Error Console for details.`;
    llmBody.appendChild(errEl);
  }
}

// ---------------------------------------------------------------------------
// Chat UI
// ---------------------------------------------------------------------------

const RENDERED_ATTR = "data-rendered-item-id";

function renderChatUI(
  container: HTMLElement,
  doc: Document,
  item: Zotero.Item,
): void {
  // -----------------------------------------------------------------------
  // Phase 1: Header refresh — ALWAYS runs for provider/privacy state.
  // This ensures the provider selector and privacy toggle stay current even
  // on guarded same-item rerenders (e.g. tab switch back to same PDF).
  // -----------------------------------------------------------------------
  const privacyEl = container
    .closest("#llm-root")
    ?.querySelector<HTMLElement>("#llm-privacy-toggle");
  if (privacyEl) {
    renderPrivacyToggle(privacyEl, doc, item.id).catch((err) => {
      ztoolkit.log("renderPrivacyToggle() failed:", (err as Error)?.message ?? err);
    });
  }

  const providerEl = container
    .closest("#llm-root")
    ?.querySelector<HTMLElement>("#llm-provider-select");
  if (providerEl) {
    renderProviderSelector(providerEl, doc, () => {
      if (privacyEl) {
        renderPrivacyToggle(privacyEl, doc, item.id).catch((err) => {
          ztoolkit.log(
            "renderPrivacyToggle() after provider change failed:",
            (err as Error)?.message ?? err,
          );
        });
      }
      // Resolve messages container from DOM at call time — NOT from a closure
      // over the late-declared `messages` variable. This is safe on guarded
      // rerenders because #llm-messages already exists from the prior render.
      const liveMessages = container.querySelector<HTMLElement>("#llm-messages");
      if (liveMessages) {
        void notifyOllamaIfUnavailable(liveMessages, doc);
      }
    });
  }

  // -----------------------------------------------------------------------
  // Phase 2: Chat body init — skip if same item already rendered.
  // Only the destructive container.innerHTML="" + message rebuild is guarded.
  // -----------------------------------------------------------------------
  if (container.getAttribute(RENDERED_ATTR) === String(item.id) && container.hasChildNodes()) {
    return; // Messages, input bar, scroll position all preserved
  }
  container.setAttribute(RENDERED_ATTR, String(item.id));
  container.innerHTML = "";

  // Message list
  const messages = h(doc,"div");
  messages.id = "llm-messages";
  messages.style.cssText =
    "flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px;" +
    "user-select:text;-moz-user-select:text;";

  // Input bar
  const inputBar = h(doc,"div");
  inputBar.style.cssText =
    "display:flex;padding:6px;border-top:1px solid #ddd;gap:4px;flex-shrink:0;";

  const input = h(doc,"textarea") as HTMLTextAreaElement;
  (input as any).rows = 1;
  input.placeholder = "Ask about this paper\u2026";
  input.style.cssText =
    "flex:1;padding:6px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;" +
    "resize:none;overflow-y:hidden;line-height:1.4;font-family:inherit;";

  // Auto-resize textarea up to ~5 rows, then show internal scrollbar.
  const TEXTAREA_MAX_HEIGHT = 103; // ~5 rows: 13px * 1.4 * 5 + 12px padding
  const autoResizeInput = () => {
    input.style.height = "auto";
    input.style.overflowY = "hidden";
    if (input.scrollHeight > TEXTAREA_MAX_HEIGHT) {
      input.style.height = TEXTAREA_MAX_HEIGHT + "px";
      input.style.overflowY = "auto";
    } else {
      input.style.height = input.scrollHeight + "px";
    }
  };
  input.addEventListener("input", autoResizeInput);

  const sendBtn = h(doc,"button") as HTMLButtonElement;
  sendBtn.textContent = "Send";
  sendBtn.style.cssText =
    "padding:6px 12px;background:#4a90d9;color:white;border:none;border-radius:4px;cursor:pointer;font-size:13px;flex-shrink:0;";

  inputBar.appendChild(input);
  inputBar.appendChild(sendBtn);

  container.style.cssText =
    "display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;";
  container.appendChild(messages);
  container.appendChild(inputBar);

  // If Ollama is selected, proactively show setup guidance when unreachable.
  void notifyOllamaIfUnavailable(messages, doc);

  // Load conversation history (non-blocking — DB failures degrade to empty state).
  withTimeout(
    getConversation(item.id),
    DB_OP_TIMEOUT_MS,
    "load conversation history",
  ).then((record) => {
    if (record && record.messages.length > 0) {
      for (const msg of record.messages) {
        if (msg.role === "system") continue;

        if (msg.role === "assistant") {
          // Render assistant messages through the citation parser so
          // clickable chunk links / legacy page markers display correctly.
          const bubble = h(doc,"div");
          bubble.style.cssText = BUBBLE_STYLE_ASSISTANT;
          messages.appendChild(bubble);

          // Rebuild a chunkWhitelist from stored sourceChunks (Phase B
          // messages) or use an empty map (Phase A legacy messages — the
          // fallback page regex will handle [p.N] markers as styled text).
          const whitelist = new Map<string, ChunkMeta>();
          if (msg.sourceChunks) {
            for (const ref of msg.sourceChunks) {
              whitelist.set(ref.chunkId, {
                pageStart: ref.pageStart,
                pageEnd: ref.pageEnd,
                excerpt: ref.excerpt,
              });
            }
          }
          renderResponseWithCitations(bubble, doc, msg.content, whitelist, item);
          appendCopyButton(bubble, doc, () => msg.content);
        } else {
          appendBubble(messages, doc, "user", msg.content);
        }
      }
      scrollToBottom(messages); // force — just loaded history
    } else {
      const placeholder = h(doc,"p");
      placeholder.style.cssText =
        "color:#999;text-align:center;margin-top:20px;font-size:13px;";
      placeholder.textContent = "Ask a question about this paper.";
      messages.appendChild(placeholder);
    }
  }).catch((dbErr: any) => {
    ztoolkit.log("Failed to load conversation history:", dbErr?.message ?? dbErr);
    // Show placeholder as if no history exists.
    const placeholder = h(doc,"p");
    placeholder.style.cssText =
      "color:#999;text-align:center;margin-top:20px;font-size:13px;";
    placeholder.textContent = "Ask a question about this paper.";
    messages.appendChild(placeholder);
  });

  // Send handler
  const handleSend = async () => {
    const question = input.value.trim();
    if (!question || sendBtn.disabled) return;

    input.value = "";
    input.style.height = "auto"; // reset textarea to 1 row
    sendBtn.disabled = true;
    sendBtn.textContent = "…";

    // Remove placeholder
    const placeholder = messages.querySelector("p");
    if (placeholder) placeholder.remove();

    // Capture sticky-scroll state BEFORE appending the user bubble.
    // This mutable object is threaded through handleQuestion so the
    // finally block and all intermediate scrolls honor the user's
    // scroll position at send time. The streaming loop updates .stick
    // before each chunk in case the user scrolls back down mid-stream.
    const scrollState = { stick: isNearBottom(messages) };

    appendBubble(messages, doc, "user", question);
    scrollToBottom(messages, scrollState.stick);

    try {
      // Fire-and-forget: persistence must never block question handling.
      void withTimeout(
        dbAppendMessage(item.id, {
          role: "user",
          content: question,
          timestamp: new Date().toISOString(),
        }),
        DB_OP_TIMEOUT_MS,
        "save user message",
      ).catch((dbErr: any) => {
        ztoolkit.log("Failed to save user message to DB:", dbErr?.message ?? dbErr);
      });

      await handleQuestion(question, item, messages, doc, scrollState);
    } catch (err: any) {
      const msg = friendlyErrorMessage(err);
      appendBubble(messages, doc, "assistant", `⚠ ${msg}`);
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = "Send";
      scrollToBottom(messages, scrollState.stick);
    }
  };

  sendBtn.addEventListener("click", handleSend);
  // Ctrl+Enter (Cmd+Enter on Mac) sends; plain Enter inserts newline.
  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (ke.ctrlKey || ke.metaKey)) {
      ke.preventDefault();
      handleSend();
    }
  });
}

// ---------------------------------------------------------------------------
// Question handling
// ---------------------------------------------------------------------------

async function handleQuestion(
  question: string,
  item: Zotero.Item,
  messages: HTMLElement,
  doc: Document,
  scrollState: { stick: boolean },
): Promise<void> {
  // --- Create provider ---
  let provider;
  try {
    provider = createProvider();
  } catch (err: any) {
    appendBubble(
      messages,
      doc,
      "assistant",
      `⚙ No provider configured. ${err?.message ?? ""} Go to Settings > LLM Assistant.`,
    );
    return;
  }

  // Local provider setup check: if Ollama is selected but unreachable,
  // show explicit install/start guidance instead of generic transport errors.
  if (prefs.getActiveProvider() === "ollama") {
    const available = await provider.isAvailable();
    if (!available) {
      appendOllamaSetupGuidance(messages, doc);
      return;
    }
  }

  // --- Privacy check ---
  const privacyBlock = await checkPrivacy(provider, item.id);
  if (privacyBlock) {
    appendBubble(messages, doc, "assistant", `🔒 ${privacyBlock}`);
    return;
  }

  // --- Build RAG context via pipeline ---
  const statusNote = appendStatusNote(messages, doc, "Extracting and analysing paper\u2026", scrollState.stick);
  const options = getChatOptions();

  let fullResponse = "";
  let pipeline;
  let usedStream = true; // Flipped to false if streaming fails and we fall back to chat().

  try {
    // Build conversation history for the pipeline.
    // The user message was already saved to DB before handleQuestion was called.
    // Slice off the last entry (the current question) to avoid sending it twice:
    // buildMessages() appends the question itself as the final user message.
    // Wrapped in try/catch so DB failures degrade to empty history (the question
    // still works, just without multi-turn context).
    let history: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const record = await withTimeout(
        getConversation(item.id),
        DB_OP_TIMEOUT_MS,
        "load conversation history for context",
      );
      history = (record?.messages ?? [])
        .filter((m) => m.role !== "system")
        .slice(0, -1) // exclude the just-saved current question
        .slice(-MAX_CONTEXT_HISTORY_MESSAGES) // keep recent turns to preserve RAG context budget
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
    } catch (dbErr: any) {
      ztoolkit.log("Failed to load conversation history:", dbErr?.message ?? dbErr);
    }

    pipeline = await buildRAGContext(item, question, history, options.model);

    // Refresh sticky-scroll after the big async gap (PDF extraction + chunking
    // can take seconds). The user may have scrolled up during the wait.
    scrollState.stick = isNearBottom(messages);

    // Show system note about chunk selection — pass scrollState.stick so the
    // note scrolls into view when the user was at the bottom. Without this,
    // the note's DOM insertion can push the user past the isNearBottom threshold
    // and the subsequent re-check would falsely read "not near bottom".
    if (pipeline.stats.totalChunks > 0) {
      if (pipeline.stats.selectedChunks < pipeline.stats.totalChunks) {
        appendSystemNote(
          messages,
          doc,
          `Paper: ${pipeline.stats.totalPages} pages, ${pipeline.stats.totalChunks} chunks. Showing ${pipeline.stats.selectedChunks} most relevant.`,
          scrollState.stick,
        );
      }
    } else {
      appendSystemNote(
        messages,
        doc,
        "PDF text could not be extracted. Answering from model knowledge only.",
        scrollState.stick,
      );
    }

    // --- Stream response (with non-stream fallback if SSE fails) ---
    updateStatusNote(statusNote, `Connecting to ${provider.name}\u2026`);

    // Refresh sticky-scroll one more time — the user may have scrolled
    // during the system-note rendering or status-note update.
    scrollState.stick = isNearBottom(messages);

    const assistantBubble = h(doc,"div");
    assistantBubble.style.cssText = BUBBLE_STYLE_ASSISTANT;
    messages.appendChild(assistantBubble);
    scrollToBottom(messages, scrollState.stick);

    let firstChunk = true;

    try {
      for await (const chunk of provider.chatStream(pipeline.messages, options)) {
        if (firstChunk) {
          removeStatusNote(statusNote);
          firstChunk = false;
        }
        fullResponse += chunk.text;
        // Re-check scroll position BEFORE DOM mutation (each chunk may change height).
        scrollState.stick = isNearBottom(messages);
        renderResponseWithCitations(
          assistantBubble,
          doc,
          fullResponse,
          pipeline.chunkWhitelist,
          item,
        );
        scrollToBottom(messages, scrollState.stick);
        if (chunk.done) break;
      }
    } catch (streamErr: any) {
      if (!shouldRetryNonStream(streamErr)) {
        throw streamErr;
      }

      // Silent non-stream fallback — keep the existing "Connecting…" status note
      // so the user sees no error flash. The diagnostics footer will show "non-stream".
      usedStream = false;
      ztoolkit.log(
        "chatStream() failed; retrying without streaming:",
        (streamErr as Error)?.message ?? streamErr,
      );
      const nonStreamText = await provider.chat(pipeline.messages, {
        ...options,
        stream: false,
      });
      fullResponse = nonStreamText ?? "";
      scrollState.stick = isNearBottom(messages);
      renderResponseWithCitations(
        assistantBubble,
        doc,
        fullResponse,
        pipeline.chunkWhitelist,
        item,
      );
      scrollToBottom(messages, scrollState.stick);
      removeStatusNote(statusNote);
      firstChunk = false;
    }

    // If the stream completed without yielding any content chunks,
    // the status note is still visible — clean it up now.
    if (firstChunk) {
      removeStatusNote(statusNote);
    }

    // Add copy button AFTER streaming completes — not during, because
    // renderResponseWithCitations() does bubble.innerHTML="" on each call.
    if (fullResponse) {
      appendCopyButton(assistantBubble, doc, () => fullResponse);
    }
  } catch (err) {
    // Clean up the status note before re-throwing — the caller renders the error.
    removeStatusNote(statusNote);
    throw err;
  }

  // --- Extract cited chunks and save to DB ---
  const citedIds = parseCitedChunkIds(fullResponse);
  const sourceChunks: SourceChunkRef[] = citedIds
    .filter((id) => pipeline.chunkWhitelist.has(id))
    .map((id) => {
      const meta = pipeline.chunkWhitelist.get(id)!;
      return {
        chunkId: id,
        pageStart: meta.pageStart,
        pageEnd: meta.pageEnd,
        excerpt: meta.excerpt,
      };
    });

  // Fire-and-forget: persistence must never block UI completion.
  void withTimeout(
    dbAppendMessage(item.id, {
      role: "assistant",
      content: fullResponse,
      timestamp: new Date().toISOString(),
      sourceChunks: sourceChunks.length > 0 ? sourceChunks : undefined,
    }),
    DB_OP_TIMEOUT_MS,
    "save assistant message",
  ).catch((dbErr: any) => {
    ztoolkit.log("Failed to save assistant message to DB:", dbErr?.message ?? dbErr);
  });

  // D7: Diagnostics footer — model · host · mode · tokens.
  const totalTokens =
    estimateTokens(pipeline.messages.map((m) => m.content).join("")) +
    estimateTokens(fullResponse);
  appendSystemNote(
    messages,
    doc,
    buildDiagnosticsNote(options.model, usedStream, totalTokens),
    scrollState.stick,
  );
}

// ---------------------------------------------------------------------------
// Citation rendering
// ---------------------------------------------------------------------------

/**
 * Extracts all cited chunk IDs from LLM output, deduplicated with insertion-order
 * preservation. Pure function — no DOM dependency.
 *
 * @param text - The full LLM response text.
 * @returns Unique chunk IDs in order of first appearance.
 */
export function parseCitedChunkIds(text: string): string[] {
  const re = makeChunkCiteRegex(); // fresh instance — avoids lastIndex bugs
  const seen = new Set<string>();
  const result: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const id = match[1]!.toLowerCase(); // normalize: model may emit uppercase hex
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }

  return result;
}

/**
 * Renders LLM response text into a bubble, converting citations:
 *
 * Phase B (primary): [c.ID] chunk citations
 *   - ID in chunkWhitelist → clickable [pp.X-Y] link with excerpt tooltip
 *   - ID not in whitelist → struck-through text ("Citation not in source")
 *
 * Phase A (fallback): [p.N] page citations (legacy conversations)
 *   - Rendered as styled text, not clickable (no original whitelist available)
 */
function renderResponseWithCitations(
  bubble: HTMLElement,
  doc: Document,
  text: string,
  chunkWhitelist: Map<string, ChunkMeta>,
  item: Zotero.Item,
): void {
  bubble.innerHTML = "";

  // Build a combined regex that matches both chunk and legacy page citations.
  // Group 1 = chunk ID, Group 2 = legacy page number.
  const COMBINED_RE = new RegExp(
    `\\[c\\.(${CHUNK_ID_PATTERN})\\]|\\[p\\.(\\d+)\\]`,
    "g",
  );

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = COMBINED_RE.exec(text)) !== null) {
    // Append plain text before this match.
    if (match.index > lastIndex) {
      bubble.appendChild(
        doc.createTextNode(text.slice(lastIndex, match.index)),
      );
    }

    if (match[1] !== undefined) {
      // --- Chunk citation [c.ID] ---
      const chunkId = match[1].toLowerCase(); // normalize: model may emit uppercase hex
      const meta = chunkWhitelist.get(chunkId);

      if (meta) {
        const pageRange =
          meta.pageStart === meta.pageEnd
            ? `p.${meta.pageStart}`
            : `pp.${meta.pageStart}-${meta.pageEnd}`;

        const link = h(doc, "a") as HTMLAnchorElement;
        link.href = "#";
        link.textContent = `[${pageRange}]`;
        link.style.cssText =
          "color:#4a90d9;text-decoration:underline;cursor:pointer;";
        link.title = meta.excerpt;
        link.addEventListener("click", (e) => {
          e.preventDefault();
          openPDFAtPage(meta.pageStart, item);
        });
        bubble.appendChild(link);
      } else {
        // Chunk ID not in whitelist — possible hallucination.
        const span = h(doc,"span");
        span.textContent = `[c.${chunkId}]`;
        span.style.cssText = "color:#bbb;text-decoration:line-through;";
        span.title = "Citation not in source";
        bubble.appendChild(span);
      }
    } else if (match[2] !== undefined) {
      // --- Legacy page citation [p.N] (Phase A backward compat) ---
      const pageNum = parseInt(match[2], 10);
      const span = h(doc,"span");
      span.textContent = `[p.${pageNum}]`;
      span.style.cssText =
        "color:#7b9cc0;font-size:12px;cursor:default;";
      span.title = "Legacy page citation";
      bubble.appendChild(span);
    }

    lastIndex = COMBINED_RE.lastIndex;
  }

  // Append remaining text after last match.
  if (lastIndex < text.length) {
    bubble.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * Opens the PDF reader at a given page.
 *
 * Primary: Zotero.Reader.navigate({ pageNumber }) — in-place navigation.
 * Fallback: zotero://open-pdf/library/items/KEY?page=N deep link, which requires
 *   the PDF attachment's item key to open the correct document.
 */
function openPDFAtPage(page: number, item: Zotero.Item): void {
  try {
    // Try the Zotero.Reader API (Zotero 7/8).
    const mainWin = Zotero.getMainWindow() as any;
    const tabID = mainWin?.Zotero_Tabs?.selectedID;
    const reader = tabID ? Zotero.Reader.getByTabID(tabID) : null;
    if (reader) {
      (reader as any).navigate({ pageNumber: page });
      return;
    }
  } catch {
    // Fall through.
  }

  // Fallback: deep link using the PDF attachment's item key.
  try {
    // If the item itself is a PDF attachment, use it directly.
    // Otherwise search child attachments (the normal parent-item case).
    let pdfItem: Zotero.Item | undefined;
    if (
      item.isAttachment() &&
      item.attachmentContentType === "application/pdf"
    ) {
      pdfItem = item;
    } else {
      const attachmentIDs: number[] = item.getAttachments();
      pdfItem = attachmentIDs
        .map((id) => Zotero.Items.get(id))
        .find((att) => att?.attachmentContentType === "application/pdf");
    }

    if (pdfItem) {
      const win = Zotero.getMainWindow() as any;
      win?.ZoteroPane?.loadURI?.(
        `zotero://open-pdf/library/items/${pdfItem.key}?page=${page}`,
      );
    } else {
      ztoolkit.log(`Could not navigate to page ${page}: no PDF attachment found`);
    }
  } catch {
    ztoolkit.log(`Could not navigate to page ${page}`);
  }
}

// ---------------------------------------------------------------------------
// Provider selector
// ---------------------------------------------------------------------------

/** Display labels and current model for each provider. */
const PROVIDER_OPTIONS: Array<{
  value: prefs.ProviderName;
  label: string;
  getModel: () => string;
}> = [
  { value: "ollama", label: "Ollama", getModel: prefs.getOllamaModel },
  { value: "gemini", label: "Gemini", getModel: prefs.getGeminiModel },
  { value: "openai", label: "OpenAI", getModel: prefs.getOpenAIModel },
  { value: "anthropic", label: "Anthropic", getModel: prefs.getAnthropicModel },
  { value: "custom", label: "Custom", getModel: prefs.getCustomModel },
];

/**
 * Renders a compact provider `<select>` dropdown into the given container.
 * Each option shows "Provider (model)" so the user can see both at a glance.
 * Changing the selection updates the active provider pref immediately.
 */
function renderProviderSelector(
  container: HTMLElement,
  doc: Document,
  onProviderChange?: () => void,
): void {
  container.innerHTML = "";

  const select = h(doc, "select") as HTMLSelectElement;
  select.style.cssText =
    "font-size:11px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;" +
    "background:#fff;color:#333;cursor:pointer;max-width:160px;";

  const current = prefs.getActiveProvider();

  for (const opt of PROVIDER_OPTIONS) {
    const option = h(doc, "option") as HTMLOptionElement;
    option.value = opt.value;
    const model = opt.getModel();
    option.textContent = model ? `${opt.label} (${model})` : opt.label;
    if (opt.value === current) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  select.addEventListener("change", () => {
    prefs.setActiveProvider(select.value as prefs.ProviderName);
    onProviderChange?.();
  });

  container.appendChild(select);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

// --- Scroll helpers (Fix #6) ------------------------------------------------

const SCROLL_NEAR_BOTTOM_PX = 40;

/**
 * Returns `true` when the element is scrolled to within `SCROLL_NEAR_BOTTOM_PX`
 * of its maximum scroll position. **Must** be called BEFORE the DOM mutation
 * that appends new content — otherwise the newly-added height may push the
 * measurement past the threshold and yield a false negative.
 */
export function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_NEAR_BOTTOM_PX;
}

/**
 * Scrolls an element to the bottom using `requestAnimationFrame` for smooth
 * visual timing. The `shouldStick` parameter carries the result of an
 * `isNearBottom()` check captured **before** the DOM mutation that added new
 * content.
 *
 * - `shouldStick === false` → user has scrolled up; skip auto-scroll.
 * - `shouldStick === true`  → user is near the bottom; scroll.
 * - `shouldStick` omitted   → unconditional force-scroll (e.g. after loading
 *    history or after the user explicitly sends a new message).
 */
export function scrollToBottom(el: HTMLElement, shouldStick?: boolean): void {
  if (shouldStick === false) return; // user scrolled up — don't auto-scroll
  (el.ownerDocument!.defaultView ?? (globalThis as any)).requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight;
  });
}

// --- Bubble styles ----------------------------------------------------------

const BUBBLE_STYLE_USER =
  "padding:8px 12px;border-radius:12px 12px 2px 12px;background:#e3f2fd;" +
  "align-self:flex-end;max-width:85%;word-wrap:break-word;line-height:1.5;" +
  "user-select:text;-moz-user-select:text;";

const BUBBLE_STYLE_ASSISTANT =
  "padding:8px 12px;border-radius:12px 12px 12px 2px;background:#f5f5f5;" +
  "align-self:flex-start;max-width:85%;word-wrap:break-word;line-height:1.5;white-space:pre-wrap;" +
  "user-select:text;-moz-user-select:text;position:relative;";

function appendBubble(
  container: HTMLElement,
  doc: Document,
  role: "user" | "assistant",
  text: string,
): void {
  const bubble = h(doc,"div");
  bubble.style.cssText =
    role === "user" ? BUBBLE_STYLE_USER : BUBBLE_STYLE_ASSISTANT;
  bubble.textContent = text;
  container.appendChild(bubble);
  if (role === "assistant") {
    appendCopyButton(bubble, doc, () => text);
  }
}

/**
 * Appends a copy-to-clipboard button to an assistant bubble.
 * The button appears on hover and shows a ✓ checkmark for 1.2 s after copying.
 * Uses ztoolkit.Clipboard (XPCOM nsIClipboard) with navigator.clipboard fallback.
 */
function appendCopyButton(
  bubble: HTMLElement,
  doc: Document,
  getText: () => string,
): void {
  const btn = h(doc, "button") as HTMLButtonElement;
  btn.textContent = "\uD83D\uDCCB"; // 📋
  btn.title = "Copy to clipboard";
  btn.style.cssText =
    "position:absolute;top:4px;right:4px;background:rgba(255,255,255,0.8);" +
    "border:1px solid #ddd;border-radius:3px;cursor:pointer;font-size:12px;" +
    "padding:2px 4px;opacity:0;transition:opacity 0.15s;" +
    "line-height:1;user-select:none;-moz-user-select:none;";

  bubble.addEventListener("mouseenter", () => { btn.style.opacity = "1"; });
  bubble.addEventListener("mouseleave", () => {
    if (btn.textContent !== "\u2713") btn.style.opacity = "0";
  });

  btn.addEventListener("click", (e) => {
    (e as MouseEvent).stopPropagation();
    try {
      new (ztoolkit.Clipboard as any)().addText(getText(), "text/unicode").copy();
    } catch {
      try { (navigator as any).clipboard?.writeText?.(getText()); } catch { return; }
    }
    btn.textContent = "\u2713"; // ✓
    btn.style.opacity = "1";
    const win = doc.defaultView ?? (globalThis as any);
    win.setTimeout(() => {
      btn.textContent = "\uD83D\uDCCB";
      if (!bubble.matches(":hover")) btn.style.opacity = "0";
    }, 1200);
  });
  bubble.appendChild(btn);
}

/**
 * Appends a system note (e.g. chunk-selection info) to the message area.
 *
 * @param shouldStick - When called from the send cycle, pass
 *   `scrollState.stick` so the note scrolls into view when the user was at
 *   the bottom. This prevents the note's DOM insertion from pushing the user
 *   past the `isNearBottom` threshold (which would create a false negative
 *   on the next `isNearBottom` check). When omitted, does not scroll.
 */
function appendSystemNote(
  container: HTMLElement,
  doc: Document,
  text: string,
  shouldStick?: boolean,
): void {
  const note = h(doc,"div");
  note.style.cssText =
    "font-size:11px;color:#999;text-align:center;padding:4px 8px;";
  note.textContent = `\u2139 ${text}`;
  container.appendChild(note);
  if (shouldStick !== undefined) {
    scrollToBottom(container, shouldStick);
  }
}

/**
 * Appends concrete setup steps for Ollama when it is selected but unreachable.
 */
function appendOllamaSetupGuidance(
  container: HTMLElement,
  doc: Document,
): void {
  const endpoint = prefs.getOllamaEndpoint();
  const model = prefs.getOllamaModel();
  appendBubble(
    container,
    doc,
    "assistant",
    "Ollama is selected but not reachable.\n" +
      `• Endpoint: ${endpoint}\n` +
      "• Install Ollama: https://ollama.com/download\n" +
      "• Start server: ollama serve\n" +
      `• Pull model: ollama pull ${model}`,
  );
}

/**
 * Emits a one-time info note when Ollama is selected and currently unavailable.
 */
async function notifyOllamaIfUnavailable(
  messages: HTMLElement,
  doc: Document,
): Promise<void> {
  const existing = messages.querySelector<HTMLElement>(`#${OLLAMA_STATUS_NOTE_ID}`);

  if (prefs.getActiveProvider() !== "ollama") {
    existing?.remove();
    return;
  }

  const provider = new OllamaProvider(prefs.getOllamaEndpoint());
  const available = await provider.isAvailable();
  if (available) {
    existing?.remove();
    return;
  }

  const text =
    "\u2139 Ollama not detected. Install Ollama: https://ollama.com/download, then run `ollama serve`.";
  if (existing) {
    existing.textContent = text;
    return;
  }

  const note = h(doc, "div");
  note.id = OLLAMA_STATUS_NOTE_ID;
  note.style.cssText =
    "font-size:11px;color:#999;text-align:center;padding:4px 8px;";
  note.textContent = text;
  messages.appendChild(note);
}

// ---------------------------------------------------------------------------
// Status note helpers — mutable status line that updates during processing
// ---------------------------------------------------------------------------

/**
 * Appends a mutable status note (e.g. "Extracting paper…") that can be
 * updated in-place or removed once no longer needed.
 *
 * @param shouldStick - When called from the send cycle, pass
 *   `scrollState.stick` so the note respects the user's scroll position.
 *   When omitted, force-scrolls (e.g. for notes outside the send cycle).
 */
function appendStatusNote(
  container: HTMLElement,
  doc: Document,
  text: string,
  shouldStick?: boolean,
): HTMLElement {
  const note = h(doc, "div");
  note.style.cssText =
    "font-size:11px;color:#888;text-align:center;padding:4px 8px;font-style:italic;";
  note.textContent = text;
  container.appendChild(note);
  scrollToBottom(container, shouldStick);
  return note;
}

function updateStatusNote(note: HTMLElement, text: string): void {
  note.textContent = text;
}

function removeStatusNote(note: HTMLElement): void {
  note.remove();
}

/**
 * Timeout wrapper for non-critical async ops (mainly IndexedDB calls) so
 * reader UI cannot remain blocked forever when a context has broken IDB.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Retry with non-stream mode for transport-level streaming failures.
 */
function shouldRetryNonStream(err: any): boolean {
  const raw = String(err?.message ?? err).toLowerCase();
  return (
    err?.name === "AbortError" ||
    err?.name === "TimeoutError" ||
    /timeout|timed out|idle timeout|abort|network|failed to fetch|stream/.test(raw)
  );
}

// ---------------------------------------------------------------------------
// Diagnostics helpers
// ---------------------------------------------------------------------------

/**
 * Builds the diagnostics footer string appended after each LLM response.
 *
 * Format: `{model} · {host} · {mode} · ~{tokens} tokens`
 * Example: `gpt-4o-mini · api.openai.com · stream · ~4,231 tokens`
 *
 * Redaction rules (ROADMAP §diagnostics):
 *   - Only the hostname is shown — no path, no query parameters, no port.
 *   - API keys and Authorization headers are never present in the host string.
 *   - The formatter is the sole owner of redaction; callers pass raw values.
 */
function buildDiagnosticsNote(
  model: string,
  usedStream: boolean,
  tokens: number,
): string {
  const host = getProviderDisplayHost();
  const mode = usedStream ? "stream" : "non-stream";
  return `${model} \u00b7 ${host} \u00b7 ${mode} \u00b7 ~${tokens.toLocaleString()} tokens`;
}

/**
 * Returns a safe display hostname for the currently active provider.
 * Only the `host` portion of the endpoint URL is returned (no path, query, or auth).
 * Falls back to the provider name string if URL parsing fails.
 */
function getProviderDisplayHost(): string {
  const name = prefs.getActiveProvider();
  try {
    switch (name) {
      case "ollama":
        return new URL(prefs.getOllamaEndpoint()).host;
      case "gemini":
        return "generativelanguage.googleapis.com";
      case "openai":
        return new URL(prefs.getOpenAIEndpoint()).host;
      case "anthropic":
        return "api.anthropic.com";
      case "custom": {
        const ep = prefs.getCustomEndpoint();
        return ep ? new URL(ep).host : "custom";
      }
      default:
        return name;
    }
  } catch {
    // URL parsing failed (e.g. malformed endpoint pref) — degrade gracefully.
    return name;
  }
}

// ---------------------------------------------------------------------------
// Error message helper
// ---------------------------------------------------------------------------

/**
 * Converts raw errors into user-friendly messages.
 * Detects timeout / abort / network errors and provides actionable guidance.
 */
function friendlyErrorMessage(err: any): string {
  const raw = err?.message ?? String(err);
  const activeProvider = prefs.getActiveProvider();
  const providerHint =
    activeProvider === "ollama"
      ? "If using Ollama, make sure it’s installed and running (ollama serve). Install: https://ollama.com/download"
      : `Check your ${activeProvider} API key/endpoint and network access.`;

  // AbortError: the connection timed out (our AbortController fired).
  if (err?.name === "AbortError" || /abort/i.test(raw)) {
    return (
      "Connection timed out. The LLM provider did not respond.\n" +
      `\u2022 ${providerHint}\n` +
      "\u2022 If on a restricted network, try a non-stream request path."
    );
  }

  // TypeError: fetch network failure (DNS, refused, etc.).
  if (err?.name === "TypeError" && /fetch|network/i.test(raw)) {
    return (
      "Could not reach the LLM provider.\n" +
      `\u2022 ${providerHint}\n` +
      "\u2022 Check your network connection and provider settings."
    );
  }

  // TimeoutError (AbortSignal.timeout generates this in some runtimes).
  if (err?.name === "TimeoutError" || /timeout/i.test(raw)) {
    return (
      "Request timed out. The LLM provider did not respond in time.\n" +
      `\u2022 ${providerHint}\n` +
      "\u2022 The network or provider endpoint may be blocking long-running streams."
    );
  }

  // Rate limit / quota exceeded (safety net — providers should format this themselves).
  if (/429|quota exceeded|rate.?limit/i.test(raw)) {
    return (
      "API rate limit or quota exceeded.\n" +
      "\u2022 Wait a few minutes and try again.\n" +
      "\u2022 Consider switching to a different provider in Settings."
    );
  }

  // Pass through other errors with a generic prefix.
  return `Error: ${raw}`;
}
