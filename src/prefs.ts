/**
 * Typed wrappers for Zotero.Prefs — provides a single place to read/write
 * all plugin preferences with proper typing and defaults.
 *
 * All pref keys are namespaced under extensions.zotero.zotero-llm-assistant.*
 * via the prefsPrefix defined in package.json. The build system (zotero-plugin-scaffold)
 * automatically strips the prefix in addon/prefs.js, and zotero-plugin-toolkit
 * restores it at runtime.
 *
 * SECURITY NOTE: API keys are stored as plaintext in Zotero's prefs.js file.
 * This is acceptable only for local single-user machines.
 *
 * @module prefs
 */
import { config } from "../package.json";

const PREFIX = config.prefsPrefix;

function getPref(key: string): string | boolean | number | undefined {
  return Zotero.Prefs.get(`${PREFIX}.${key}`, true) as any;
}

function setPref(key: string, value: string | boolean | number): void {
  Zotero.Prefs.set(`${PREFIX}.${key}`, value, true);
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

export function isCloudSharingEnabled(): boolean {
  return getPref("privacy.cloudSharingEnabled") === true;
}

export function setCloudSharingEnabled(enabled: boolean): void {
  setPref("privacy.cloudSharingEnabled", enabled);
}

export function isOnboardingCompleted(): boolean {
  return getPref("onboarding.completed") === true;
}

export function setOnboardingCompleted(completed: boolean): void {
  setPref("onboarding.completed", completed);
}

// ---------------------------------------------------------------------------
// LLM Provider
// ---------------------------------------------------------------------------

export type ProviderName = "ollama" | "gemini" | "openai" | "anthropic" | "custom";

export function getActiveProvider(): ProviderName {
  return (getPref("llm.provider") as ProviderName) || "ollama";
}

export function setActiveProvider(provider: ProviderName): void {
  setPref("llm.provider", provider);
}

// --- Ollama ---
export function getOllamaEndpoint(): string {
  return (getPref("llm.ollama.endpoint") as string) || "http://localhost:11434";
}

export function setOllamaEndpoint(endpoint: string): void {
  setPref("llm.ollama.endpoint", endpoint);
}

export function getOllamaModel(): string {
  return (getPref("llm.ollama.model") as string) || "llama3.2";
}

export function setOllamaModel(model: string): void {
  setPref("llm.ollama.model", model);
}

// --- Gemini ---
export function getGeminiApiKey(): string {
  return (getPref("llm.gemini.apiKey") as string) || "";
}

export function setGeminiApiKey(key: string): void {
  setPref("llm.gemini.apiKey", key);
}

export function getGeminiModel(): string {
  return (getPref("llm.gemini.model") as string) || "gemini-2.0-flash";
}

export function setGeminiModel(model: string): void {
  setPref("llm.gemini.model", model);
}

// --- OpenAI ---
export function getOpenAIApiKey(): string {
  return (getPref("llm.openai.apiKey") as string) || "";
}

export function setOpenAIApiKey(key: string): void {
  setPref("llm.openai.apiKey", key);
}

export function getOpenAIModel(): string {
  return (getPref("llm.openai.model") as string) || "gpt-4o-mini";
}

export function setOpenAIModel(model: string): void {
  setPref("llm.openai.model", model);
}

export function getOpenAIEndpoint(): string {
  return (getPref("llm.openai.endpoint") as string) || "https://api.openai.com";
}

export function setOpenAIEndpoint(endpoint: string): void {
  setPref("llm.openai.endpoint", endpoint);
}

// --- Anthropic ---
export function getAnthropicApiKey(): string {
  return (getPref("llm.anthropic.apiKey") as string) || "";
}

export function setAnthropicApiKey(key: string): void {
  setPref("llm.anthropic.apiKey", key);
}

export function getAnthropicModel(): string {
  return (getPref("llm.anthropic.model") as string) || "claude-sonnet-4-6";
}

export function setAnthropicModel(model: string): void {
  setPref("llm.anthropic.model", model);
}

// --- Custom ---
export function getCustomEndpoint(): string {
  return (getPref("llm.custom.endpoint") as string) || "";
}

export function setCustomEndpoint(endpoint: string): void {
  setPref("llm.custom.endpoint", endpoint);
}

export function getCustomApiKey(): string {
  return (getPref("llm.custom.apiKey") as string) || "";
}

export function setCustomApiKey(key: string): void {
  setPref("llm.custom.apiKey", key);
}

export function getCustomModel(): string {
  return (getPref("llm.custom.model") as string) || "";
}

export function setCustomModel(model: string): void {
  setPref("llm.custom.model", model);
}

// ---------------------------------------------------------------------------
// Per-item privacy mirror (Zotero.Prefs fallback)
// ---------------------------------------------------------------------------

/**
 * Reads per-item private flag from Zotero.Prefs mirror.
 *
 * This exists because IndexedDB is unavailable in the reader panel's privileged
 * chrome context. When `isItemPrivate()` from db.ts fails due to missing
 * IndexedDB, `checkPrivacy()` in client.ts falls back to this Prefs-based
 * mirror so the privacy check is fail-closed rather than fail-open.
 *
 * The mirror stores item IDs as a JSON-encoded array of numbers.
 */
export function isItemPrivatePref(itemId: number): boolean {
  const raw = (getPref("privacy.privateItemIds") as string) || "[]";
  try {
    const ids: number[] = JSON.parse(raw);
    return ids.includes(itemId);
  } catch {
    // Corrupt pref — fail-closed: assume private.
    return true;
  }
}

/**
 * Writes per-item private flag to the Zotero.Prefs mirror.
 *
 * Called alongside `setItemPrivacy()` in privacyToggle.ts to keep the
 * mirror in sync with IndexedDB.
 */
export function setItemPrivatePref(itemId: number, isPrivate: boolean): void {
  const raw = (getPref("privacy.privateItemIds") as string) || "[]";
  let ids: number[];
  try {
    ids = JSON.parse(raw);
    if (!Array.isArray(ids)) ids = [];
  } catch {
    ids = [];
  }

  const index = ids.indexOf(itemId);
  if (isPrivate && index === -1) {
    ids.push(itemId);
  } else if (!isPrivate && index !== -1) {
    ids.splice(index, 1);
  }

  setPref("privacy.privateItemIds", JSON.stringify(ids));
}

// ---------------------------------------------------------------------------
// Embeddings (Phase D)
// ---------------------------------------------------------------------------

/**
 * Whether the user has given consent to download the embedding model.
 * Separate from model readiness — consent can be true even if the download failed.
 */
export function isEmbeddingModelAccepted(): boolean {
  return (getPref("embeddings.modelAccepted") as boolean) ?? false;
}

export function setEmbeddingModelAccepted(accepted: boolean): void {
  setPref("embeddings.modelAccepted", accepted);
}

/**
 * The pinned model revision hash currently installed in the local cache.
 * Used to detect when a plugin update ships a new pinned revision.
 */
export function getEmbeddingModelRevision(): string {
  return (getPref("embeddings.modelRevision") as string) || "";
}

export function setEmbeddingModelRevision(revision: string): void {
  setPref("embeddings.modelRevision", revision);
}

/**
 * Whether semantic embeddings are known to be unsupported in the current
 * Zotero runtime (e.g. Transformers backend incompatibility).
 */
export function isEmbeddingRuntimeUnsupported(): boolean {
  return getPref("embeddings.runtimeUnsupported") === true;
}

export function setEmbeddingRuntimeUnsupported(unsupported: boolean): void {
  setPref("embeddings.runtimeUnsupported", unsupported);
}

/**
 * Last known runtime incompatibility reason for semantic embeddings.
 */
export function getEmbeddingRuntimeUnsupportedReason(): string {
  return (getPref("embeddings.runtimeUnsupportedReason") as string) || "";
}

export function setEmbeddingRuntimeUnsupportedReason(reason: string): void {
  setPref("embeddings.runtimeUnsupportedReason", reason);
}
