/**
 * First-run onboarding modal — shown once before the user can send any message.
 *
 * Explains:
 * - What the plugin does
 * - What data may be sent to external LLM APIs
 * - How to stay local-only (Ollama)
 * - Default: cloud sharing OFF
 *
 * Privacy is opt-in: the user must explicitly enable cloud sharing.
 * The modal is blocking — the chat panel renders it instead of the chat UI
 * until onboarding is complete.
 *
 * Completion is stored in Zotero.Prefs so it only shows once.
 *
 * All DOM elements are built imperatively using createElementNS (via the `h()`
 * helper) rather than innerHTML. This is required because the panel lives in
 * Zotero's XUL document, where innerHTML uses the XML fragment parser —
 * querySelector fails to find elements parsed via innerHTML in XML context.
 *
 * @module modules/ui/onboarding
 */
import * as prefs from "../../prefs";
import { autoDetectProvider } from "../llm/client";
import { h } from "../../utils/dom";

/**
 * Returns true if onboarding has already been completed.
 */
export function isOnboardingDone(): boolean {
  return prefs.isOnboardingCompleted();
}

// ---------------------------------------------------------------------------
// DOM builder helpers (local to this module)
// ---------------------------------------------------------------------------

/** Sets style + textContent on an element and returns it. */
function styled(el: HTMLElement, css: string, text?: string): HTMLElement {
  el.style.cssText = css;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Creates a styled text element. */
function text(doc: Document, tag: string, css: string, content: string): HTMLElement {
  return styled(h(doc, tag), css, content);
}

// ---------------------------------------------------------------------------
// Onboarding renderer
// ---------------------------------------------------------------------------

/**
 * Renders the onboarding UI into a container element.
 * Calls onComplete() when the user finishes setup.
 *
 * @param container - The DOM element to render into (the chat panel body).
 * @param doc - The ownerDocument of the container.
 * @param onComplete - Callback fired when onboarding is done.
 */
export function renderOnboarding(
  container: HTMLElement,
  doc: Document,
  onComplete: () => void,
): void {
  container.innerHTML = "";

  const wrapper = h(doc, "div");
  wrapper.style.cssText =
    "display:flex;flex-direction:column;gap:12px;padding:16px;" +
    "font-family:system-ui,sans-serif;font-size:13px;overflow-y:auto;height:100%;";

  // --- Title ---
  wrapper.appendChild(
    text(doc, "h2", "margin:0;font-size:15px;color:#1a1a1a;", "Welcome to LLM Assistant"),
  );

  // --- Description ---
  wrapper.appendChild(
    text(
      doc,
      "p",
      "margin:0;color:#444;line-height:1.5;",
      "This plugin lets you chat with your papers using AI. " +
        "You can ask questions, find citations, and search your Zotero library.",
    ),
  );

  // --- Privacy notice ---
  const privacyBox = h(doc, "div");
  privacyBox.style.cssText =
    "background:#fff8e1;border:1px solid #f0c040;border-radius:6px;padding:10px;";

  privacyBox.appendChild(
    text(doc, "strong", "color:#7a5800;", "Privacy notice"),
  );
  privacyBox.appendChild(
    text(
      doc,
      "p",
      "margin:6px 0 0;color:#555;line-height:1.5;",
      "By default, your paper content is not sent to any cloud service. " +
        "If you enable a cloud provider (Gemini, OpenAI, etc.), paper text will be sent " +
        "to that provider\u2019s servers. You can mark individual papers as private to prevent this.",
    ),
  );
  wrapper.appendChild(privacyBox);

  // --- Setup choice ---
  const choiceBox = h(doc, "div");
  choiceBox.style.cssText = "background:#f5f5f5;border-radius:6px;padding:10px;";

  choiceBox.appendChild(
    text(doc, "strong", "color:#333;", "Choose your setup:"),
  );

  // Local radio option
  const localLabel = h(doc, "label");
  localLabel.style.cssText =
    "display:flex;align-items:flex-start;gap:8px;margin-top:10px;cursor:pointer;";

  const localRadio = h(doc, "input") as HTMLInputElement;
  localRadio.type = "radio";
  localRadio.name = "setup";
  localRadio.value = "local";
  localRadio.checked = true;
  localRadio.style.marginTop = "2px";

  const localTextSpan = h(doc, "span");
  const localBold = text(doc, "strong", "", "Local only (Ollama)");
  const localDesc = text(
    doc,
    "span",
    "color:#666;",
    "No data leaves your computer. Requires Ollama to be installed and running.",
  );
  localTextSpan.appendChild(localBold);
  localTextSpan.appendChild(h(doc, "br"));
  localTextSpan.appendChild(localDesc);

  localLabel.appendChild(localRadio);
  localLabel.appendChild(localTextSpan);
  choiceBox.appendChild(localLabel);

  // Cloud radio option
  const cloudLabel = h(doc, "label");
  cloudLabel.style.cssText =
    "display:flex;align-items:flex-start;gap:8px;margin-top:10px;cursor:pointer;";

  const cloudRadio = h(doc, "input") as HTMLInputElement;
  cloudRadio.type = "radio";
  cloudRadio.name = "setup";
  cloudRadio.value = "cloud";
  cloudRadio.style.marginTop = "2px";

  const cloudTextSpan = h(doc, "span");
  const cloudBold = text(doc, "strong", "", "Cloud (Google Gemini)");
  const cloudDesc = text(
    doc,
    "span",
    "color:#666;",
    "Paper content is sent to Google\u2019s API. Free with a Google account \u2014 " +
      "no credit card required. More providers (OpenAI, Anthropic) can be set up in Settings.",
  );
  cloudTextSpan.appendChild(cloudBold);
  cloudTextSpan.appendChild(h(doc, "br"));
  cloudTextSpan.appendChild(cloudDesc);

  cloudLabel.appendChild(cloudRadio);
  cloudLabel.appendChild(cloudTextSpan);
  choiceBox.appendChild(cloudLabel);

  wrapper.appendChild(choiceBox);

  // --- Cloud section (hidden by default) ---
  const cloudSection = h(doc, "div");
  cloudSection.style.cssText =
    "display:none;background:#f5f5f5;border-radius:6px;padding:10px;";

  const apikeyLabel = text(
    doc,
    "label",
    "display:block;margin-bottom:4px;font-weight:600;",
    "Google Gemini API key:",
  );
  cloudSection.appendChild(apikeyLabel);

  const apikeyInput = h(doc, "input") as HTMLInputElement;
  apikeyInput.type = "password";
  apikeyInput.placeholder = "Paste your Gemini API key here";
  apikeyInput.style.cssText =
    "width:100%;padding:6px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;";
  cloudSection.appendChild(apikeyInput);

  cloudSection.appendChild(
    text(
      doc,
      "p",
      "margin:6px 0 0;font-size:11px;color:#888;",
      "\u26A0 Stored as plaintext in your Zotero profile. Not suitable for shared machines.",
    ),
  );

  wrapper.appendChild(cloudSection);

  // --- Status area ---
  const statusEl = h(doc, "div");
  statusEl.style.cssText = "min-height:20px;color:#666;font-size:12px;";
  wrapper.appendChild(statusEl);

  // --- Confirm button ---
  const confirmBtn = h(doc, "button") as HTMLButtonElement;
  confirmBtn.textContent = "Get Started";
  confirmBtn.style.cssText =
    "padding:8px 16px;background:#4a90d9;color:white;border:none;" +
    "border-radius:4px;cursor:pointer;font-size:13px;font-weight:600;align-self:flex-start;";
  wrapper.appendChild(confirmBtn);

  container.appendChild(wrapper);

  // --- Event: show/hide cloud section ---
  localRadio.addEventListener("change", () => {
    cloudSection.style.display = "none";
  });
  cloudRadio.addEventListener("change", () => {
    cloudSection.style.display = "block";
  });

  // --- Event: confirm button ---
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Setting up\u2026";

    const selectedSetup = cloudRadio.checked ? "cloud" : "local";

    if (selectedSetup === "cloud") {
      const apiKey = apikeyInput.value.trim();

      if (!apiKey) {
        statusEl.textContent = "Please enter your Gemini API key.";
        statusEl.style.color = "#c00";
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Get Started";
        return;
      }

      // Onboarding always configures Gemini (the only implemented cloud provider).
      // OpenAI, Anthropic, and custom endpoints are available in Settings.
      prefs.setActiveProvider("gemini");
      prefs.setGeminiApiKey(apiKey);
      prefs.setCloudSharingEnabled(true);
      statusEl.textContent = "Gemini configured. Cloud sharing enabled.";
    } else {
      // Local / Ollama path.
      statusEl.textContent = "Checking for Ollama\u2026";
      try {
        await autoDetectProvider();
        statusEl.style.color = "#2a7a2a";
        statusEl.textContent = "\u2713 Ollama detected and ready.";
      } catch {
        statusEl.style.color = "#888";
        statusEl.textContent =
          "Ollama not detected. You can still use the plugin \u2014 start Ollama and it will connect automatically.";
      }
    }

    // Mark onboarding complete.
    prefs.setOnboardingCompleted(true);

    await new Promise((r) => setTimeout(r, 800));
    onComplete();
  });
}
