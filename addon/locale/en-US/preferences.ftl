pref-title = LLM Assistant Settings
pref-provider-label = LLM Provider
pref-api-key-label = API Key
pref-model-label = Model
pref-detect-models =
    .label = Detect
pref-ollama-numctx-label = Context size
pref-ollama-numctx-hint = Tokens of context to give the local model (num_ctx). This is limited by your RAM, not by what the model advertises — lower it if Ollama starts swapping. 16384 suits an 8 GB machine; raise it if you have more.
pref-effort-label = Effort
pref-effort-hint = Reasoning effort. Lower is cheaper and faster; grounded questions about a paper rarely need more than Low or Medium.
pref-endpoint-label = Endpoint URL

pref-ollama-hint = Ollama runs locally — no data leaves your machine. Install from ollama.com.
pref-ollama-check =
    .label = Check Ollama
pref-ollama-install =
    .label = Install Ollama
pref-gemini-hint = Free with a Google account — no credit card required. Get a key at aistudio.google.com.
pref-openai-hint = Use the default endpoint for api.openai.com, or enter a compatible base URL.
pref-anthropic-hint = Requires an Anthropic API key from console.anthropic.com.

pref-custom-warning = ⚠ This endpoint will receive your paper content and API key. Only use trusted HTTPS services. Private and local addresses are blocked.

pref-api-key-warning = API keys are stored as plaintext in your Zotero profile. Not suitable for shared machines.

pref-semantic-label = Semantic Search
pref-semantic-toggle =
    .label = Enable semantic search (embedding-based)
pref-semantic-note = Ranks results by similarity as well as by keywords. On first use this tries to load a small embedding model (~25 MB, from Hugging Face). If that model cannot load inside Zotero, a simpler built-in match on shared words and spelling is used instead, which does not understand meaning. Either way it runs entirely on your machine.

pref-privacy-label = Privacy
pref-cloud-sharing =
    .label = Allow sending paper content to cloud LLMs
pref-cloud-sharing-note = When disabled, only Ollama (local) can be used. Per-paper overrides are set in the reader panel.

pref-help = { $name } v{ $version } — built { $time }
