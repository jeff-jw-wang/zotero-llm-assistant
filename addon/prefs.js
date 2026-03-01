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
pref("llm.ollama.model", "llama3.2");
pref("llm.gemini.apiKey", "");
pref("llm.gemini.model", "gemini-2.0-flash");
pref("llm.openai.apiKey", "");
pref("llm.openai.model", "gpt-4o-mini");
pref("llm.openai.endpoint", "https://api.openai.com");
pref("llm.anthropic.apiKey", "");
pref("llm.anthropic.model", "claude-sonnet-4-6");
pref("llm.custom.endpoint", "");
pref("llm.custom.apiKey", "");
pref("llm.custom.model", "");

// --- UI ---
pref("onboarding.completed", false);
