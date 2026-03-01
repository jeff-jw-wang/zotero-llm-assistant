/**
 * Settings pane — handles preference UI interactions for Zotero > Settings > LLM Assistant.
 *
 * Called when the user opens Zotero > Settings > LLM Assistant.
 * The XHTML structure is defined in addon/content/preferences.xhtml.
 * This module attaches runtime behaviour:
 *   1. Reads current pref values and populates all form fields on load.
 *   2. Shows / hides provider-specific sections when the provider dropdown changes.
 *   3. Saves values back to prefs on field change.
 *   4. Validates custom endpoint URLs via the SSRF validator before saving.
 *   5. Shows inline error messages for invalid inputs.
 *
 * Element ID convention used in preferences.xhtml:
 *   zotero-prefpane-<addonRef>-<field>
 * Provider sections:
 *   zotero-prefpane-<addonRef>-section-<provider>  (vbox, toggled hidden/visible)
 *
 * @module modules/ui/settingsPane
 */
import { config } from "../../../package.json";
import * as prefs from "../../prefs";
import { validateEndpointURL, preflightDNSCheck } from "../../utils/url";
import { isModelReady, isModelRevisionCurrent, ensureModelReady, disposeEmbedder } from "../rag/embedder";

const ID = (suffix: string) => `zotero-prefpane-${config.addonRef}-${suffix}`;

// All providers with sections in preferences.xhtml.
const ALL_PROVIDERS = ["ollama", "gemini", "openai", "anthropic", "custom"] as const;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Called when the preferences window fires its "load" event.
 * Populates fields and attaches all event listeners.
 */
export function registerPrefsScripts(win: Window): void {
  ztoolkit.log("Preferences pane loaded");
  const doc = win.document;

  // --- Provider selector ---
  const providerEl = doc.getElementById(ID("provider")) as any;
  if (providerEl) {
    providerEl.value = prefs.getActiveProvider();
    updateSectionVisibility(doc, providerEl.value);

    providerEl.addEventListener("command", () => {
      const selected = providerEl.value as prefs.ProviderName;
      prefs.setActiveProvider(selected);
      updateSectionVisibility(doc, selected);
    });
  }

  // --- Cloud-sharing checkbox ---
  const cloudEl = doc.getElementById(ID("cloud-sharing")) as any;
  if (cloudEl) {
    cloudEl.checked = prefs.isCloudSharingEnabled();
    cloudEl.addEventListener("command", () =>
      prefs.setCloudSharingEnabled(cloudEl.checked),
    );
  }

  // --- Ollama ---
  bindText(doc, ID("ollama-endpoint"), prefs.getOllamaEndpoint(), prefs.setOllamaEndpoint);
  bindText(doc, ID("ollama-model"), prefs.getOllamaModel(), prefs.setOllamaModel);

  // --- Gemini ---
  bindText(doc, ID("gemini-apikey"), prefs.getGeminiApiKey(), prefs.setGeminiApiKey);
  bindText(doc, ID("gemini-model"), prefs.getGeminiModel(), prefs.setGeminiModel);

  // --- OpenAI ---
  bindText(doc, ID("openai-apikey"), prefs.getOpenAIApiKey(), prefs.setOpenAIApiKey);
  bindText(doc, ID("openai-model"), prefs.getOpenAIModel(), prefs.setOpenAIModel);
  bindEndpointWithValidation(
    doc,
    ID("openai-endpoint"),
    ID("openai-endpoint-error"),
    prefs.getOpenAIEndpoint(),
    prefs.setOpenAIEndpoint,
  );

  // --- Anthropic ---
  bindText(doc, ID("anthropic-apikey"), prefs.getAnthropicApiKey(), prefs.setAnthropicApiKey);
  bindText(doc, ID("anthropic-model"), prefs.getAnthropicModel(), prefs.setAnthropicModel);

  // --- Custom ---
  bindEndpointWithValidation(
    doc,
    ID("custom-endpoint"),
    ID("custom-endpoint-error"),
    prefs.getCustomEndpoint(),
    prefs.setCustomEndpoint,
  );
  bindText(doc, ID("custom-apikey"), prefs.getCustomApiKey(), prefs.setCustomApiKey);
  bindText(doc, ID("custom-model"), prefs.getCustomModel(), prefs.setCustomModel);

  // --- Semantic search toggle (Phase D) ---
  bindSemanticSearch(doc);
}

// ---------------------------------------------------------------------------
// Provider section visibility
// ---------------------------------------------------------------------------

/**
 * Shows only the section for the given provider; hides all others.
 * Sections must have IDs of the form "zotero-prefpane-<addonRef>-section-<provider>".
 */
