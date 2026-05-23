/**
 * Vehicle — entity contract + three orthogonal projections.
 *
 * P4 — Vehicle Memory.
 *
 * Backend reference (READ-ONLY for P4 — no schema migration):
 *   - `app/vehicles/schemas.py::Vehicle, VehicleBase, ActivityEvent`
 *   - `app/vehicles/router.py::/api/customer/vehicles/*`
 *
 * P4 hard rules captured by this contract (do NOT collapse):
 *
 *   vehicle.status       ≠ customer.intent           ≠ delivery/ownership
 *   ───────────────────    ─────────────────────────   ────────────────────
 *   VehicleOperational     CustomerVehiclePerception   VehicleMemoryStage
 *   Status                 (buyer's mental model)      (timeline phase)
 *   (backend record)
 *
 * Why three orthogonal types instead of one enum:
 *
 *   - `accepted quote` ≠ `vehicle owned`
 *   - `payment paid`  ≠ `service fulfilled`
 *   - `purchased`     ≠ `delivered`
 *   - `inspection approved` ≠ `safe to buy` (depends on verdict)
 *   - `delivery pending` ≠ `ownership completed`
 *
 * Folding any two of these into one string-literal union destroys
 * reconciliation between vehicle ownership, payment settlement, and
 * the customer's mental model. Surfaces import the projection they
 * actually render and never read raw status strings directly.
 *
 * Also: shared NEVER fetches data. All cross-domain references arrive
 * pre-fetched as typed projection inputs (see VehicleMemoryProjectionInput).
 */
import type { ReportVerdict } from './inspection-report';
import type { QuoteStatus, RawBackendQuoteStatus } from './quote';
import type { PaymentStatus } from './payment';
import type { BookingStatus } from './booking';

// ─────────────────────────────────────────────────────────────────────
// (1) OPERATIONAL STATUS — backend truth, normalised.
//
// Mirrors backend `vehicles.status` (open string). Backend does NOT
// validate transitions today; shared collapses backend strings into a
// closed enum so the UI can branch safely.
//
//   saved                  — vehicle just added to garage (default).
//   inspection_requested   — customer asked for an on-site inspection.
//   inspection_completed   — inspector submitted a report (regardless
//                            of verdict — verdict is a separate axis).
//   purchased              — customer marked the vehicle as bought.
//   archived               — customer dismissed/dropped the candidate.
//   reopened               — archived candidate re-activated.
//   unknown                — backend sent a string we don't recognise.
//                            Never crashes the UI; surfaces fall back
//                            to "saved"-like rendering.
// ─────────────────────────────────────────────────────────────────────

export type VehicleOperationalStatus =
  | 'saved'
  | 'inspection_requested'
  | 'inspection_completed'
  | 'purchased'
  | 'archived'
  | 'reopened'
  | 'unknown';

export const VEHICLE_OPERATIONAL_STATUSES: readonly VehicleOperationalStatus[] = [
  'saved',
  'inspection_requested',
  'inspection_completed',
  'purchased',
  'archived',
  'reopened',
  'unknown',
] as const;

// ─────────────────────────────────────────────────────────────────────
// (2) CUSTOMER PERCEPTION — buyer's mental model.
//
// What the customer believes is happening with THIS vehicle, given:
//   operational status + linked inspection report verdict + linked
//   accepted quote + linked payment + delivery booking.
//
// Hard asymmetries vs. operational:
//
//   - `inspection_completed` does NOT collapse to one perception.
//     A `recommended` verdict → `evaluating` (still a candidate).
//     A `risky` / `not_recommended` verdict → `evaluating_with_concerns`.
//   - `purchased` does NOT collapse to `owned`. A buyer who paid but
//     hasn't received delivery yet is `awaiting_delivery`, not `owned`.
//   - `archived` does NOT collapse to `not_interested` if the buyer
//     actually completed purchase first; that vehicle is `parted_with`,
//     a fundamentally different state.
//
//   considering              — vehicle saved, no inspection yet.
//   inspection_pending       — inspection scheduled / in progress.
//   evaluating               — inspection done, verdict positive.
//   evaluating_with_concerns — inspection done, verdict cautionary.
//   negotiating              — at least one quote received / accepted.
//   awaiting_delivery        — purchased + payment paid, delivery pending.
//   owned                    — purchased + delivered (or no delivery req).
//   parted_with              — sold/transferred away (terminal).
//   not_interested           — archived without purchase (terminal-ish;
//                              `reopened` lifts back to `considering`).
// ─────────────────────────────────────────────────────────────────────

