# LLM Providers

How to add a new LLM provider to the Zotero LLM Assistant.

---

## ILLMProvider Interface

Every provider implements the `ILLMProvider` interface defined in
`src/modules/llm/types.ts`:

```typescript
interface ILLMProvider {
  /** Human-readable name (e.g. "Ollama", "Google Gemini"). */
  readonly name: string;

  /** Whether this provider sends data to a cloud API (vs. local). */
  readonly isCloud: boolean;

  /** Full (non-streaming) chat completion. */
  chat(messages: LLMMessage[], options: ChatOptions): Promise<string>;

  /** Streaming chat completion — yields incremental text deltas. */
  chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown>;

  /** Connectivity/configuration health check. */
  isAvailable(): Promise<boolean>;
}
```

### Key types

| Type | Purpose |
|------|---------|
| `LLMMessage` | `{ role: "system" \| "user" \| "assistant", content: string }` |
| `StreamChunk` | `{ text: string, done: boolean }` — the final chunk has `done: true` |
| `ChatOptions` | `{ model: string, maxTokens?, temperature?, stream? }` |

---

## `isCloud` Semantics

The `isCloud` flag drives the privacy enforcement layer in `client.ts`:

- **`isCloud: false`** (e.g. Ollama) — The provider runs locally. No privacy
  checks are performed. Paper content is never sent over the network.
- **`isCloud: true`** (e.g. Gemini, OpenAI, Anthropic) — Paper content is sent
  to a remote API. Before every call, `checkPrivacy()` verifies:
  1. The global cloud-sharing toggle is enabled (`privacy.cloudSharingEnabled`)
  2. The specific item is not marked as private (`isItemPrivate(itemId)`)

  If either check fails, the call is blocked with a user-facing message.

**Rule:** If your provider makes *any* network request to an external server
with user paper content, set `isCloud: true`.

---

## Streaming Protocol

The `chatStream()` method returns an `AsyncGenerator<StreamChunk>`:

```typescript
async function* chatStream(
  messages: LLMMessage[],
  options: ChatOptions,
): AsyncGenerator<StreamChunk, void, unknown> {
  // Make HTTP request to provider...
  // Parse streaming response (SSE, ndjson, etc.)...

  for (/* each parsed delta */) {
    yield { text: deltaText, done: false };
  }

  // Final chunk signals end of stream:
  yield { text: "", done: true };
}
```

### Requirements

- Each `yield` produces the **incremental** text delta, not the accumulated text
- The UI accumulates deltas and re-renders on each yield
- The final yield **must** have `done: true` and may have an empty `text`
- If the provider does not support streaming, implement `chatStream()` by
  calling `chat()` and yielding the full response as a single chunk:

```typescript
async function* chatStream(messages, options) {
  const full = await this.chat(messages, options);
  yield { text: full, done: true };
}
```

---

## How to Register a New Provider

### 1. Create the provider class

Create `src/modules/llm/providers/<name>.ts`:

```typescript
import type { ILLMProvider, LLMMessage, ChatOptions, StreamChunk } from "../types";

export class MyProvider implements ILLMProvider {
  readonly name = "My Provider";
  readonly isCloud = true; // or false for local

  constructor(private apiKey: string) {}

  async chat(messages: LLMMessage[], options: ChatOptions): Promise<string> {
    // Implement full-response call
  }

  async *chatStream(
    messages: LLMMessage[],
    options: ChatOptions,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    // Implement streaming call
  }

  async isAvailable(): Promise<boolean> {
    // Return true if provider is reachable and API key is valid
  }
}
```

### 2. Add preference getters/setters

In `src/prefs.ts`, add getter/setter functions for the provider's settings
(API key, model name, endpoint if configurable):

```typescript
export function getMyProviderApiKey(): string {
  return Zotero.Prefs.get(`${PREFIX}.myProvider.apiKey`, true) as string ?? "";
}
export function getMyProviderModel(): string {
  return Zotero.Prefs.get(`${PREFIX}.myProvider.model`, true) as string ?? "default-model";
}
```

### 3. Register in `client.ts`

Add a `case` to the `createProvider()` switch:

```typescript
case "myprovider": {
  const apiKey = prefs.getMyProviderApiKey();
  if (!apiKey) {
    throw new Error("My Provider API key is not set. Go to Settings > LLM Assistant.");
  }
  return new MyProvider(apiKey);
}
```

Add corresponding entries in `getChatOptions()` and `autoDetectProvider()`.

### 4. Add Settings UI

- Add a section in `addon/content/preferences.xhtml` with the provider's
  config fields (API key input, model dropdown/input)
- Add the provider to the dropdown in the general section
- Add the FTL localization strings in `addon/locale/en-US/preferences.ftl`
- Update `src/modules/ui/settingsPane.ts` to handle show/hide and binding

### 5. Update docs

- Add the provider to the Module Map in `docs/ARCHITECTURE.md`
- Update this file with any provider-specific notes

---

## Existing Providers

### Ollama (`src/modules/llm/providers/ollama.ts`)

- **Type:** Local (`isCloud: false`)
- **API:** `POST /api/chat` with ndjson streaming
- **Default endpoint:** `http://localhost:11434`
- **Auth:** None (local server)
- **Streaming:** ndjson — each line is a JSON object with `message.content`
  and `done` boolean

### Gemini (`src/modules/llm/providers/gemini.ts`)

- **Type:** Cloud (`isCloud: true`)
- **API:** Google Generative AI REST API with SSE streaming
- **Auth:** API key (free with Google account)
- **Default model:** `gemini-2.0-flash`
- **Streaming:** Server-Sent Events — parse `data:` lines as JSON with
  `candidates[0].content.parts[0].text` deltas

---

## Testing Checklist

When adding a new provider, verify:

- [ ] `isAvailable()` returns `true` with valid config, `false` otherwise
- [ ] `chat()` returns a complete response string
- [ ] `chatStream()` yields incremental deltas; final chunk has `done: true`
- [ ] Privacy check blocks cloud calls when `cloudSharingEnabled` is off
- [ ] Privacy check blocks cloud calls for items marked private
- [ ] Settings UI correctly shows/hides provider section on dropdown change
- [ ] API key is stored/retrieved correctly via `Zotero.Prefs`
- [ ] `autoDetectProvider()` considers the new provider in priority order
- [ ] `getChatOptions()` returns the correct model for the provider
- [ ] Build succeeds with zero TS errors (`npm run build`)
