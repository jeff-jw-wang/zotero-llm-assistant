/* Default preferences for Zotero LLM Assistant.
 *
 * The prefix is stripped by the build system (zotero-plugin-scaffold).
 * At runtime these become: extensions.zotero.zotero-llm-assistant.<key>
 *
 * SECURITY NOTE: API keys stored here are plaintext in prefs.js inside the
 * user's Zotero profile directory. This is acceptable for a local single-user
 * machine only. See docs/SECURITY.md for the full threat model.
 */

// --- Privacy ---
pref("privacy.cloudSharingEnabled", false);

// --- LLM Provider ---
pref("llm.provider", "ollama");
pref("llm.ollama.endpoint", "http://localhost:11434");
pref("llm.ollama.model", "");            // empty = auto-detect installed model
pref("llm.ollama.numCtx", 16384);       // cap by available RAM, not model claim
pref("llm.gemini.apiKey", "");
pref("llm.gemini.model", "");           // empty = auto-detect from provider
pref("llm.openai.apiKey", "");
pref("llm.openai.model", "");           // empty = auto-detect from provider
pref("llm.openai.endpoint", "https://api.openai.com");
pref("llm.anthropic.apiKey", "");
pref("llm.anthropic.model", "claude-haiku-5-5");
pref("llm.anthropic.effort", "");        // empty = model default
pref("llm.custom.endpoint", "");
pref("llm.custom.apiKey", "");
pref("llm.custom.model", "");

pref("embeddings.methodVersion", 0);  // bumped by embedder to invalidate stale vectors

// --- UI ---
pref("onboarding.completed", false);