export type CustomerVehiclePerception =
  | 'considering'
  | 'inspection_pending'
  | 'evaluating'
  | 'evaluating_with_concerns'
  | 'negotiating'
  | 'awaiting_delivery'
  | 'owned'
  | 'parted_with'
  | 'not_interested';

// ─────────────────────────────────────────────────────────────────────
// (3) MEMORY STAGE — timeline phase (high-level narrative bucket).
//
// Coarser than perception. Used to label the timeline header
// ("You're in the Validation phase"). NEVER drives gates / permissions.
//
//   discovery     — pre-inspection: just looking at this car.
//   validation    — inspection requested or in progress.
//   decision      — inspection done; weighing verdict + price.
//   acquisition   — quote accepted / payment in flight.
//   ownership     — vehicle is theirs (delivered or no delivery req).
//   parted_ways   — sold or archived (terminal).
// ─────────────────────────────────────────────────────────────────────

export type VehicleMemoryStage =
  | 'discovery'
  | 'validation'
  | 'decision'
  | 'acquisition'
  | 'ownership'
  | 'parted_ways';

// ─────────────────────────────────────────────────────────────────────
// Wire shape — minimal Vehicle document mirror.
//
// NOTE: this is the *contract* the surface passes into shared. It
// matches the backend `Vehicle` Pydantic model. Surfaces fetch the
// document, then hand it to projection functions. shared never calls
// the API.
// ─────────────────────────────────────────────────────────────────────

/** Activity event embedded on the vehicle doc (mirrors backend). */
export interface VehicleActivityEvent {
  /** Backend uses `Literal[...]` of known types but treats it as open. */
  type: string;
  /** ISO-8601 timestamp. */
  at: string;
  text?: string | null;
}

/** Backend-current status strings as they appear on the wire. */
export type RawBackendVehicleStatus =
  | 'saved'
  | 'inspection_requested'
  | 'inspection_completed'
  | 'purchased'
  | 'archived'
  | 'reopened'
  | (string & {}); // permissive — unknown values fall back to `'unknown'`.

export interface VehicleDoc {
  id: string;
  customerId: string;
  brand: string;
  model: string;
  year?: number | null;
  mileage?: number | null;
  price?: number | null;
  currency?: string | null;
  location?: string | null;
  fuel?: string | null;
  transmission?: string | null;
  thumbnail?: string | null;
  listingUrl?: string | null;
  source?: string | null;
  externalSourceId?: string | null;
  notes?: string | null;
  status: RawBackendVehicleStatus | null;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  updatedAt?: string | null;
  /** Embedded activity, newest at the END of the array (backend appends). */
  activity?: VehicleActivityEvent[];
}

// ─────────────────────────────────────────────────────────────────────
// Cross-domain references — TYPED PROJECTION INPUTS.
//
// HARD RULE: shared/domain/state-machines/vehicle.ts MUST NOT import
// other domains' state machines. Surfaces translate domain-specific
// statuses (QuoteStatus, PaymentStatus, BookingStatus, ReportVerdict)
// at the call site and pass them in via these typed structs.
//
// Every ref is identified by its own id + the linkage (vehicleId may
// be implicit via the request the surface fetched). shared treats
// these as opaque value objects; it does NOT dereference them further.
// ─────────────────────────────────────────────────────────────────────

export interface LinkedInspectionReportRef {
  id: string;
  /** ISO-8601 — when the report was submitted. */
  submittedAt: string;
  verdict: ReportVerdict;
  /** Optional 1.0..10.0 score for timeline display. */
  score?: number | null;
  /** Optional one-line summary for timeline body. */
  summary?: string | null;
}

