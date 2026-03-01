/**
 * HTTP request utilities for the Zotero extension context.
 *
 * Prefers Zotero's native HTTP client (`Zotero.HTTP.request`) which properly
 * handles system proxy settings, SSL/TLS, and the Mozilla network stack.
 * Falls back to `fetch()` for tests or non-Zotero contexts.
 *
 * Why not just use fetch()?
 *   In Zotero's privileged chrome extension context, `fetch()` may not
 *   correctly route through system proxy settings or may not resolve DNS
 *   for external hosts. `Zotero.HTTP.request()` uses the same
 *   XMLHttpRequest-based network stack as the rest of Zotero (sync,
 *   attachment downloads, etc.) and is the recommended approach for plugin
 *   HTTP calls.
 *
 * Note: `chatStream()` methods still use fetch() directly since streaming
 * requires the Fetch API's ReadableStream. The non-stream fallback in
 * readerPanel.ts catches stream failures and retries via `chat()`, which
 * routes through this module.
 *
 * @module utils/http
 */

/** Simplified HTTP response wrapper. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  text: string;
  json(): any;
}

/**
 * Sends an HTTP POST request.
 * Prefers Zotero.HTTP.request, falls back to fetch().
 *
 * @param url - The request URL.
 * @param body - JSON string request body.
 * @param headers - Request headers.
 * @param timeoutMs - Timeout in milliseconds.
 */
export async function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  return httpRequest("POST", url, { body, headers, timeoutMs });
}

/**
 * Sends an HTTP GET request.
 * Prefers Zotero.HTTP.request, falls back to fetch().
 */
export async function httpGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<HttpResponse> {
  return httpRequest("GET", url, { headers, timeoutMs });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function httpRequest(
  method: string,
  url: string,
  opts: { body?: string; headers: Record<string, string>; timeoutMs: number },
): Promise<HttpResponse> {
  // Prefer Zotero's HTTP client when available — it uses XMLHttpRequest
  // under the hood and properly routes through the system network stack.
  const ZoteroHTTP = (globalThis as any).Zotero?.HTTP;
  if (ZoteroHTTP?.request) {
    try {
      const xhr = await ZoteroHTTP.request(method, url, {
        body: opts.body,
        headers: opts.headers,
        timeout: opts.timeoutMs,
      });
      const text: string = xhr.responseText ?? "";
      return {
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text,
        json() {
          return JSON.parse(text || "{}");
        },
      };
    } catch (err: any) {
      // Zotero.HTTP throws on non-2xx with { status, xmlhttp }.
      if (err.xmlhttp) {
        const text: string = err.xmlhttp.responseText ?? "";
        return {
          ok: false,
          status: err.status ?? err.xmlhttp.status ?? 0,
          text,
          json() {
            try {
              return JSON.parse(text || "{}");
            } catch {
              return {};
            }
          },
        };
      }
      // Transport errors (timeout, DNS, connection refused) — re-throw.
      throw err;
    }
  }

  // Fallback: fetch() for tests or non-Zotero contexts.
  const response = await fetch(url, {
    method,
    headers: opts.headers,
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
    json() {
      return JSON.parse(text || "{}");
    },
  };
}
