/**
 * auto-request — module-level constants.
 *
 * - URGENCY / FUEL / TRANSMISSION option lists (i18n key driven).
 * - PRICING_EUR_FALLBACK — used only while `/api/pricing` is in-flight.
 * - R1_DRAFT_KEY — AsyncStorage key for the form draft (Sprint R1.2
 *   auth-gate: anonymous users park the payload here, then login bounces
 *   back into create.tsx which restores + auto-submits).
 *
 * BUGFIX (refactor 2026-02): `R1_DRAFT_KEY` was referenced in the old
 * monolithic create.tsx but never declared. Anonymous submit would
 * throw `ReferenceError: R1_DRAFT_KEY is not defined`. Declaring it
 * here makes the auth-gate path actually work.
 */
import type { FlowType } from './types';

export const URGENCY_OPTIONS = [
  { value: 'asap', labelKey: 'create.urgency_asap' },
  { value: '24h', labelKey: 'create.urgency_24h' },
  { value: 'week', labelKey: 'create.urgency_week' },
] as const;

export const FUEL_OPTIONS = [
  { value: 'petrol', labelKey: 'create.fuel_petrol' },
  { value: 'diesel', labelKey: 'create.fuel_diesel' },
  { value: 'hybrid', labelKey: 'create.fuel_hybrid' },
  { value: 'electric', labelKey: 'create.fuel_electric' },
] as const;

export const TRANSMISSION_OPTIONS = [
  { value: 'manual', labelKey: 'create.tx_manual' },
  { value: 'auto', labelKey: 'create.tx_auto' },
] as const;

export const PRICING_EUR_FALLBACK: Record<FlowType, number> = {
  inspection: 149,
  selection: 499,
};

export const R1_DRAFT_KEY = 'auto_request_draft_v1';

/**
 * Flag emoji lookup used by the city picker group headers.
 * The canonical /api/geo/countries response includes a `flag` field, but
 * cities returned by /api/cities only know the ISO-2 code — we resolve
 * the flag locally for group headers to avoid a join.
 */
export const FLAG_BY_COUNTRY: Record<string, string> = {
  DE: '🇩🇪',
  AT: '🇦🇹',
  LV: '🇱🇻',
  LT: '🇱🇹',
  EE: '🇪🇪',
  BY: '🇧🇾',
  UA: '🇺🇦',
  PL: '🇵🇱',
};

/**
 * Display label for a parsed listing source — backend returns the
 * canonical host token (e.g. "mobile.de") and we render a polished name.
 */
export const PARSER_SOURCE_LABEL: Record<string, string> = {
  'mobile.de': 'mobile.de',
  'autoscout24.de': 'AutoScout24',
  'autoscout24': 'AutoScout24',
  'kleinanzeigen.de': 'Kleinanzeigen',
  'willhaben.at': 'Willhaben',
  'otomoto.pl': 'Otomoto',
  'heycar': 'heycar',
  'pkw.de': 'PKW.de',
  'generic': 'dealer site',
};
