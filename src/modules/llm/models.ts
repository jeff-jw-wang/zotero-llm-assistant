/**
 * Model registry and runtime discovery.
 *
 * Replaces the hardcoded model names and the hardcoded `MODEL_TOKEN_CAPS`
 * lookup table that `utils/tokens.ts` used to own. Both went stale between
 * plugin releases, and the token-cap table failed in a particularly bad way:
 * it keyed caps on exact model ID strings and fell back to 8K for anything it
 * did not recognise, so a current model silently received an 8K input budget
 * against a 1M context window.
 *
 * The fix is to stop encoding facts about the world in source:
 *
 *   1. **Discover** — ask the provider what models exist and how big their
 *      context windows are. Anthropic, Gemini and Ollama all report this.
 *   2. **Infer** — where a provider does not report a window (OpenAI), fall
 *      back to a per-family heuristic.
 *   3. **Fall back generously** — an unknown model gets
 *      {@link FALLBACK_CONTEXT_WINDOW}, not a punitive floor. Under-using a
 *      window costs answer quality; over-estimating it produces a clear API
 *      error that surfaces to the user.
 *
 * Discovery results are cached in memory for the session, keyed by provider
 * and endpoint, so the settings pane and the RAG pipeline share one lookup.
 *
 * @module modules/llm/models
 */
