/**
 * Booking — state machine.
 *
 * Behavioral truth for booking lifecycle. Plain TypeScript, plain
 * functions, explicit transitions. No xstate, no createMachine, no
 * generic "transition graph" abstraction.
 *
 * If the rules drift from backend, fix them here first, then propagate
 * to surfaces. Backend wins on conflict; this file is the *next* truth
 * tier down.
 *
 * Used by:
 *   - web-app/src/pages/public/BookingDetailPage.tsx
 *   - (Expo + Admin to be migrated in 0B/0C)
 */
import type { Booking, BookingStatus } from '../contracts/booking';

// ─────────────────────────────────────────────────────────────────────
// Predicates — "what is true about this booking?"
// ─────────────────────────────────────────────────────────────────────

/** Booking is in a terminal state — no further transitions possible. */
export function isTerminal(status: BookingStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** Provider is on the way / on site / actively working. */
export function isInFlight(status: BookingStatus): boolean {
  return (
    status === 'on_route' ||
    status === 'arrived' ||
    status === 'in_progress'
  );
}

/** Booking has been accepted but not yet started. */
export function isAccepted(status: BookingStatus): boolean {
  return status === 'confirmed';
}

// ─────────────────────────────────────────────────────────────────────
// Capabilities — "what can the user do right now?"
//
// These are presentation-aware: they answer "should this button be
// visible?". They do NOT answer "is the user authorized?" — that
// belongs in `domain/permissions/` (added later).
// ─────────────────────────────────────────────────────────────────────

/** Customer can cancel before work starts. */
export function canCancel(status: BookingStatus): boolean {
  return status === 'pending' || status === 'confirmed';
}

/** Customer can pay if the booking is alive and not already paid. */
export function canPay(status: BookingStatus, isPaid: boolean): boolean {
  return !isPaid && !isTerminal(status);
}

/** Customer can leave a review only after work is fully done. */
export function canReview(status: BookingStatus): boolean {
  return status === 'completed';
}

/** Customer can chat with the provider while the booking is alive. */
export function canChat(status: BookingStatus): boolean {
  return !isTerminal(status);
}

// ─────────────────────────────────────────────────────────────────────
// Transitions — "is this status change valid?"
//
// Used for optimistic UI updates and for guarding against stale events
// (e.g. a `booking.completed` socket event arriving after the booking
// was cancelled). The authority remains the backend.
// ─────────────────────────────────────────────────────────────────────

/**
 * Allowed status transitions.
 * Reads as: from `pending` you can go to `confirmed` or `cancelled`.
 *
 * Cancellation is reachable from any non-terminal state — the customer
 * or provider can abort at any point before completion.
 */
const ALLOWED: Record<BookingStatus, readonly BookingStatus[]> = {
  pending:     ['confirmed', 'cancelled'],
  confirmed:   ['on_route', 'cancelled'],
  on_route:    ['arrived', 'cancelled'],
  arrived:     ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed:   [],
  cancelled:   [],
};

/** True if `from → to` is a legal transition. Identity (`from === to`) is allowed. */
export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  if (from === to) return true;
  return ALLOWED[from].includes(to);
}

// ─────────────────────────────────────────────────────────────────────
// Realtime event mapping.
//
// Backend emits two flavours of events for booking changes:
//   - `booking.<verb>` (per-action: confirmed/started/completed/cancelled)
//   - `booking:status_changed` (generic, carries the new status)
//
// Surfaces use this map to either patch their local view-model or
// trigger a refetch. We do NOT reduce events into state here — that
// is for `domain/events/` (added in 0B). For now, surfaces own the
// reducer; this map only translates verb → status.
// ─────────────────────────────────────────────────────────────────────

export type BookingEventName =
  | 'booking:status_changed'
  | 'booking.confirmed'
  | 'booking.started'
  | 'booking.completed'
  | 'booking.cancelled'
  | 'booking:provider_location';

const VERB_TO_STATUS: Record<string, BookingStatus | null> = {
  'booking.confirmed': 'confirmed',
  'booking.started':   'in_progress',
  'booking.completed': 'completed',
  'booking.cancelled': 'cancelled',
  // 'booking:status_changed' carries an explicit status in payload — null here
  'booking:status_changed':    null,
  'booking:provider_location': null,
};

/**
 * Returns the booking status implied by an event verb, or `null` if the
 * status must be read from the event payload.
 */
export function statusFromEvent(eventName: BookingEventName): BookingStatus | null {
  return VERB_TO_STATUS[eventName] ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Display — i18n-keyed labels.
//
// Returns a *translation key*, never a translated string. Each surface
// resolves keys via its own i18n stack. This keeps `shared/` free of
// react-i18next / formatjs dependencies.
// ─────────────────────────────────────────────────────────────────────

export function statusI18nKey(status: BookingStatus): string {
  return `booking.status.${status}`;
}

/**
 * Recommended fallback label in English. Used only when the surface's
 * i18n bundle is missing a key — should never appear in production.
 */
export function statusFallbackLabel(status: BookingStatus): string {
  switch (status) {
    case 'pending':     return 'Pending';
    case 'confirmed':   return 'Confirmed';
    case 'on_route':    return 'On the way';
    case 'arrived':     return 'Arrived';
    case 'in_progress': return 'In progress';
    case 'completed':   return 'Completed';
    case 'cancelled':   return 'Cancelled';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Convenience view-model builder.
//
// Wraps the predicates above in a single call so a UI component only
// needs one import. The shape is intentionally flat — no nested
// "actions" object, no method bag. Add fields here, never methods.
// ─────────────────────────────────────────────────────────────────────

export interface BookingViewModel {
  status: BookingStatus;
  isTerminal: boolean;
  isInFlight: boolean;
  canCancel: boolean;
  canPay: boolean;
  canReview: boolean;
  canChat: boolean;
  statusI18nKey: string;
  statusFallback: string;
}

export function bookingViewModel(b: Pick<Booking, 'status' | 'isPaid'>): BookingViewModel {
  const status = b.status;
  return {
    status,
    isTerminal: isTerminal(status),
    isInFlight: isInFlight(status),
    canCancel:  canCancel(status),
    canPay:     canPay(status, Boolean(b.isPaid)),
    canReview:  canReview(status),
    canChat:    canChat(status),
    statusI18nKey:  statusI18nKey(status),
    statusFallback: statusFallbackLabel(status),
  };
}
