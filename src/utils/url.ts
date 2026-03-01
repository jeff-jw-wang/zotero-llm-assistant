/**
 * SSRF validator for custom LLM endpoint URLs.
 *
 * Enforces:
 * 1. HTTPS only (reject http, ftp, etc.)
 * 2. IPv4 blocked ranges: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12,
 *    192.168.0.0/16, 169.254.0.0/16, 0.0.0.0
 * 3. IPv6 blocked ranges: ::1, fe80::/10, fc00::/7, ::ffff:0:0/96
 * 4. Hostname blocklist: localhost, *.local, *.internal, *.corp, *.home
 * 5. Best-effort preflight DNS check (secondary layer — see note below)
 *
 * DNS rebinding note:
 *   The preflight DNS check resolves the hostname and verifies the IP is not
 *   in a blocked range. However, app-level JS cannot guarantee the same IP is
 *   used for the actual TCP connection (DNS TTL may expire between check and
 *   connect). Hostname and IP blocklists (rules 2–4) are the PRIMARY control;
 *   DNS preflight is a SECONDARY layer to catch obvious rebinding.
 *
 * @module utils/url
 * @see docs/SECURITY.md
 */

/** Result of URL validation. */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Hostname blocklist
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.corp$/i,
  /\.home$/i,
  /\.localhost$/i,
  /\.localdomain$/i,
];

// ---------------------------------------------------------------------------
// IPv4 blocked ranges
// ---------------------------------------------------------------------------

/**
 * Checks if an IPv4 address string falls in a blocked private/reserved range.
 */
function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false; // Not a valid IPv4 — let other checks handle it.
  }

  const [a, b] = parts;

  // 0.0.0.0
  if (parts.every((p) => p === 0)) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8 (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  return false;
}

// ---------------------------------------------------------------------------
// IPv6 blocked ranges
// ---------------------------------------------------------------------------

/**
 * Checks if an IPv6 address string falls in a blocked range.
 * Handles full and abbreviated forms, including IPv4-mapped addresses.
 */
function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // ::1 (loopback)
  if (normalized === "::1" || normalized === "0000:0000:0000:0000:0000:0000:0000:0001") {
    return true;
  }

  // :: (unspecified)
  if (normalized === "::" || normalized === "0000:0000:0000:0000:0000:0000:0000:0000") {
    return true;
  }

  // Expand :: notation for prefix checks.
  const expanded = expandIPv6(normalized);
  if (!expanded) return false;

  const groups = expanded.split(":").map((g) => parseInt(g, 16));

  // fe80::/10 (link-local): first 10 bits = 1111 1110 10
  if (groups[0] !== undefined && (groups[0] & 0xffc0) === 0xfe80) return true;

  // fc00::/7 (ULA): first 7 bits = 1111 110
  if (groups[0] !== undefined && (groups[0] & 0xfe00) === 0xfc00) return true;

  // ::ffff:0:0/96 (IPv4-mapped): first 96 bits = 0...0 ffff
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    // The last 32 bits are the IPv4 address.
    const ipv4 = `${(groups[6]! >> 8) & 0xff}.${groups[6]! & 0xff}.${(groups[7]! >> 8) & 0xff}.${groups[7]! & 0xff}`;
    return isBlockedIPv4(ipv4);
  }

  return false;
}

/**
 * Expands an abbreviated IPv6 address to its full 8-group form.
 * Returns null if the input is not a valid IPv6 address.
 */
function expandIPv6(ip: string): string | null {
  // Handle IPv4-mapped suffix like ::ffff:192.168.1.1
  let processed = ip;
  const ipv4Suffix = processed.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Suffix) {
    const parts = ipv4Suffix[1]!.split(".").map(Number);
    const hex1 = ((parts[0]! << 8) | parts[1]!).toString(16).padStart(4, "0");
    const hex2 = ((parts[2]! << 8) | parts[3]!).toString(16).padStart(4, "0");
    processed = processed.replace(ipv4Suffix[0], `:${hex1}:${hex2}`);
  }

  const halves = processed.split("::");
  if (halves.length > 2) return null; // Invalid: more than one ::

  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    const middle = Array(missing).fill("0000");
    const full = [...left, ...middle, ...right];
    return full.map((g: string) => g.padStart(4, "0")).join(":");
  }

  const groups = processed.split(":");
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, "0")).join(":");
}

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

