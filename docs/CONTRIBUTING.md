# Contributing Guide

Thank you for considering contributing to Zotero LLM Assistant! This document
covers the conventions, tooling, and review expectations for pull requests.

## Development Setup

See [DEVELOPMENT.md](./DEVELOPMENT.md) for full setup instructions:

```bash
git clone <repo-url>
cd zotero-llm-assistant
npm install
npm run build        # verify clean build
npm run test:chunker # run existing test suite
```

## Code Style

### TypeScript Configuration

The project uses `"lib": ["ESNext"]` with no DOM types. This means:

- **No `HTMLElement`, `Document`, `Worker` types** from `lib.dom.d.ts`. The
  Zotero XUL/Gecko runtime provides these at runtime, but we don't import them.
- Use casts for browser APIs:
  ```typescript
  (globalThis as any).indexedDB.open(...)
  (reader as ReadableStreamDefaultReader<Uint8Array>).read()
  { streaming: true } as TextDecodeOptions
  ```
- Worker event handlers need `any` casts:
  ```typescript
  (this.worker as any).onmessage = (e: any) => { ... };
  ```

### Naming Conventions

- **Files**: `camelCase.ts` for modules, `UPPER_CASE.md` for docs.
- **Functions**: `camelCase`. Exported functions have JSDoc.
- **Interfaces**: `PascalCase`. All exported types have JSDoc.
- **Constants**: `UPPER_SNAKE_CASE` for true constants, `camelCase` for
  module-level mutable state.

### Privacy-First Defaults

- Cloud sharing is **off** by default. Every feature must work in local-only
  mode (Ollama).
- Items default to **not private**. The global cloud toggle must be explicitly
  enabled.
- API keys are stored in `Zotero.Prefs` (plaintext). UI warns users this is
  not suitable for shared machines.
- Private items are **fully excluded** from cloud LLM context — no placeholder,
  no count revealed.

### Security Rules

- **Citation whitelists**: Only page numbers or chunk IDs from the extractor are
  rendered as clickable links. Model-invented citations are shown as plain or
  struck-through text.
- **SSRF validation**: All user-editable endpoint URLs pass through
  `validateEndpointURL()` (HTTPS-only, private IP block, hostname blocklist).
- **Prompt injection defense**: Paper text is wrapped in `<document>` delimiters;
  the system prompt marks it as untrusted data.
- **Embedding consent**: Model download requires explicit user acceptance. No
  automatic background downloads.

## Adding a New LLM Provider

1. Create `src/modules/llm/providers/yourprovider.ts` implementing `ILLMProvider`:
   ```typescript
   export class YourProvider implements ILLMProvider {
     isCloud = true; // or false for local providers
     async chat(messages, options): Promise<string> { ... }
     async *chatStream(messages, options): AsyncGenerator<StreamChunk> { ... }
     async isAvailable(): Promise<boolean> { ... }
   }
   ```

2. Add a case in `src/modules/llm/client.ts` `createProvider()` switch:
   ```typescript
   case "yourprovider": return new YourProvider(...);
   ```

3. Add prefs in `src/prefs.ts` (API key, model, endpoint getters/setters).

4. Add UI in `addon/content/preferences.xhtml` (section + fields) and
   `src/modules/ui/settingsPane.ts` (bindings).

5. Add FTL strings in `addon/locale/en-US/preferences.ftl`.

See [LLM_PROVIDERS.md](./LLM_PROVIDERS.md) for the full interface contract and
streaming protocol details.

## Adding a New UI Panel

Follow the pattern in `src/modules/ui/readerPanel.ts`:

1. Use `Zotero.ItemPaneManager.registerSection()`.
2. Build DOM imperatively (no framework — Zotero's XUL environment).
3. Use `onItemChange` + `setEnabled(tabType === "reader"|"library")` to
   control visibility.
4. Register in `src/hooks.ts` `onStartup()`.

## Pull Request Checklist

Before submitting a PR, verify:

- [ ] `npm run build` — zero TypeScript errors, clean XPI output
- [ ] `npm run test:chunker` — all chunker tests pass
- [ ] `npm run test:phase-c` — all Phase C tests pass (if applicable)
- [ ] `npm run test:phase-d` — all Phase D tests pass (if applicable)
- [ ] JSDoc on all exported functions and types
- [ ] No secrets or API keys in committed code
- [ ] Privacy-first: new features work in local-only mode
- [ ] Security: citation rendering uses whitelist pattern
- [ ] If adding a dependency: justified in PR description, tree-shaking verified

## Testing Approach

The project uses a **unit-focused** strategy with mocks where needed:

- **Pure functions** (scoring, tokenization, export): tested directly, no mocks.
- **Zotero-dependent code** (DB operations, notifiers): tested with IndexedDB
  mocks (`fake-indexeddb` or inline mock).
- **Provider integration**: not unit-tested (requires live API); verified via
  manual testing in Zotero.

Test files live in `test/` and follow the naming convention `*.test.ts`.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module dependency graph,
data flow diagrams, and design decisions.

## Commit Messages

Use conventional commits:

```
feat: add conversation history browser
fix: correct normKeyword clamping in scoreChunks
docs: update STORAGE.md with v2 migration details
test: add cosineSimilarity edge case tests
```
