/**
 * Per-item privacy toggle — shown in the LLM Assistant panel header.
 *
 * When active (🔒 Private), the item's content is never sent to cloud LLM APIs,
 * even if global cloud sharing is enabled. The flag is stored per item ID in
 * IndexedDB via the storage/db module, with a Zotero.Prefs mirror for contexts
 * where IndexedDB is unavailable (e.g. the reader panel's privileged chrome frame).
 *
 * The toggle renders as a small button in the chat panel header showing either:
 *   "☁ Cloud: [ProviderName]"  — content may be sent to the configured provider
 *   "🔒 Private"               — content is kept local only
 *
 * @module modules/ui/privacyToggle
 */
import * as prefs from "../../prefs";
import { h } from "../../utils/dom";
import { isItemPrivate, setItemPrivacy } from "../storage/db";

/**
 * Reads the per-item private flag, falling back to the Zotero.Prefs mirror
 * if IndexedDB is unavailable (e.g. in the reader panel context).
 */
async function readPrivateFlag(itemId: number): Promise<boolean> {
  try {
    return await isItemPrivate(itemId);
  } catch {
    // IndexedDB unavailable — fall back to Prefs mirror (fail-closed on corrupt data).
    return prefs.isItemPrivatePref(itemId);
  }
}

/**
 * Writes the per-item private flag to both IndexedDB and the Zotero.Prefs mirror.
 * Each write is independent — failure of one does not prevent the other.
 * The Prefs mirror is always written (it never throws), ensuring checkPrivacy()
 * can read the flag even when IndexedDB is unavailable.
 */
async function writePrivateFlag(itemId: number, isPrivate: boolean): Promise<void> {
  // Always write Prefs mirror first — it's synchronous, never throws, and
  // ensures checkPrivacy() has the latest flag regardless of IDB outcome.
  prefs.setItemPrivatePref(itemId, isPrivate);

  // Best-effort IndexedDB write — may fail in reader panel context.
  try {
    await setItemPrivacy(itemId, isPrivate);
  } catch {
    // IndexedDB unavailable — Prefs mirror already has the value; no action needed.
  }
}

/** Renders the privacy indicator/toggle into a target element. */
export async function renderPrivacyToggle(
  container: HTMLElement,
  doc: Document,
  itemId: number,
): Promise<void> {
  container.innerHTML = "";

  const isPrivate = await readPrivateFlag(itemId);

  const btn = h(doc,"button");
  btn.style.cssText = `
    padding: 2px 8px; border-radius: 10px; font-size: 11px; cursor: pointer;
    border: 1px solid; background: transparent; font-family: system-ui, sans-serif;
  `;

  function applyState(private_: boolean) {
    // Re-read provider name and cloud toggle on every call so the button
    // text stays current when the user switches providers via the selector.
    const currentProvider = getActiveProviderLabel();
    const currentCloudEnabled = prefs.isCloudSharingEnabled();

    if (private_) {
      btn.textContent = "🔒 Private";
      btn.style.borderColor = "#e07b00";
      btn.style.color = "#e07b00";
      btn.title = "This paper is private — content stays local. Click to allow cloud.";
    } else if (!currentCloudEnabled) {
      btn.textContent = "🏠 Local only";
      btn.style.borderColor = "#2a7a2a";
      btn.style.color = "#2a7a2a";
      btn.title = "Cloud sharing is disabled globally. Go to Settings to enable.";
    } else {
      btn.textContent = `☁ ${currentProvider}`;
      btn.style.borderColor = "#4a90d9";
      btn.style.color = "#4a90d9";
      btn.title = "Paper content may be sent to the cloud provider. Click to make private.";
    }
  }

  applyState(isPrivate);

  btn.addEventListener("click", async () => {
    const currentlyPrivate = await readPrivateFlag(itemId);
    const newState = !currentlyPrivate;
    await writePrivateFlag(itemId, newState);
    applyState(newState);
  });

  container.appendChild(btn);
}

/** Returns a short display label for the currently active provider. */
function getActiveProviderLabel(): string {
  const labels: Record<string, string> = {
    ollama: "Ollama",
    gemini: "Gemini",
    openai: "OpenAI",
    anthropic: "Claude",
    custom: "Custom",
  };
  return labels[prefs.getActiveProvider()] ?? "Cloud";
}
