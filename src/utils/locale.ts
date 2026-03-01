/**
 * Localization helpers — wraps Fluent l10n for the plugin.
 *
 * @module utils/locale
 */
import { config } from "../../package.json";

export function initLocale() {
  // Locale initialization is handled by the toolkit and FTL file loading.
  // This function is a hook point for any additional locale setup.
  ztoolkit.log("Locale initialized");
}

/**
 * Returns the full l10n ID prefixed with the addon ref.
 * Usage: getLocaleID("assistant-panel-head") → "zotero-llm-assistant-assistant-panel-head"
 */
export function getLocaleID(id: string): string {
  return `${config.addonRef}-${id}`;
}

/**
 * Retrieves a localized string by its key from the addon's FTL files.
 */
export function getString(key: string, params?: Record<string, string>): string {
  // In Zotero 7, strings are loaded via Fluent (FTL files).
  // The toolkit's getString method handles lookup.
  // For now, fall back to the key itself if not found.
  try {
    return (ztoolkit as any).Locale?.getString?.(key) ?? key;
  } catch {
    return key;
  }
}
