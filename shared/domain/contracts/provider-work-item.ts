/**
 * ProviderWorkItem — provider-facing operational projection.
 *
 * THIS IS NOT A STATE MACHINE.
 * THIS IS NOT OPERATIONAL TRUTH.
 *
 * Provider Workbench v1 doctrine (see /app/memory/PRD.md):
 *   "Provider Workbench is not a workflow engine.
 *    It is a provider-facing operational projection over existing truths."
 *
 * Sources of truth (not touched by this contract):
 *   - booking truth     → db.bookings              (status, lifecycle)
 *   - inspection truth  → db.inspection_jobs       (status, lifecycle)
 *   - report truth      → db.inspection_reports    (submitted/approved/rejected)
 *   - earnings reality  → future db.provider_earnings (Phase 3, orthogonal)
 *
 * This file declares ONE shape — the projection a provider sees.
 * The projector lives in `backend/app/provider/work_items.py` and is the
 * ONLY place allowed to map underlying truths into ProviderWorkItemState.
 *
 * Boundary rules:
 *   1. ProviderWorkItem has no own write authority. Actions land on the
 *      underlying booking/inspection_job; the projector recomputes state.
 *   2. Provider UI MUST NOT branch on raw booking.status / job.status /
 *      report.status. If the surface needs a new distinction, the
 *      projector grows a new ProviderWorkItemState — never the UI.
 *   3. Earnings lifecycle (pending/payable/paid_out/disputed_hold) is a
 *      separate projection. `awaiting_payout` here is a stub anchor only;
 *      the financial detail belongs to ProviderEarningsItem (Phase 3).
 */

/**
 * The ten states a provider perceives. Names are verbs/postures of the
 * provider, not transitions of internal lifecycles.
 *
 * ORDER below is the logical flow; the projector is free to land an
 * item in any state without honoring this order (e.g., a job can jump
 * from `scheduled` straight to `blocked` without going through `en_route`).
 */
export type ProviderWorkItemState =
  // Active work
  | 'needs_response'      // Offer pending my accept/reject (TTL applies).
  | 'scheduled'           // I accepted; future slot, nothing to do yet.
  | 'en_route'            // I'm moving toward the customer.
  | 'on_site'             // I arrived; physical work hasn't started.
  | 'in_progress'         // Working right now.
  | 'report_required'     // Physical work done; report submission owed (inspection-only).

  // Provider waits — actor is explicit so the UI surfaces the right CTA
  | 'awaiting_customer'   // Customer must confirm / show / accept.
  | 'awaiting_review'     // Admin / report moderation owns the next move.
  | 'awaiting_payout'     // Operationally finished; money pipeline pending. STUB in v1.

  // Terminal-ish
  | 'completed'           // Operational closure. NOT a financial closure.
  | 'blocked';            // Cannot progress; see blockedReason for the unblock path.

/**
 * Verb the provider can invoke right now. The projector picks at most
 * one. UI never composes verbs from raw status; it just renders this.
 *
 * - accept / reject → only when state='needs_response'
 * - depart          → scheduled → en_route
 * - arrive          → en_route → on_site
 * - start           → on_site → in_progress
 * - complete        → in_progress → completed (booking) | report_required (inspection)
 * - submit_report   → report_required → awaiting_review
 */
export type ProviderWorkItemActionVerb =
  | 'accept'
  | 'reject'
  | 'depart'
  | 'arrive'
  | 'start'
  | 'complete'
  | 'submit_report';

export interface ProviderWorkItemAction {
  /** Verb the provider invokes; backend translates into the right underlying transition. */
  verb: ProviderWorkItemActionVerb;
  /** Already-localized label. UI does not re-localize on top. */
  label: string;
  /** True when the action has irreversible side-effects (e.g., `complete`, `submit_report`). */
  confirmationRequired: boolean;
}

/**
 * Why the provider cannot move forward. Only set when state='blocked'.
 *
 * `code` is a small closed set so UI can ship a contact CTA without
 * parsing message strings. Adding a new code is a deliberate doctrine
 * decision — do NOT widen this union to mirror admin taxonomy.
 */
export type ProviderWorkItemBlockedCode =
  | 'customer_no_show'
  | 'awaiting_admin_review'
  | 'payment_disputed'
  | 'documents_missing';

export interface ProviderWorkItemBlockedReason {
  code: ProviderWorkItemBlockedCode;
  /** Already-localized one-liner. UI shows verbatim. */
  message: string;
  /** Who the provider should reach to unblock. UI renders the right CTA. */
  contactWho: 'customer' | 'support' | 'admin';
}

/**
 * Money the provider expects to be paid for THIS item. This is NOT the
 * earnings-lifecycle amount (settled, paid_out, disputed_hold). It's the
 * agreed price the provider sees on the offer / job.
 *
 * Anything past "what does this job pay?" belongs to the earnings
 * projection (Phase 3) and must not leak into ProviderWorkItem.
 */
export interface ProviderWorkItemPrice {
  amount: number;
  currency: string;       // ISO 4217, e.g. 'EUR' / 'UAH'
  /** Multiplier > 1 means surge applied. Absent = base price. */
  surge?: number;
}

export interface ProviderWorkItemCustomer {
  /** Display name, already truncated to UI-safe length on the backend. */
  name: string;
  /** Pre-formatted address string. Provider does not parse coordinates here. */
  address?: string;
  /** Distance from provider's last known location, in km. */
  distanceKm?: number;
}

/**
 * One unit of provider-perceived work.
 *
 * `id` is opaque — the projector encodes the underlying source
 * (`bk_<bookingId>` for bookings, `ij_<jobId>` for inspection jobs).
 * UI does not parse it; it routes actions back through the same id.
 */
export interface ProviderWorkItem {
  id: string;
  /**
   * One tiny hint for icon/action shape. UI may use it to pick an icon
   * or to show "Inspection · BMW X5" vs "Service · …" — but it MUST NOT
   * branch business logic on this field.
   */
  kind: 'booking' | 'inspection';

  state: ProviderWorkItemState;

  /** Present iff there is exactly one verb the provider can do now. */
  primaryAction?: ProviderWorkItemAction;

  /** Present iff state='blocked'. */
  blockedReason?: ProviderWorkItemBlockedReason;

  /** When the work is due (provider's local-friendly ISO). Optional. */
  scheduledFor?: string;

  /** When this item entered its current state (ISO). Drives "5 min ago". */
  enteredCurrentStateAt: string;

  /**
   * Soft SLA — the moment after which the item is considered overdue.
   * UI may render an "overdue" pill, but the projector decides — UI
   * does not compute SLA from `enteredCurrentStateAt` itself.
   */
  expectedActionBy?: string;

  priceShown: ProviderWorkItemPrice;

  customer: ProviderWorkItemCustomer;

  /** Provider-friendly label, e.g. "Pre-purchase inspection · BMW X5". */
  serviceLabel: string;
}

/**
 * Wire envelope for `GET /api/provider/work-items`.
 *
 * `etag` is advisory — UI may cache between renders; absence is fine.
 * Pagination is intentionally not in v1: a single provider's active
 * surface is bounded (≤ ~50 items). When/if it grows, add `cursor`
 * here, not a generic pagination layer.
 */
export interface ProviderWorkItemsResponse {
  items: ProviderWorkItem[];
  etag?: string;
}

/**
 * Wire envelope for `POST /api/provider/work-items/{id}/action`.
 * Returns the updated projection so the UI replaces by `id` without
 * a refetch round-trip.
 */
export interface ProviderWorkItemActionResponse {
  item: ProviderWorkItem;
}
