/**
 * customer-grammar/narrative.ts — surface-facing API.
 *
 * Single entry point for the four customer surfaces (mobile, web, push,
 * email). Surfaces call `getCopy(lang)` once at render and read fields
 * off the returned table — there is no `t('...')` machinery, no
 * namespace lookup, no pluralization. The grammar is *replaceable*,
 * not *interpolated*.
 *
 * `formatLastRead` / `formatLastInterpreted` is the only template
 * primitive — a single `{{date}}` token resolved by `.replace()`.
 *
 * `getEventCopy` is the timeline-stream allowlist projection.
 * `projectNotification` is the interruption-stream allowlist projection.
 * ANY event type not in the per-stream allowlist returns `null` — the
 * respective transport then drops the row silently. This is the
 * language firewall enforcement point.
 */
import enCopy from './copy/en.json';
import deCopy from './copy/de.json';
import ruCopy from './copy/ru.json';
import type {
  CustomerCopyTable,
  CustomerLang,
  EventCopy,
  EventCopyKey,
  NotificationChannel,
  NotificationCopy,
  NotificationDeepLinkKind,
  NotificationKey,
  UICopyKey,
} from './types';

const TABLES: Record<CustomerLang, CustomerCopyTable> = {
  en: enCopy as CustomerCopyTable,
  de: deCopy as CustomerCopyTable,
  ru: ruCopy as CustomerCopyTable,
};

/** Normalise i18n-style language tags ("ru-RU", "de_DE", "en-US") to
 *  one of the three supported customer locales. Unknown → DE
 *  (platform default, matches `src/i18n/index.ts`). */
export function normaliseLang(input: string | null | undefined): CustomerLang {
  if (!input) return 'de';
  const base = String(input).toLowerCase().split(/[-_]/)[0];
  if (base === 'en' || base === 'de' || base === 'ru') return base;
  return 'de';
}

/** Returns the full curated copy table for a given language. */
export function getCopy(lang: string | null | undefined): CustomerCopyTable {
  return TABLES[normaliseLang(lang)];
}

/** Reads a single UI string. */
export function getUI(lang: string | null | undefined, key: UICopyKey): string {
  return TABLES[normaliseLang(lang)].ui[key];
}

/** Event-stream allowlist projection for the TIMELINE transport.
 *
 *  Returns `null` for any event type not in the customer-visible set.
 *  The timeline rail uses this `null` to drop the row entirely — the
 *  customer never learns the event existed.
 *
 *  Matching is exact-key first, then prefix fall-through for
 *  `media.uploaded.*` so the inspector pipeline can introduce new
 *  media sub-types without leaking until the grammar catches up. */
export function getEventCopy(
  lang: string | null | undefined,
  eventType: string,
): EventCopy | null {
  const table = TABLES[normaliseLang(lang)].events;
  if (eventType in table) {
    return table[eventType as EventCopyKey];
  }
  if (eventType.startsWith('media.uploaded.')) {
    return table['media.uploaded'];
  }
  return null;
}

/** Trivial `{{date}}` interpolation. */
export function fillDate(template: string, dateText: string): string {
  return template.replace('{{date}}', dateText);
}

// ----- Timeline projection ---------------------------------------------

export type RawTimelineEvent = {
  id?: string;
  eventType: string;
  at: string;
  payload?: Record<string, unknown>;
};

export type ProjectedRow = {
  id: string;
  at: string;
  sourceEventType: string;
  title: string;
  icon: string;
};

export type DroppedRow = {
  id: string;
  sourceEventType: string;
  reason: 'not_in_allowlist' | 'forbidden_route';
};

export type ProjectionResult = {
  rendered: ProjectedRow[];
  dropped: DroppedRow[];
};

export function projectTimeline(
  events: RawTimelineEvent[],
  lang: string | null | undefined,
): ProjectionResult {
  const result: ProjectionResult = { rendered: [], dropped: [] };
  events.forEach((ev, i) => {
    const id = ev.id || `${ev.eventType}-${ev.at}-${i}`;
    const copy = getEventCopy(lang, ev.eventType);
    if (!copy) {
      result.dropped.push({
        id,
        sourceEventType: ev.eventType,
        reason: 'not_in_allowlist',
      });
      return;
    }
    result.rendered.push({
      id,
      at: ev.at,
      sourceEventType: ev.eventType,
      title: copy.title,
      icon: copy.icon,
    });
  });
  return result;
}

