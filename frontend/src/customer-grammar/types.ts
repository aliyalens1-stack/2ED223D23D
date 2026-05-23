/**
 * customer-grammar/types.ts — narrative grammar types.
 *
 * Single source of truth for which customer-visible phrases exist.
 * Surfaces import `UICopyKey` / `EventCopyKey` / `NotificationKey` and
 * read from a typed table. Adding a key here without adding it to all
 * locales is a TS error (Record<Key, ...> exhaustiveness).
 *
 * Boundary: NO React, NO RN, NO platform imports. This module must be
 * importable from a pure node script for the lexicon test AND from a
 * Python adapter for the backend customer-kernel (`customer_kernel.py`).
 */

export type CustomerLang = 'en' | 'de' | 'ru';

/** Event-stream projection keys. Adding a new operational event does
 *  NOT make it customer-visible — the eventType must also appear here
 *  AND in every locale's `events` table. */
export type EventCopyKey =
  | 'inspection.started'
  | 'report.submitted'
  | 'media.uploaded.vin'
  | 'media.uploaded.odometer'
  | 'media.uploaded.damage'
  | 'media.uploaded.registration'
  | 'media.uploaded.engine'
  | 'media.uploaded.interior'
  | 'media.uploaded.general'
  | 'media.uploaded'
  | 'item.flagged_critical'
  | 'item.flagged_warning';

export type EventCopy = { title: string; icon: string };

/** UI chrome strings on the three customer surfaces. */
export type UICopyKey =
  // common
  | 'common.back'
  | 'common.refresh'
  | 'common.reading'
  | 'common.dash'
  | 'common.lastRead'
  // timeline
  | 'timeline.kicker'
  | 'timeline.title'
  | 'timeline.empty'
  | 'timeline.crossToContinuity'
  | 'timeline.crossToReport'
  | 'timeline.error.notAvailable'
  | 'timeline.error.auth'
  | 'timeline.error.load'
  // continuity
  | 'continuity.kicker'
  | 'continuity.title'
  | 'continuity.error.notAvailable'
  | 'continuity.error.auth'
  | 'continuity.error.load'
  | 'continuity.insufficient'
  | 'continuity.section.state'
  | 'continuity.section.interpretation'
  | 'continuity.section.events'
  | 'continuity.events.empty'
  | 'continuity.maturity.forming'
  | 'continuity.maturity.accumulating'
  | 'continuity.maturity.established'
  | 'continuity.maturity.delivered'
  | 'continuity.navToHistory'
  // cognition
  | 'cognition.title'
  | 'cognition.loading'
  | 'cognition.error.notAvailable'
  | 'cognition.error.auth'
  | 'cognition.error.load'
  | 'cognition.refresh'
  | 'cognition.lastInterpreted'
  | 'cognition.navToHistory';

// ----- Notifications subsystem (Sprint Customer-Notify-1) -------------
//
// Notifications are the THIRD transport for the same narrative grammar.
// An interruption is a SINGLE discrete projection of a SINGLE event,
// per channel. The allowlist of notifiable events is a strict SUBSET
// of the customer event allowlist. The subset is enforced by
// `NotificationKey` and validated per-locale × per-channel by the
// parity test.
//
// Channel hierarchy (Roman, 2026-05-14):
//   push  — ultra-short, single-sentence interruption (lock-screen tone)
//   email — calm explanatory, multi-sentence (inbox tone)
//   sms   — fallback minimal, one short line, NO title (carrier tone)
//
// Channels are NEVER reused. SMS does not fall back to push/email; a
// missing SMS copy entry means the notification is DROPPED on the SMS
// transport — silently, with no leakage to another channel's prose.

export type NotificationKey =
  | 'inspection.started'
  | 'report.submitted'
  | 'item.flagged_critical'
  | 'item.flagged_warning';

export type NotificationChannel = 'push' | 'email' | 'sms';

/** Per-locale × per-channel notification copy.
 *  `title` is `null` ONLY for sms (carriers have no title concept).
 *  For push/email, `title` is a required non-empty string. */
export type NotificationCopy = { title: string | null; body: string };

/** Where a notification deep-links the customer when tapped. Locale-
 *  AND channel-invariant policy decision — owned by the deep-link
 *  kernel in `deep-links.json`. Sprint Customer-Deep-Link-1 (2026-05-14)
 *  rotated this map to its current epistemic shape:
 *    inspection.started     → continuity        (state of now)
 *    report.submitted       → report-cognition  (interpreted final)
 *    item.flagged_critical  → timeline          (granular event)
 *    item.flagged_warning   → timeline          (granular event)
 */
export type NotificationDeepLinkKind = 'continuity' | 'timeline' | 'report-cognition';

export type NotificationCopyTable = Record<
  NotificationKey,
  Record<NotificationChannel, NotificationCopy>
>;

export type CustomerCopyTable = {
  ui: Record<UICopyKey, string>;
  events: Record<EventCopyKey, EventCopy>;
  notifications: NotificationCopyTable;
};
