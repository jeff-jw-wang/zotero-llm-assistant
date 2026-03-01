/**
 * Per-item privacy toggle — shown in the LLM Assistant panel header.
 *
 * When active (🔒 Private), the item's content is never sent to cloud LLM APIs,
 * even if global cloud sharing is enabled. The flag is stored per item ID in
 * IndexedDB via the storage/db module.
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

/** Renders the privacy indicator/toggle into a target element. */
export async function renderPrivacyToggle(
  container: HTMLElement,
  doc: Document,
  itemId: number,
): Promise<void> {
  container.innerHTML = "";

  const isPrivate = await isItemPrivate(itemId);
  const cloudEnabled = prefs.isCloudSharingEnabled();
  const providerName = getActiveProviderLabel();

  const btn = h(doc,"button");
  btn.style.cssText = `
    padding: 2px 8px; border-radius: 10px; font-size: 11px; cursor: pointer;
    border: 1px solid; background: transparent; font-family: system-ui, sans-serif;
  `;

  function applyState(private_: boolean) {
    if (private_) {
      btn.textContent = "🔒 Private";
      btn.style.borderColor = "#e07b00";
      btn.style.color = "#e07b00";
      btn.title = "This paper is private — content stays local. Click to allow cloud.";
    } else if (!cloudEnabled) {
      btn.textContent = "🏠 Local only";
      btn.style.borderColor = "#2a7a2a";
      btn.style.color = "#2a7a2a";
      btn.title = "Cloud sharing is disabled globally. Go to Settings to enable.";
    } else {
      btn.textContent = `☁ ${providerName}`;
      btn.style.borderColor = "#4a90d9";
      btn.style.color = "#4a90d9";
      btn.title = "Paper content may be sent to the cloud provider. Click to make private.";
    }
  }

  applyState(isPrivate);

  btn.addEventListener("click", async () => {
    const currentlyPrivate = await isItemPrivate(itemId);
    const newState = !currentlyPrivate;
    await setItemPrivacy(itemId, newState);
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