export interface LinkedQuoteRef {
  id: string;
  /** Provider-facing slug for surface routing only. */
  providerSlug?: string | null;
  /** Operational status (already normalised by surface). */
  status: QuoteStatus;
  /** Raw backend status — kept for fallback / debugging. */
  rawStatus?: RawBackendQuoteStatus | null;
  /** Price snapshot. */
  priceFrom?: number | null;
  currency?: string | null;
  /** ISO-8601 — when the customer accepted (if any). */
  acceptedAt?: string | null;
  /** ISO-8601 — when the quote landed in the inbox. */
  createdAt?: string | null;
}

export interface LinkedPaymentRef {
  id: string;
  /** Operational status (already normalised by surface). */
  status: PaymentStatus;
  amount?: number | null;
  currency?: string | null;
  /** ISO-8601 — when funds were captured. */
  paidAt?: string | null;
  /** ISO-8601 — payment doc creation. */
  createdAt?: string | null;
}

export interface LinkedBookingRef {
  id: string;
  /** Operational status (raw backend literal — already in the shared
   *  `BookingStatus` union, no normalisation needed). */
  status: BookingStatus;
  /** ISO-8601 — when the booking is/was scheduled to start. */
  scheduledAt?: string | null;
  /** ISO-8601 — booking creation. */
  createdAt: string;
}

/**
 * Everything the surface has gathered for ONE vehicle. shared projects
 * memory + timeline from this struct alone — no further I/O.
 *
 * Empty arrays are valid: they mean "no linked records found", not
 * "data not loaded yet". Surfaces that haven't fetched a domain pass
 * `[]` (or omit the key entirely — handled as `[]` by projection).
 */
export interface VehicleMemoryProjectionInput {
  vehicle: VehicleDoc;
  reports?: LinkedInspectionReportRef[];
  quotes?: LinkedQuoteRef[];
  payments?: LinkedPaymentRef[];
  bookings?: LinkedBookingRef[];
}

// ─────────────────────────────────────────────────────────────────────
// Projection outputs.
// ─────────────────────────────────────────────────────────────────────

/**
 * Vehicle Memory — the consolidated mental-model snapshot for ONE
 * vehicle. This is what the Customer Vehicle Detail page header
 * renders verbatim.
 */
export interface VehicleMemory {
  vehicleId: string;
  /** Identity slice the header card needs. */
  identity: {
    brand: string;
    model: string;
    year?: number | null;
    mileage?: number | null;
    listingUrl?: string | null;
    thumbnail?: string | null;
    plate?: string | null;
    vin?: string | null;
  };
  /** All three projections, materialised in one struct so consumers
   *  pick the one they need without recomputing. */
  operationalStatus: VehicleOperationalStatus;
  customerPerception: CustomerVehiclePerception;
  memoryStage: VehicleMemoryStage;
  /** Counts of linked artefacts — useful for tabs / badges. */
  counts: {
    reports: number;
    quotes: number;
    payments: number;
    bookings: number;
  };
  /** Convenience flags — derived. */
  flags: {
    hasInspection: boolean;
    hasAcceptedQuote: boolean;
    hasPaidPayment: boolean;
    hasCompletedBooking: boolean;
    isTerminal: boolean;
  };
}

/**
 * Single timeline item rendered on the Vehicle Detail page.
 *
 *   kind          — what produced this entry (used for icon + colour).
 *   at            — ISO-8601 — drives sort order (descending = newest first).
 *   title         — short headline (e.g. "Inspection completed").
 *   body          — optional one-line description.
 *   severity      — optional emphasis cue. Affects icon colour only.
 *   refId         — id of the linked artefact (vehicle/report/quote/payment/booking).
 *   meta          — opaque structure surfaces may render in a tooltip.
 */
export type TimelineItemKind =
  | 'vehicle_event'      // from vehicle.activity[]
  | 'inspection_report'  // from reports[]
  | 'quote'              // from quotes[]
  | 'payment'            // from payments[]
  | 'booking';           // from bookings[]

export type TimelineItemSeverity = 'info' | 'success' | 'warning' | 'danger';

export interface VehicleTimelineItem {
  /** Stable id for React keys. Derived from `kind` + `refId` + `at`. */
  id: string;
  kind: TimelineItemKind;
  /** ISO-8601 — sort key, descending. */
  at: string;
  title: string;
  body?: string | null;
  severity?: TimelineItemSeverity;
  refId?: string | null;
  meta?: Readonly<Record<string, unknown>>;
}