function updateSectionVisibility(doc: Document, provider: string): void {
  for (const p of ALL_PROVIDERS) {
    const section = doc.getElementById(ID(`section-${p}`));
    if (section) {
      section.setAttribute("hidden", p === provider ? "false" : "true");
    }
  }
}

// ---------------------------------------------------------------------------
// Field binding helpers
// ---------------------------------------------------------------------------

/**
 * Binds a plain text / password input:
 *   - Sets its initial value from the provided getter result.
 *   - Calls the setter on "change" and "blur" to ensure the value is
 *     persisted even in XUL contexts where "change" may not fire reliably.
 *   - Deduplicates saves by tracking the last written value.
 */
function bindText(
  doc: Document,
  id: string,
  initialValue: string,
  setter: (value: string) => void,
): void {
  const el = doc.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.value = initialValue;

  let lastSaved = initialValue;
  const save = () => {
    const val = el.value.trim();
    if (val !== lastSaved) {
      setter(val);
      lastSaved = val;
    }
  };

  el.addEventListener("change", save);
  // Backup: in some XUL panel contexts "change" may not fire on blur.
  el.addEventListener("blur", save);
}

/**
 * Binds an endpoint URL input with SSRF validation (D2):
 *   - Sets its initial value from the provided getter result.
 *   - On "change": runs `validateEndpointURL()` (sync, static checks).
 *     - If invalid: shows error, does NOT save — this is the hard gate.
 *     - If valid: clears error, saves, then fires `preflightDNSCheck()` async.
 *       If DNS fails: shows a warning (best-effort, value already saved).
 *
 * @param doc - The settings document.
 * @param inputId - The ID of the text input element.
 * @param errorSpanId - The ID of the inline error span element.
 * @param initialValue - Current pref value to populate the input.
 * @param setter - Pref setter function called on valid change.
 */
function bindEndpointWithValidation(
  doc: Document,
  inputId: string,
  errorSpanId: string,
  initialValue: string,
  setter: (value: string) => void,
): void {
  const inputEl = doc.getElementById(inputId) as HTMLInputElement | null;
  const errorEl = doc.getElementById(errorSpanId) as HTMLElement | null;
  if (!inputEl) return;

  inputEl.value = initialValue;

  inputEl.addEventListener("change", () => {
    const value = inputEl.value.trim();

    // Allow clearing the field.
    if (!value) {
      if (errorEl) errorEl.textContent = "";
      setter("");
      return;
    }

    // Static SSRF checks — hard gate.
    const r = validateEndpointURL(value);
    if (!r.valid) {
      if (errorEl) {
        errorEl.textContent = r.error ?? "Invalid endpoint URL.";
        errorEl.style.color = "#dc2626"; // Red for hard errors (override any prior amber)
      }
      return; // Do NOT save.
    }

    // Static checks passed — clear error (and reset color) and save.
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.style.color = ""; // Reset for next use
    }
    setter(value);

    // Best-effort DNS check (async, warning only — see D2).
    try {
      const hostname = new URL(value).hostname;
      preflightDNSCheck(hostname).then((dnsResult) => {
        if (!dnsResult.valid && errorEl) {
          errorEl.textContent = `Warning: ${dnsResult.error}`;
          errorEl.style.color = "#b45309"; // Amber for warning (not red)
        }
      });
    } catch {
      // URL parse failed — shouldn't happen since validateEndpointURL passed.
    }
  });
}

// ---------------------------------------------------------------------------
// Semantic search toggle (Phase D)
// ---------------------------------------------------------------------------

/**
 * Binds the semantic search checkbox, status span, and download button.
 *
 * States:
 *   - Checkbox unchecked: consent not given, no model. Status hidden.
 *   - Checkbox checked + model ready: "Model ready". Button hidden.
 *   - Checkbox checked + model NOT ready: "Model not downloaded". Button visible.
 *   - During download: "Downloading… X%". Button disabled.
 *   - Download failed: "Download failed: reason". Button shows "Retry".
 */
