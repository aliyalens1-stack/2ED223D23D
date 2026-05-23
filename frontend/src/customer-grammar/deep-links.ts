/**
 * customer-grammar/deep-links.ts — Sprint Customer-Deep-Link-1.
 *
 * Semantic destination kernel. Grammar layer owns BOTH narrative
 * (what the notification says) and routing (where the customer
 * lands). Transport layer resolves a (surface, params) tuple to its
 * own concrete URL — it never makes semantic destination decisions.
 *
 * Locale-invariant by design. There is no per-language deep-link
 * map — landing surfaces are an epistemic concept, not a linguistic
 * one. Locale only affects the prose around the link.
 *
 * Roman, 2026-05-14:
 *   inspection.started     → continuity        (state of now)
 *   report.submitted       → report-cognition  (interpreted final)
 *   item.flagged_critical  → timeline          (granular event in history)
 *   item.flagged_warning   → timeline
 *
 * Forbidden routes (ocr./correlation./evidence./internal./suspicion.)
 * NEVER resolve to a destination — same routing-stage drop as
 * Notify-1's `isForbiddenRoute`.
 */
import deepLinks from './deep-links.json';
import type { NotificationKey } from './types';

export type CustomerSurface = 'continuity' | 'timeline' | 'report-cognition';

/** Concrete deep-link payload that transports consume. Locale-invariant.
 *  `routes` is pre-resolved per transport (mobile = Expo Router path,
 *  web = Vite SPA path); SMS transport ignores `routes` by design. */
export type DeepLinkPayload = {
  surface: CustomerSurface;
  params: Record<string, string>;
  routes: {
    mobile: string;
    web: string;
  };
};

const EVENT_TO_SURFACE = deepLinks.event_to_surface as Record<NotificationKey, CustomerSurface>;
const PARAMS_REQUIRED = deepLinks.params_required as Record<CustomerSurface, string[]>;
const PARAMS_OPTIONAL = deepLinks.params_optional as Record<CustomerSurface, string[]>;
const ROUTES = deepLinks.routes as Record<
  CustomerSurface,
  { mobile: string; web: string }
>;

// Re-export the forbidden-route discipline from narrative so both
// surfaces (notification copy + deep-link) share the same guard.
import { isForbiddenRoute } from './narrative';
export { isForbiddenRoute };

/** Returns the surface for a given event type, or null if the event
 *  is not on the customer notification allowlist (or is forbidden-routed). */
export function surfaceFor(eventType: string): CustomerSurface | null {
  if (isForbiddenRoute(eventType)) return null;
  if (eventType in EVENT_TO_SURFACE) {
    return EVENT_TO_SURFACE[eventType as NotificationKey];
  }
  return null;
}

/** Resolve `(eventType, metadata)` into a transport-independent
 *  deep-link payload. Returns null when:
 *    • eventType is forbidden-routed, or
 *    • eventType is not on the allowlist, or
 *    • metadata is missing a required param for the resolved surface.
 *
 *  Locale-invariant. Two transports rendering the same `(eventType,
 *  metadata)` MUST resolve to identical payloads. */
export function resolveDeepLink(
  eventType: string,
  metadata: Record<string, unknown> | null | undefined,
): DeepLinkPayload | null {
  const surface = surfaceFor(eventType);
  if (!surface) return null;

  const meta = metadata || {};
  const required = PARAMS_REQUIRED[surface] || [];
  const optional = PARAMS_OPTIONAL[surface] || [];

  // Validate required params; abort early if any is missing.
  const params: Record<string, string> = {};
  for (const key of required) {
    const v = meta[key];
    if (typeof v !== 'string' || !v) return null;
    params[key] = v;
  }
  for (const key of optional) {
    const v = meta[key];
    if (typeof v === 'string' && v) params[key] = v;
  }

  // Bind tokens in the route templates.
  const bind = (tpl: string): string => {
    let out = tpl;
    for (const [k, v] of Object.entries(params)) {
      if (required.includes(k)) {
        out = out.split(`{${k}}`).join(encodeURIComponent(v));
      }
    }
    return out;
  };

  let mobile = bind(ROUTES[surface].mobile);
  let web = bind(ROUTES[surface].web);

  // Focus token: timeline surface appends ?focus=<itemId> only when bound.
  if (surface === 'timeline' && params.itemId) {
    const focus = `focus=${encodeURIComponent(params.itemId)}`;
    mobile = mobile + (mobile.includes('?') ? '&' : '?') + focus;
    web = web + (web.includes('?') ? '&' : '?') + focus;
  }

  return { surface, params, routes: { mobile, web } };
}

/** Static structural data — used by parity tests and the admin UI legend. */
export const DEEP_LINK_TABLE = {
  surfaces: deepLinks.surfaces as CustomerSurface[],
  eventToSurface: EVENT_TO_SURFACE,
  paramsRequired: PARAMS_REQUIRED,
  paramsOptional: PARAMS_OPTIONAL,
  routes: ROUTES,
};