/**
 * Validates a custom LLM endpoint URL against the SSRF policy.
 *
 * Returns { valid: true } if the URL passes all checks, or
 * { valid: false, error: "..." } with a human-readable reason.
 *
 * @param urlString - The URL to validate.
 */
export function validateEndpointURL(urlString: string): ValidationResult {
  // Parse the URL.
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: "Invalid URL format." };
  }

  // Rule 1: HTTPS only.
  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `Protocol "${parsed.protocol}" is not allowed. Only HTTPS endpoints are accepted.`,
    };
  }

  const hostname = parsed.hostname;

  // Rule 4: Hostname blocklist.
  for (const pattern of BLOCKED_HOSTNAME_PATTERNS) {
    if (pattern.test(hostname)) {
      return {
        valid: false,
        error: `Hostname "${hostname}" is blocked (matches ${pattern.source}).`,
      };
    }
  }

  // Rule 2: IPv4 check (hostname may be a literal IP).
  if (isBlockedIPv4(hostname)) {
    return {
      valid: false,
      error: `IP address "${hostname}" is in a blocked private/reserved range.`,
    };
  }

  // Rule 3: IPv6 check (may be wrapped in brackets like [::1]).
  const ipv6Match = hostname.match(/^\[(.+)]$/);
  const possibleIPv6 = ipv6Match ? ipv6Match[1]! : hostname;
  if (possibleIPv6.includes(":") && isBlockedIPv6(possibleIPv6)) {
    return {
      valid: false,
      error: `IPv6 address "${possibleIPv6}" is in a blocked range.`,
    };
  }

  return { valid: true };
}

/**
 * Best-effort preflight DNS check.
 *
 * Resolves the hostname and checks the returned IP against blocked ranges.
 * This is a SECONDARY layer — it cannot guarantee the same IP is used for
 * the actual connection. See the module JSDoc for details.
 *
 * In the Zotero/Firefox extension context, DNS resolution is done via
 * Components.classes["@mozilla.org/network/dns-service;1"]. In environments
 * where that is unavailable, this function is a no-op (returns valid).
 *
 * @param hostname - The hostname to resolve.
 */
export async function preflightDNSCheck(
  hostname: string,
): Promise<ValidationResult> {
  try {
    // Attempt to use Mozilla's DNS service (available in Zotero's extension context).
    const dnsService = (Components as any)?.classes?.[
      "@mozilla.org/network/dns-service;1"
    ]?.getService?.((Components as any).interfaces.nsIDNSService);

    if (!dnsService) {
      // DNS service not available — fall through (blocklists are primary control).
      return { valid: true };
    }

    // asyncResolve returns a promise-like in newer Gecko versions.
    // This is best-effort; if resolution fails, we allow the request
    // (the actual fetch will fail on its own).
    return new Promise<ValidationResult>((resolve) => {
      const listener = {
        onLookupComplete(
          _request: any,
          record: any,
          _status: any,
        ) {
          if (!record) {
            resolve({ valid: true }); // DNS failed — let fetch handle it.
            return;
          }
          // Check all resolved addresses.
          while (record.hasMore()) {
            const addr = record.getNextAddrAsString();
            if (isBlockedIPv4(addr)) {
              resolve({
                valid: false,
                error: `DNS resolved "${hostname}" to blocked IP ${addr}.`,
              });
              return;
            }
            if (addr.includes(":") && isBlockedIPv6(addr)) {
              resolve({
                valid: false,
                error: `DNS resolved "${hostname}" to blocked IPv6 ${addr}.`,
              });
              return;
            }
          }
          resolve({ valid: true });
        },
      };

      try {
        dnsService.asyncResolve(hostname, 0, listener, null, {});
      } catch {
        resolve({ valid: true }); // Fallback: allow if DNS resolution itself errors.
      }
    });
  } catch {
    // Components not available (e.g. in tests) — skip DNS check.
    return { valid: true };
  }
}