function bindSemanticSearch(doc: Document): void {
  const checkboxEl = doc.getElementById(ID("semantic-enabled")) as any;
  const statusEl = doc.getElementById(ID("semantic-status")) as HTMLElement | null;
  const downloadBtn = doc.getElementById(ID("semantic-download-btn")) as any;

  if (!checkboxEl) return;

  // Initialize state.
  const accepted = prefs.isEmbeddingModelAccepted();
  checkboxEl.checked = accepted;
  updateSemanticUI(statusEl, downloadBtn, accepted);

  // Checkbox toggled.
  checkboxEl.addEventListener("command", () => {
    const enabled = checkboxEl.checked;

    if (enabled) {
      // User wants to enable — set consent flag.
      prefs.setEmbeddingModelAccepted(true);

      if (isModelReady()) {
        // Already downloaded — just update UI.
        updateSemanticUI(statusEl, downloadBtn, true);
      } else {
        // Model needs download — show button.
        updateSemanticUI(statusEl, downloadBtn, true);
      }
    } else {
      // User is disabling semantic search.
      prefs.setEmbeddingModelAccepted(false);
      disposeEmbedder(); // Release resources.
      updateSemanticUI(statusEl, downloadBtn, false);
    }
  });

  // Download button clicked.
  if (downloadBtn) {
    downloadBtn.addEventListener("command", async () => {
      downloadBtn.disabled = true;
      downloadBtn.label = "Downloading…";

      if (statusEl) {
        statusEl.textContent = "Downloading… 0%";
        statusEl.style.color = "#666";
      }

      try {
        // Ensure consent is set (idempotent).
        prefs.setEmbeddingModelAccepted(true);

        await ensureModelReady((progress: number) => {
          if (statusEl) {
            statusEl.textContent = `Downloading… ${Math.round(progress * 100)}%`;
          }
        });

        // Success.
        if (statusEl) {
          statusEl.textContent = "\u2713 Model ready";
          statusEl.style.color = "#16a34a"; // green
        }
        downloadBtn.hidden = true;
      } catch (err: any) {
        // Failure — show retry UI (Case B from plan).
        if (statusEl) {
          statusEl.textContent = `Download failed: ${err?.message ?? "unknown error"}`;
          statusEl.style.color = "#dc2626"; // red
        }
        downloadBtn.label = "Retry Download";
        downloadBtn.disabled = false;
      }
    });
  }
}

/**
 * Updates the semantic search status span and download button visibility.
 *
 * Revision-aware states:
 *   - Model loaded in memory → "✓ Model ready" (green), button hidden.
 *   - Consent given, revision current, not yet loaded → "Model cached" (amber),
 *     "Load Model" button visible (recovery path if auto-warm failed).
 *   - Consent given, no stored revision → "Model not downloaded" (amber), "Download Model" button.
 *   - Consent given, stored revision differs from pinned → "Model update available" (amber), "Update Model" button.
 */
export type SemanticUIState = {
  statusText: string;
  statusColor: string;
  buttonHidden: boolean;
  buttonDisabled: boolean;
  buttonLabel: string;
};

/**
 * Pure state resolver for semantic-search status UI.
 * Exported for regression testing of edge states (e.g., auto-warm failure recovery).
 */
export function computeSemanticUIState(
  accepted: boolean,
  modelReadyState: boolean,
  revisionCurrent: boolean,
  hasStoredRevision: boolean,
): SemanticUIState {
  if (!accepted) {
    return {
      statusText: "",
      statusColor: "",
      buttonHidden: true,
      buttonDisabled: false,
      buttonLabel: "",
    };
  }

  if (modelReadyState) {
    return {
      statusText: "\u2713 Model ready",
      statusColor: "#16a34a",
      buttonHidden: true,
      buttonDisabled: false,
      buttonLabel: "",
    };
  }

  if (revisionCurrent) {
    return {
      statusText: "Model cached (not loaded)",
      statusColor: "#b45309",
      buttonHidden: false,
      buttonDisabled: false,
      buttonLabel: "Load Model",
    };
  }

  if (hasStoredRevision) {
    return {
      statusText: "Model update available",
      statusColor: "#b45309",
      buttonHidden: false,
      buttonDisabled: false,
      buttonLabel: "Update Model",
    };
  }

  return {
    statusText: "Model not downloaded",
    statusColor: "#b45309",
    buttonHidden: false,
    buttonDisabled: false,
    buttonLabel: "Download Model",
  };
}

function updateSemanticUI(
  statusEl: HTMLElement | null,
  downloadBtn: any,
  accepted: boolean,
): void {
  if (!statusEl) return;

  const state = computeSemanticUIState(
    accepted,
    isModelReady(),
    isModelRevisionCurrent(),
    prefs.getEmbeddingModelRevision() !== "",
  );

  statusEl.textContent = state.statusText;
  statusEl.style.color = state.statusColor;

  if (!downloadBtn) return;
  downloadBtn.hidden = state.buttonHidden;
  downloadBtn.disabled = state.buttonDisabled;
  if (state.buttonLabel) {
    downloadBtn.label = state.buttonLabel;
  }
}