import { httpGet, httpPost } from "../../utils/http";
import type { ProviderName } from "../../prefs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A model offered by a provider, as reported by discovery or inferred. */
export interface ModelInfo {
  /** Model identifier to send in API requests. */
  id: string;
  /** Human-readable name for the settings dropdown. */
  label: string;
  /**
   * Maximum input (context) tokens, or `undefined` when the provider does not
   * report it. Callers should use {@link resolveContextWindow} rather than
   * reading this directly, so the inference chain applies.
   */
  contextWindow?: number;
  /** Maximum output tokens, when reported. */
  maxOutputTokens?: number;
  /** Whether the model runs locally (no network, no per-token cost). */
  isLocal: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Context window assumed for a model no provider reported and no family
 * pattern matched.
 *
 * Deliberately generous. The previous behaviour (8K) silently crippled every
 * model released after the table was last edited. 128K is conservative enough
 * to be accepted by essentially every current cloud model while being large
 * enough that a full paper fits.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Context window assumed for a local model when Ollama does not report one.
 *
 * Lower than the cloud fallback on purpose: for a local model the binding
 * constraint is the user's RAM, not the model's advertised window. See
 * {@link resolveInputBudget}.
 */
export const FALLBACK_LOCAL_CONTEXT_WINDOW = 32_768;

/** Tokens held back from the input budget for the model's own response. */
export const DEFAULT_OUTPUT_RESERVE = 8_000;

/** How long a discovery result stays valid within a session (ms). */
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/** Timeout for discovery calls — these run on the settings pane's UI path. */
const DISCOVERY_TIMEOUT_MS = 8_000;

const ANTHROPIC_API_VERSION = "2023-06-01";

/**
 * Per-model input caps that exist for **billing** rather than capability
 * reasons, keyed by a substring of the model ID.
 *
 * Some models change price band above a prompt size. Claude Haiku 5.5 is
 * billed at $0.10/$0.50 per MTok up to 100K input tokens and $0.50/$2.50
 * above it — a 5x cliff. Staying under the threshold is worth far more than
 * the extra context, so cap the input budget there by default.
 */
const PRICING_BAND_CAPS: Array<{ match: string; cap: number; reason: string }> =
  [
    {
      match: "haiku-5-5",
      cap: 100_000,
      reason: "Haiku 5.5 input price rises 5x above 100K tokens",
    },
  ];

/**
 * Context-window heuristics by model-family pattern, used only when the
 * provider does not report a window.
 *
 * Ordered most specific first; the first match wins. Values are the
 * conservative end of each family so that a stale entry under-reaches rather
 * than producing API errors.
 */
const FAMILY_WINDOWS: Array<{ pattern: RegExp; window: number }> = [
  // Anthropic — the 5.x generation moved to 1M; 4.5-era Haiku stayed at 200K.
  { pattern: /^claude-(opus|sonnet|haiku|fable|mythos)-5/, window: 1_000_000 },
  { pattern: /^claude-opus-4-[678]/, window: 1_000_000 },
  { pattern: /^claude-/, window: 200_000 },
  // Google — the Gemini line has been 1M for several generations.
  { pattern: /^gemini-/, window: 1_000_000 },
  // OpenAI does not report context windows on /v1/models, so these matter.
  { pattern: /^gpt-5/, window: 400_000 },
  { pattern: /^gpt-4\.1/, window: 1_000_000 },
  { pattern: /^(gpt-4o|gpt-4-turbo)/, window: 128_000 },
  { pattern: /^o[134]/, window: 200_000 },
];

// ---------------------------------------------------------------------------
// Discovery cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  models: ModelInfo[];
  fetchedAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();

/** Clears cached discovery results (e.g. after the user changes an API key). */
export function clearModelCache(): void {
  discoveryCache.clear();
}

function cacheKey(provider: ProviderName, endpoint: string): string {
  return `${provider}::${endpoint}`;
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

/**
 * Infers a context window from the model ID alone.
 *
 * Used when discovery is unavailable (no API key yet, provider offline, or a
 * provider that does not report windows).
 */
export function inferContextWindow(
  provider: ProviderName,
  modelId: string,
): number {
  const id = modelId.trim().toLowerCase();

  for (const { pattern, window } of FAMILY_WINDOWS) {
    if (pattern.test(id)) return window;
  }

  return provider === "ollama"
    ? FALLBACK_LOCAL_CONTEXT_WINDOW
    : FALLBACK_CONTEXT_WINDOW;
}

/**
 * Applies the billing-band cap, if any, to a context window.
 *
 * @returns The capped window and the reason, when a cap applied.
 */
export function applyPricingBandCap(
  modelId: string,
  window: number,
): { window: number; cappedBy?: string } {
  const id = modelId.trim().toLowerCase();

  for (const band of PRICING_BAND_CAPS) {
    if (id.includes(band.match) && window > band.cap) {
      return { window: band.cap, cappedBy: band.reason };
    }
  }

  return { window };
}

/**
 * Computes the usable **input** token budget for a request.
 *
 * Chain: reported window (or inferred) → billing-band cap → minus the output
 * reserve. For local models the configured `num_ctx` overrides the model's
 * advertised window, because what the model claims to support and what fits in
 * the user's RAM are different numbers.
 *
 * @param contextWindow - Window from discovery, or undefined to infer.
 * @param localNumCtx - Configured Ollama `num_ctx`, for local providers only.
 */
export function resolveInputBudget(
  provider: ProviderName,
  modelId: string,
  contextWindow?: number,
  localNumCtx?: number,
): { budget: number; window: number; cappedBy?: string } {
  let window = contextWindow ?? inferContextWindow(provider, modelId);

  // Local: RAM is the real limit, and num_ctx is the user's statement of it.
  if (provider === "ollama" && localNumCtx && localNumCtx > 0) {
    window = Math.min(window, localNumCtx);
  }

  const capped = applyPricingBandCap(modelId, window);
  const reserve = Math.min(DEFAULT_OUTPUT_RESERVE, Math.floor(capped.window / 4));

  return {
    budget: Math.max(1_000, capped.window - reserve),
    window: capped.window,
    cappedBy: capped.cappedBy,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Lists the models a provider currently offers.
 *
 * Never throws — an unreachable provider or missing credential yields an empty
 * array, and callers fall back to the user's configured value plus inference.
 *
 * @param provider - Provider to query.
 * @param opts.endpoint - Base URL (Ollama, OpenAI, custom endpoints).
 * @param opts.apiKey - Credential, where the provider needs one.
 * @param opts.force - Bypass the session cache.
 */
export async function listModels(
  provider: ProviderName,
  opts: { endpoint?: string; apiKey?: string; force?: boolean } = {},
): Promise<ModelInfo[]> {
  const endpoint = opts.endpoint ?? "";
  const key = cacheKey(provider, endpoint);

  if (!opts.force) {
    const hit = discoveryCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < DISCOVERY_TTL_MS) {
      return hit.models;
    }
  }

  let models: ModelInfo[] = [];
  try {
    switch (provider) {
      case "ollama":
        models = await listOllamaModels(endpoint);
        break;
      case "anthropic":
        models = await listAnthropicModels(opts.apiKey ?? "");
        break;
      case "openai":
      case "custom":
        models = await listOpenAICompatibleModels(endpoint, opts.apiKey ?? "");
        break;
      case "gemini":
        models = await listGeminiModels(opts.apiKey ?? "");
        break;
    }
  } catch {
    // Discovery is best-effort: the settings pane keeps the free-text field,
    // and the pipeline falls back to inferContextWindow().
    models = [];
  }

  discoveryCache.set(key, { models, fetchedAt: Date.now() });
  return models;
}

/**
 * Resolves the context window for one model, preferring discovery.
 *
 * Falls back to {@link inferContextWindow} when the model is not in the
 * discovered list or the provider does not report windows.
 */
export async function resolveContextWindow(
  provider: ProviderName,
  modelId: string,
  opts: { endpoint?: string; apiKey?: string } = {},
): Promise<number> {
  const models = await listModels(provider, opts);
  const match = models.find((m) => m.id === modelId);

  if (match?.contextWindow) return match.contextWindow;

  // Ollama reports context length per model via /api/show, not /api/tags.
  if (provider === "ollama" && opts.endpoint) {
    const shown = await showOllamaContextLength(opts.endpoint, modelId);
    if (shown) return shown;
  }

  return inferContextWindow(provider, modelId);
}

// ---------------------------------------------------------------------------
// Per-provider discovery
// ---------------------------------------------------------------------------

/** Ollama: `GET /api/tags` lists locally installed models. */
async function listOllamaModels(endpoint: string): Promise<ModelInfo[]> {
  if (!endpoint) return [];

  const res = await httpGet(`${endpoint}/api/tags`, {}, DISCOVERY_TIMEOUT_MS);
  if (!res.ok) return [];

  const body = res.json();
  const entries: any[] = Array.isArray(body?.models) ? body.models : [];

  return entries
    .filter((m) => typeof m?.name === "string")
    .map((m) => {
      const size = m?.details?.parameter_size;
      return {
        id: m.name as string,
        label: size ? `${m.name} (${size})` : (m.name as string),
        isLocal: true,
      };
    });
}

/**
 * Ollama: `POST /api/show` reports the model's trained context length under an
 * architecture-prefixed key, e.g. `qwen3.context_length`.
 */
async function showOllamaContextLength(
  endpoint: string,
  modelId: string,
): Promise<number | undefined> {
  try {
    const res = await httpPost(
      `${endpoint}/api/show`,
      JSON.stringify({ model: modelId }),
      { "Content-Type": "application/json" },
      DISCOVERY_TIMEOUT_MS,
    );
    if (!res.ok) return undefined;

    const info = res.json()?.model_info;
    if (!info || typeof info !== "object") return undefined;

    for (const [k, v] of Object.entries(info)) {
      if (k.endsWith(".context_length") && typeof v === "number" && v > 0) {
        return v;
      }
    }
  } catch {
    // Fall through to inference.
  }
  return undefined;
}

/**
 * Anthropic: `GET /v1/models` reports `max_input_tokens` and `max_tokens`
 * alongside the ID, so no heuristic is needed.
 */
async function listAnthropicModels(apiKey: string): Promise<ModelInfo[]> {
  if (!apiKey) return [];

  const res = await httpGet(
    "https://api.anthropic.com/v1/models?limit=100",
    {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    DISCOVERY_TIMEOUT_MS,
  );
  if (!res.ok) return [];

  const entries: any[] = res.json()?.data ?? [];

  return entries
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id as string,
      label: (m.display_name as string) || (m.id as string),
      contextWindow:
        typeof m.max_input_tokens === "number" ? m.max_input_tokens : undefined,
      maxOutputTokens:
        typeof m.max_tokens === "number" ? m.max_tokens : undefined,
      isLocal: false,
    }));
}

/**
 * OpenAI and OpenAI-compatible endpoints: `GET /v1/models` lists IDs but does
 * **not** report context windows, so those come from family inference.
 */
async function listOpenAICompatibleModels(
  endpoint: string,
  apiKey: string,
): Promise<ModelInfo[]> {
  if (!endpoint || !apiKey) return [];

  const base = endpoint.replace(/\/+$/, "");
  const res = await httpGet(
    `${base}/v1/models`,
    { Authorization: `Bearer ${apiKey}` },
    DISCOVERY_TIMEOUT_MS,
  );
  if (!res.ok) return [];

  const entries: any[] = res.json()?.data ?? [];

  return entries
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id as string,
      label: m.id as string,
      isLocal: false,
    }));
}

/**
 * Gemini: `GET /v1beta/models` reports `inputTokenLimit` and
 * `outputTokenLimit`. Only models supporting `generateContent` are usable here.
 */
async function listGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  if (!apiKey) return [];

  const res = await httpGet(
    `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(apiKey)}`,
    {},
    DISCOVERY_TIMEOUT_MS,
  );
  if (!res.ok) return [];

  const entries: any[] = res.json()?.models ?? [];

  return entries
    .filter((m) => {
      const methods: string[] = m?.supportedGenerationMethods ?? [];
      return typeof m?.name === "string" && methods.includes("generateContent");
    })
    .map((m) => {
      // Gemini returns fully-qualified names ("models/gemini-3-flash").
      const id = (m.name as string).replace(/^models\//, "");
      return {
        id,
        label: (m.displayName as string) || id,
        contextWindow:
          typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
        maxOutputTokens:
          typeof m.outputTokenLimit === "number"
            ? m.outputTokenLimit
            : undefined,
        isLocal: false,
      };
    });
}
