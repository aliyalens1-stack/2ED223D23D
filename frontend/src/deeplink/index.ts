/**
 * P0.b.C.e — Deep-links into chronology surfaces.
 *
 * CONTRACT (frozen):
 *  - Resolver returns ONLY {surface, route, params, requiredRole}.
 *  - This module does NOT check auth, JWT, or role.
 *  - It calls expo-router push and lets the target screen guard handle access.
 *  - URL scheme: `asearch://` (no universal links yet).
 *
 * URL FORM:
 *   asearch://link?ref=<url-encoded-ref>
 *   asearch:/link?ref=...           (legacy / single-slash tolerated)
 *
 * Out of scope:
 *   - signing / TTL of refs
 *   - mutating deep-links
 *   - QR / share-sheet generation
 */
import type { Router } from 'expo-router';

const API_BASE =
  process.env.EXPO_PUBLIC_BACKEND_URL ||
  process.env.EXPO_PACKAGER_PROXY_URL ||
  '';

export type ResolveResult = {
  surface: string;
  route: string;
  params: Record<string, string>;
  requiredRole: 'customer' | 'provider' | 'inspector' | 'admin';
};

export type NavigateOutcome =
  | { ok: true; surface: string; route: string; params: Record<string, string> }
  | { ok: false; code: 'INVALID_URL' | 'RESOLVE_FAILED' };

/**
 * Parse a deep-link URL → extract the `ref` query param.
 * Returns null for non-asearch URLs or malformed input.
 */
export function parseDeeplinkUrl(url: string): { ref: string } | null {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('asearch:')) return null;
  // Find the query string. Tolerant of asearch://link?... and asearch:/link?...
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return null;
  const query = url.slice(qIdx + 1);
  const parts = query.split('&');
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 'ref' && v) {
      try {
        return { ref: decodeURIComponent(v) };
      } catch {
        return { ref: v };
      }
    }
  }
  return null;
}

/**
 * Resolve a ref via backend. Network call; throws on non-2xx.
 */
export async function resolveDeeplink(ref: string): Promise<ResolveResult> {
  const url = `${API_BASE}/api/deeplink/resolve?ref=${encodeURIComponent(ref)}`;
  const r = await fetch(url, { method: 'GET' });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Deeplink resolve failed: ${r.status} ${body}`);
  }
  return (await r.json()) as ResolveResult;
}

/**
 * Build an expo-router path from a route template + params.
 *   "/customer/booking/[id]/timeline" + { id: "abc" } → "/customer/booking/abc/timeline"
 */
function buildHref(route: string, params: Record<string, string>): string {
  let out = route;
  for (const [key, val] of Object.entries(params)) {
    out = out.replace(`[${key}]`, encodeURIComponent(val));
  }
  return out;
}

/**
 * Parse → resolve → push. Single entry-point for the Linking listener.
 * Side-effect only on success; returns outcome for caller to log.
 */
export async function navigateDeeplink(
  url: string,
  router: Router,
): Promise<NavigateOutcome> {
  const parsed = parseDeeplinkUrl(url);
  if (!parsed) {
    return { ok: false, code: 'INVALID_URL' };
  }
  try {
    const resolved = await resolveDeeplink(parsed.ref);
    const href = buildHref(resolved.route, resolved.params);
    // Authorisation is intentionally NOT checked here. The target screen
    // / its REST/WS endpoints enforce role gates (P0.b.C.a..d invariants).
    router.push(href as never);
    return {
      ok: true,
      surface: resolved.surface,
      route: resolved.route,
      params: resolved.params,
    };
  } catch {
    return { ok: false, code: 'RESOLVE_FAILED' };
  }
}