// ----- Notifications projection (Sprint Customer-Notify-1) ------------
//
// `projectNotification(event, lang, channel)` is the canonical kernel
// for the interruption transports (push / email / sms). Same rules as
// timeline projection, with three additional disciplines:
//
//   1. ALLOWLIST is a strict SUBSET of the customer event allowlist —
//      individual photo captures, OCR confirmations, evidence
//      decisions are intentionally non-notifiable.
//
//   2. FORBIDDEN ROUTING — event types matching any prefix in
//      `FORBIDDEN_ROUTE_PREFIXES` are DROPPED at the routing stage,
//      not the render stage. They never reach copy lookup; they
//      never have a chance to leak.
//
//   3. CHANNEL ISOLATION — push/email/sms each have their own copy.
//      Missing copy on one channel does NOT fall back to another.
//      SMS is especially strict: missing sms copy → silent drop.
//      We do this because SMS is the most dangerous transport for
//      tone leakage (no UI chrome, carrier truncation, plain text).
//
// Mobile, web, push pipeline, email pipeline, AND the backend Python
// kernel (`backend/app/notifications/customer_kernel.py`) MUST consume
// this allowlist + copy table. They MUST NOT reimplement the
// eligibility check or the title/body resolution.

/** Route-stage deny list. Event types whose prefix matches any entry
 *  here are dropped BEFORE copy lookup. These represent operational /
 *  forensic / internal vocabularies that have no place in any customer
 *  transport, ever. The list is intentionally short and explicit. */
export const FORBIDDEN_ROUTE_PREFIXES: readonly string[] = [
  'ocr.',
  'correlation.',
  'evidence.',
  'internal.',
  'suspicion.',
] as const;

/** Where a notification deep-links the customer when tapped. Locale-
 *  AND channel-invariant policy decision. Loaded from `deep-links.json`
 *  so backend (`customer_kernel.py`) and frontend share one source. */
import deepLinksTable from './deep-links.json';
export const NOTIFICATION_DEEP_LINK = deepLinksTable.event_to_surface as Record<
  NotificationKey,
  NotificationDeepLinkKind
>;

export type ProjectedNotification = {
  id: string;
  sourceEventType: NotificationKey;
  channel: NotificationChannel;
  title: string | null;
  body: string;
  deepLinkKind: NotificationDeepLinkKind;
};

/** Returns true if `eventType` matches any forbidden routing prefix.
 *  Hot-path predicate — kept as a tiny pure function so callers can
 *  use it for telemetry decisions as well. */
export function isForbiddenRoute(eventType: string): boolean {
  for (const prefix of FORBIDDEN_ROUTE_PREFIXES) {
    if (eventType.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Project ONE event into ONE notification, for ONE channel and ONE
 * locale. Returns `null` when:
 *
 *   • the event is on the forbidden-route list (dropped at routing), or
 *   • the event is not on the notification allowlist (dropped silently), or
 *   • there is no curated copy for this (lang, channel) tuple
 *     (transport-level drop; NEVER a fallback to another channel).
 */
export function projectNotification(
  event: RawTimelineEvent,
  lang: string | null | undefined,
  channel: NotificationChannel = 'push',
  index: number = 0,
): ProjectedNotification | null {
  // 1. Forbidden routing — drop at route stage, before any copy lookup.
  if (isForbiddenRoute(event.eventType)) return null;

  // 2. Allowlist — strict subset of customer events.
  if (!(event.eventType in NOTIFICATION_DEEP_LINK)) return null;
  const key = event.eventType as NotificationKey;

  // 3. Curated copy for (lang, channel). NO fallback across channels.
  const localeTable = TABLES[normaliseLang(lang)].notifications;
  const perEvent = localeTable[key];
  if (!perEvent) return null;
  const copy: NotificationCopy | undefined = perEvent[channel];
  if (!copy) return null;

  return {
    id: event.id || `${event.eventType}-${event.at}-${index}`,
    sourceEventType: key,
    channel,
    title: copy.title,
    body: copy.body,
    deepLinkKind: NOTIFICATION_DEEP_LINK[key],
  };
}

/** Convenience: project a whole event stream into notifications for a
 *  single channel. Order preserved. Used by parity tests and any
 *  pipeline that batch-fires from a backlog. */
export function projectNotifications(
  events: RawTimelineEvent[],
  lang: string | null | undefined,
  channel: NotificationChannel = 'push',
): ProjectedNotification[] {
  const out: ProjectedNotification[] = [];
  events.forEach((ev, i) => {
    const n = projectNotification(ev, lang, channel, i);
    if (n) out.push(n);
  });
  return out;
}

export type {
  CustomerCopyTable,
  CustomerLang,
  EventCopy,
  EventCopyKey,
  UICopyKey,
  NotificationCopy,
  NotificationDeepLinkKind,
  NotificationKey,
  NotificationChannel,
};
