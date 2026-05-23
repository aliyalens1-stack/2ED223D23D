/**
 * Vehicle — state machine, projections, merge, invariants.
 *
 * P4 — Vehicle Memory.
 *
 * Three orthogonal truths for the SAME vehicle:
 *
 *   1. Operational status   (`VehicleOperationalStatus`)   — backend record.
 *   2. Customer perception  (`CustomerVehiclePerception`)  — buyer's mental model.
 *   3. Memory stage         (`VehicleMemoryStage`)         — timeline phase.
 *
 * Surfaces import the projection they need. They MUST NOT branch on
 * raw backend `status` strings, and they MUST NOT collapse the three
 * truths into one enum.
 *
 * Hard constraints (reaffirmed by the contract file):
 *
 *   - vehicle.status ≠ customer intent ≠ delivery/ownership perception
 *   - quote accepted ≠ vehicle owned
 *   - inspection approved ≠ safe to buy (depends on verdict)
 *   - paid ≠ service fulfilled
 *   - purchased ≠ delivered
 *   - sold is terminal for ownership perception
 *
 * Pure functions only. NO React, NO router, NO API calls, NO storage.
 * Cross-domain inputs arrive pre-fetched + pre-typed via
 * `VehicleMemoryProjectionInput`.
 */
import type {
  VehicleOperationalStatus,
  CustomerVehiclePerception,
  VehicleMemoryStage,
  RawBackendVehicleStatus,
  VehicleDoc,
  VehicleActivityEvent,
  LinkedInspectionReportRef,
  LinkedQuoteRef,
  LinkedPaymentRef,
  LinkedBookingRef,
  VehicleMemoryProjectionInput,
  VehicleMemory,
  VehicleTimelineItem,
  TimelineItemSeverity,
} from '../contracts/vehicle';

// ─────────────────────────────────────────────────────────────────────
// (A) Backend → operational normalisation.
//
// Backend stores `status` as an open string and DOES NOT enforce
// transitions. We collapse known values into the closed enum and fall
// back to `'unknown'` for everything else. `'unknown'` renders as
// "saved"-equivalent in the UI but is distinguishable in dev logs.
// ─────────────────────────────────────────────────────────────────────

const RAW_VEHICLE_STATUS_MAP: Readonly<Record<string, VehicleOperationalStatus>> = {
  saved: 'saved',
  inspection_requested: 'inspection_requested',
  inspection_completed: 'inspection_completed',
  purchased: 'purchased',
  archived: 'archived',
  reopened: 'reopened',
} as const;

export function normalizeVehicleStatus(
  raw: RawBackendVehicleStatus | null | undefined,
): VehicleOperationalStatus {
  if (!raw) return 'saved'; // backend default for new docs
  const mapped = RAW_VEHICLE_STATUS_MAP[String(raw).toLowerCase().trim()];
  return mapped ?? 'unknown';
}

// ─────────────────────────────────────────────────────────────────────
// (B) Lifecycle ordering — used by mergeVehicleMemory.
//
// Operational ladder is forward-only EXCEPT `archived`/`reopened`,
// which form an off-ladder loop. `purchased` is the highest forward
// state; once reached, only `archived` (sold/parted) may follow.
// ─────────────────────────────────────────────────────────────────────

const OPERATIONAL_ORDER: Readonly<Record<VehicleOperationalStatus, number>> = {
  unknown: -1,
  saved: 0,
  reopened: 0,                // semantically equivalent to "saved again"
  inspection_requested: 1,
  inspection_completed: 2,
  purchased: 3,
  archived: 4,                // terminal-ish (reopen lifts back to 0)
} as const;

// ─────────────────────────────────────────────────────────────────────
// (C) Linked-domain helpers — pure value-object inspection.
//
// shared MUST NOT import other domains' state machines. We only look
// at the tagged status that the surface already normalised.
// ─────────────────────────────────────────────────────────────────────

function hasAcceptedQuote(quotes: readonly LinkedQuoteRef[]): boolean {
  return quotes.some((q) => q.status === 'accepted');
}

function hasPaidPayment(payments: readonly LinkedPaymentRef[]): boolean {
  // `refunded` does NOT count — money went back. Provider/customer
  // may still see "completed" UI-side, but for vehicle ownership
  // semantics the fulfilment is REVERSED.
  return payments.some((p) => p.status === 'paid');
}

function hasCompletedDeliveryBooking(bookings: readonly LinkedBookingRef[]): boolean {
  // We treat `completed` as "service fulfilled". A booking that's
  // `arrived` or `in_progress` is not yet ownership.
  return bookings.some((b) => b.status === 'completed');
}

function latestInspectionReport(
  reports: readonly LinkedInspectionReportRef[],
): LinkedInspectionReportRef | null {
  if (reports.length === 0) return null;
  // Surface may pass them unsorted. Pick the one with the latest
  // submittedAt; ties broken arbitrarily (id ordering).
  let best: LinkedInspectionReportRef | undefined = reports[0];
  for (let i = 1; i < reports.length; i++) {
    const r = reports[i];
    if (r && best && r.submittedAt > best.submittedAt) best = r;
  }
  return best ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// (D) Customer perception projection.
//
// THIS IS WHERE THE GUARDRAILS LIVE. Each branch encodes a non-
// collapsible distinction:
//
//   - inspection_completed splits on verdict (recommended vs. risky)
//   - purchased + paid + delivered → owned
//   - purchased + paid + NOT delivered → awaiting_delivery
//   - purchased + NOT paid → still negotiating (race window)
//   - archived after purchased → parted_with (NOT not_interested)
//   - archived without purchase → not_interested
// ─────────────────────────────────────────────────────────────────────

export function customerVehiclePerceptionFor(
  input: VehicleMemoryProjectionInput,
): CustomerVehiclePerception {
  const op = normalizeVehicleStatus(input.vehicle.status);
  const reports = input.reports ?? [];
  const quotes = input.quotes ?? [];
  const payments = input.payments ?? [];
  const bookings = input.bookings ?? [];

  const paid = hasPaidPayment(payments);
  const accepted = hasAcceptedQuote(quotes);
  const delivered = hasCompletedDeliveryBooking(bookings);
  const noBookingRequired = bookings.length === 0;

  // Terminal branches first — they never get re-evaluated against
  // intermediate states.
  if (op === 'purchased') {
    // Purchased ≠ delivered ≠ paid. Three orthogonal facts:
    //   - The customer marked the vehicle as bought (`op = purchased`).
    //   - Money may or may not have settled (`paid`).
    //   - Delivery booking may or may not exist / be completed.
    if (paid && (delivered || noBookingRequired)) return 'owned';
    return 'awaiting_delivery';
  }

  if (op === 'archived') {
    // Distinction: was it sold (after purchase) or just dropped?
    if (paid || delivered) return 'parted_with';
    return 'not_interested';
  }

  // Mid-ladder branches — order matters.

  if (op === 'inspection_requested') return 'inspection_pending';

  if (op === 'inspection_completed' || reports.length > 0) {
    const latest = latestInspectionReport(reports);
    // Verdict drives the split. A `recommended` verdict → 'evaluating'.
    // A 'risky' or 'not_recommended' verdict → 'evaluating_with_concerns'.
    // No report (e.g. backend says completed but report not yet linked)
    // → safe minimum 'evaluating' (no concerns asserted).
    if (latest && (latest.verdict === 'risky' || latest.verdict === 'not_recommended')) {
      return 'evaluating_with_concerns';
    }
    // If a quote was already accepted on top of the inspection, the
    // buyer mentally moved into negotiation/acquisition.
    if (accepted) return 'negotiating';
    return 'evaluating';
  }

  // No inspection yet — but a quote may already be on the table.
  if (accepted) return 'negotiating';

  // Default — saved / reopened / unknown.
  return 'considering';
}

// ─────────────────────────────────────────────────────────────────────
// (E) Memory stage projection — coarse timeline phase.
//
// Derived from operational + perception (NOT a third independent fold)
// so the three projections stay consistent: a vehicle in `'owned'`
// perception can never be in `'discovery'` stage.
// ─────────────────────────────────────────────────────────────────────

export function vehicleMemoryStageFor(
  input: VehicleMemoryProjectionInput,
): VehicleMemoryStage {
  const perception = customerVehiclePerceptionFor(input);
  switch (perception) {
    case 'considering':
      return 'discovery';
    case 'inspection_pending':
      return 'validation';
    case 'evaluating':
    case 'evaluating_with_concerns':
      return 'decision';
    case 'negotiating':
    case 'awaiting_delivery':
      return 'acquisition';
    case 'owned':
      return 'ownership';
    case 'parted_with':
    case 'not_interested':
      return 'parted_ways';
    default:
      // Exhaustiveness — never expected. Falls back to discovery.
      return 'discovery';
  }
}

// ─────────────────────────────────────────────────────────────────────
// (F) Memory snapshot.
// ─────────────────────────────────────────────────────────────────────

export function projectVehicleMemory(
  input: VehicleMemoryProjectionInput,
): VehicleMemory {
  const v = input.vehicle;
  const reports = input.reports ?? [];
  const quotes = input.quotes ?? [];
  const payments = input.payments ?? [];
  const bookings = input.bookings ?? [];

  const operationalStatus = normalizeVehicleStatus(v.status);
  const customerPerception = customerVehiclePerceptionFor(input);
  const memoryStage = vehicleMemoryStageFor(input);

  return {
    vehicleId: v.id,
    identity: {
      brand: v.brand,
      model: v.model,
      year: v.year ?? null,
      mileage: v.mileage ?? null,
      listingUrl: v.listingUrl ?? null,
      thumbnail: v.thumbnail ?? null,
      // plate / vin live on richer doc shapes — passed through if present.
      plate: (v as unknown as { plate?: string }).plate ?? null,
      vin: (v as unknown as { vin?: string }).vin ?? null,
    },
    operationalStatus,
    customerPerception,
    memoryStage,
    counts: {
      reports: reports.length,
      quotes: quotes.length,
      payments: payments.length,
      bookings: bookings.length,
    },
    flags: {
      hasInspection: reports.length > 0 || operationalStatus === 'inspection_completed',
      hasAcceptedQuote: hasAcceptedQuote(quotes),
      hasPaidPayment: hasPaidPayment(payments),
      hasCompletedBooking: hasCompletedDeliveryBooking(bookings),
      isTerminal:
        memoryStage === 'parted_ways' ||
        (memoryStage === 'ownership' && operationalStatus === 'purchased'),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// (G) Timeline projection.
//
// Folds the embedded `vehicle.activity[]` plus all linked artefacts
// into one chronologically-sorted list. Each kind has its own title /
// severity rules; surfaces just render.
// ─────────────────────────────────────────────────────────────────────

const ACTIVITY_TITLE: Readonly<Record<string, { title: string; severity: TimelineItemSeverity }>> = {
  saved:                 { title: 'Vehicle added',                severity: 'info' },
  note_added:            { title: 'Note updated',                 severity: 'info' },
  status_changed:        { title: 'Status changed',               severity: 'info' },
  inspection_requested:  { title: 'Inspection requested',         severity: 'info' },
  inspection_completed:  { title: 'Inspection completed',         severity: 'success' },
  purchased:             { title: 'Marked as purchased',          severity: 'success' },
  archived:              { title: 'Archived',                     severity: 'warning' },
  reopened:              { title: 'Reopened',                     severity: 'info' },
} as const;

function activityToTimeline(
  vehicleId: string,
  ev: VehicleActivityEvent,
  idx: number,
): VehicleTimelineItem {
  const meta = ACTIVITY_TITLE[ev.type] ?? { title: ev.type, severity: 'info' as TimelineItemSeverity };
  return {
    id: `vehicle:${vehicleId}:activity:${idx}:${ev.at}`,
    kind: 'vehicle_event',
    at: ev.at,
    title: meta.title,
    body: ev.text ?? null,
    severity: meta.severity,
    refId: vehicleId,
  };
}

function reportToTimeline(r: LinkedInspectionReportRef): VehicleTimelineItem {
  let severity: TimelineItemSeverity = 'success';
  if (r.verdict === 'risky') severity = 'warning';
  if (r.verdict === 'not_recommended') severity = 'danger';
  const verdictLabel =
    r.verdict === 'recommended'
      ? 'Recommended'
      : r.verdict === 'risky'
      ? 'Risky'
      : 'Not recommended';
  const title = `Inspection: ${verdictLabel}`;
  const body =
    r.summary
      ? r.score != null
        ? `Score ${r.score.toFixed(1)} — ${r.summary}`
        : r.summary
      : r.score != null
      ? `Score ${r.score.toFixed(1)}/10`
      : null;
  return {
    id: `report:${r.id}`,
    kind: 'inspection_report',
    at: r.submittedAt,
    title,
    body,
    severity,
    refId: r.id,
    meta: { verdict: r.verdict, score: r.score ?? null },
  };
}

function quoteToTimeline(q: LinkedQuoteRef): VehicleTimelineItem | null {
  // Each quote produces ONE timeline entry — preferring the most-
  // settled timestamp we have.
  let title: string;
  let severity: TimelineItemSeverity = 'info';
  let at: string | null = null;
  switch (q.status) {
    case 'accepted':
      title = 'Quote accepted';
      severity = 'success';
      at = q.acceptedAt ?? q.createdAt ?? null;
      break;
    case 'declined':
    case 'expired':
    case 'withdrawn':
      title = `Quote ${q.status}`;
      severity = q.status === 'expired' ? 'warning' : 'info';
      at = q.createdAt ?? null;
      break;
    case 'sent':
    case 'viewed':
      title = 'Quote received';
      severity = 'info';
      at = q.createdAt ?? null;
      break;
    case 'draft':
      // Drafts don't appear on the customer timeline — buyer never sees them.
      return null;
    default:
      title = 'Quote';
      at = q.createdAt ?? null;
  }
  if (!at) return null;
  const priceBody =
    q.priceFrom != null && q.currency
      ? `from ${q.priceFrom} ${q.currency.toUpperCase()}`
      : null;
  return {
    id: `quote:${q.id}`,
    kind: 'quote',
    at,
    title,
    body: priceBody,
    severity,
    refId: q.id,
    meta: { providerSlug: q.providerSlug ?? null, status: q.status },
  };
}

function paymentToTimeline(p: LinkedPaymentRef): VehicleTimelineItem | null {
  let title: string;
  let severity: TimelineItemSeverity = 'info';
  let at: string | null = null;
  switch (p.status) {
    case 'paid':
      title = 'Payment captured';
      severity = 'success';
      at = p.paidAt ?? p.createdAt ?? null;
      break;
    case 'refunded':
      title = 'Payment refunded';
      severity = 'warning';
      at = p.paidAt ?? p.createdAt ?? null;
      break;
    case 'failed':
      title = 'Payment failed';
      severity = 'danger';
      at = p.createdAt ?? null;
      break;
    case 'cancelled':
      title = 'Payment cancelled';
      severity = 'warning';
      at = p.createdAt ?? null;
      break;
    case 'processing':
    case 'checkout_pending':
      title = 'Payment in progress';
      severity = 'info';
      at = p.createdAt ?? null;
      break;
    default:
      // 'created' → no timeline entry; nothing meaningful happened yet.
      return null;
  }
  if (!at) return null;
  const body =
    p.amount != null && p.currency
      ? `${p.amount} ${p.currency.toUpperCase()}`
      : null;
  return {
    id: `payment:${p.id}`,
    kind: 'payment',
    at,
    title,
    body,
    severity,
    refId: p.id,
    meta: { status: p.status },
  };
}

function bookingToTimeline(b: LinkedBookingRef): VehicleTimelineItem {
  let title = 'Booking created';
  let severity: TimelineItemSeverity = 'info';
  switch (b.status) {
    case 'confirmed':
      title = 'Booking confirmed';
      severity = 'info';
      break;
    case 'on_route':
      title = 'Provider on route';
      severity = 'info';
      break;
    case 'arrived':
      title = 'Provider arrived';
      severity = 'info';
      break;
    case 'in_progress':
      title = 'Service in progress';
      severity = 'info';
      break;
    case 'completed':
      title = 'Service completed';
      severity = 'success';
      break;
    case 'cancelled':
      title = 'Booking cancelled';
      severity = 'warning';
      break;
    case 'pending':
    default:
      title = 'Booking created';
      severity = 'info';
  }
  return {
    id: `booking:${b.id}`,
    kind: 'booking',
    at: b.scheduledAt ?? b.createdAt,
    title,
    body: null,
    severity,
    refId: b.id,
    meta: { status: b.status },
  };
}

export function projectVehicleTimeline(
  input: VehicleMemoryProjectionInput,
): VehicleTimelineItem[] {
  const items: VehicleTimelineItem[] = [];
  const v = input.vehicle;

  // 1. Vehicle activity events (embedded, oldest → newest in source).
  const activity = v.activity ?? [];
  for (let i = 0; i < activity.length; i++) {
    const ev = activity[i];
    if (!ev) continue;
    items.push(activityToTimeline(v.id, ev, i));
  }

  // 2. Inspection reports.
  for (const r of input.reports ?? []) items.push(reportToTimeline(r));

  // 3. Quotes (some statuses produce no entry).
  for (const q of input.quotes ?? []) {
    const it = quoteToTimeline(q);
    if (it) items.push(it);
  }

  // 4. Payments.
  for (const p of input.payments ?? []) {
    const it = paymentToTimeline(p);
    if (it) items.push(it);
  }

  // 5. Bookings.
  for (const b of input.bookings ?? []) items.push(bookingToTimeline(b));

  // Sort descending by `at`. Ties broken by stable id for determinism.
  items.sort((a, b) => {
    if (a.at < b.at) return 1;
    if (a.at > b.at) return -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────
// (H) Idempotent merge — useful for cache reconciliation when the
// surface re-fetches and wants to keep the more-settled snapshot.
//
// Rules (mirroring inspection-report / payment patterns):
//   - operationalStatus uses OPERATIONAL_ORDER (forward-only,
//     `archived` overrides forward states only when both sides agree;
//     `reopened` replaces `archived` if it's the more recent one).
//   - perception is recomputed downstream — we don't merge perception
//     directly. mergeVehicleMemory only re-runs the projection on the
//     winning operational status.
//   - counts are taken from the side with the larger sum (assuming
//     refresh delivered a fuller picture).
// ─────────────────────────────────────────────────────────────────────

export function mergeVehicleMemory(
  prev: VehicleMemory | null | undefined,
  next: VehicleMemory | null | undefined,
): VehicleMemory | null {
  if (!prev && !next) return null;
  if (!prev) return next ?? null;
  if (!next) return prev;
  if (prev.vehicleId !== next.vehicleId) {
    // Caller bug — refuse to silently merge two different vehicles.
    return next;
  }

  const prevOrder = OPERATIONAL_ORDER[prev.operationalStatus];
  const nextOrder = OPERATIONAL_ORDER[next.operationalStatus];

  // `archived` is sticky vs anything except `reopened`.
  let operationalStatus: VehicleOperationalStatus;
  if (prev.operationalStatus === 'archived' && next.operationalStatus !== 'reopened') {
    operationalStatus = 'archived';
  } else if (next.operationalStatus === 'reopened') {
    operationalStatus = 'reopened';
  } else if (next.operationalStatus === 'unknown') {
    // Stale 'unknown' must NOT erase a known prev.
    operationalStatus = prev.operationalStatus;
  } else {
    operationalStatus = nextOrder >= prevOrder ? next.operationalStatus : prev.operationalStatus;
  }

  // Count merge: take per-domain max (refresh delivers fuller picture).
  const counts = {
    reports: Math.max(prev.counts.reports, next.counts.reports),
    quotes: Math.max(prev.counts.quotes, next.counts.quotes),
    payments: Math.max(prev.counts.payments, next.counts.payments),
    bookings: Math.max(prev.counts.bookings, next.counts.bookings),
  };

  // Flags: union (any side seeing it = it happened).
  const flags = {
    hasInspection: prev.flags.hasInspection || next.flags.hasInspection,
    hasAcceptedQuote: prev.flags.hasAcceptedQuote || next.flags.hasAcceptedQuote,
    hasPaidPayment: prev.flags.hasPaidPayment || next.flags.hasPaidPayment,
    hasCompletedBooking: prev.flags.hasCompletedBooking || next.flags.hasCompletedBooking,
    // isTerminal recomputed below from the winning operationalStatus +
    // perception (which we re-derive from flags + status).
    isTerminal: false,
  };

  // Recompute perception + stage from the winning operational + flags.
  // This is an approximation — the precise projection requires the
  // full input doc. mergeVehicleMemory is a CACHE helper, not a
  // replacement for projectVehicleMemory on fresh data.
  let perception: CustomerVehiclePerception;
  if (operationalStatus === 'purchased') {
    perception = flags.hasPaidPayment && flags.hasCompletedBooking ? 'owned' : 'awaiting_delivery';
  } else if (operationalStatus === 'archived') {
    perception = flags.hasPaidPayment ? 'parted_with' : 'not_interested';
  } else if (operationalStatus === 'inspection_requested') {
    perception = 'inspection_pending';
  } else if (operationalStatus === 'inspection_completed') {
    perception = flags.hasAcceptedQuote ? 'negotiating' : 'evaluating';
  } else if (flags.hasAcceptedQuote) {
    perception = 'negotiating';
  } else {
    perception = 'considering';
  }

  let memoryStage: VehicleMemoryStage;
  switch (perception) {
    case 'considering':
      memoryStage = 'discovery'; break;
    case 'inspection_pending':
      memoryStage = 'validation'; break;
    case 'evaluating':
      // Note: mergeVehicleMemory's heuristic re-derivation cannot
      // produce 'evaluating_with_concerns' (verdict is not preserved
      // across merge), so that case is intentionally absent here.
      memoryStage = 'decision'; break;
    case 'negotiating':
    case 'awaiting_delivery':
      memoryStage = 'acquisition'; break;
    case 'owned':
      memoryStage = 'ownership'; break;
    case 'parted_with':
    case 'not_interested':
      memoryStage = 'parted_ways'; break;
    default:
      memoryStage = 'discovery';
  }

  flags.isTerminal =
    memoryStage === 'parted_ways' ||
    (memoryStage === 'ownership' && operationalStatus === 'purchased');

  // Identity: prefer `next` (more recent fetch); but never lose data.
  const identity = {
    brand: next.identity.brand || prev.identity.brand,
    model: next.identity.model || prev.identity.model,
    year: next.identity.year ?? prev.identity.year ?? null,
    mileage: next.identity.mileage ?? prev.identity.mileage ?? null,
    listingUrl: next.identity.listingUrl ?? prev.identity.listingUrl ?? null,
    thumbnail: next.identity.thumbnail ?? prev.identity.thumbnail ?? null,
    plate: next.identity.plate ?? prev.identity.plate ?? null,
    vin: next.identity.vin ?? prev.identity.vin ?? null,
  };

  return {
    vehicleId: prev.vehicleId,
    identity,
    operationalStatus,
    customerPerception: perception,
    memoryStage,
    counts,
    flags,
  };
}

// ─────────────────────────────────────────────────────────────────────
// (I) Self-test invariants — runtime-callable, framework-free.
// ─────────────────────────────────────────────────────────────────────

const FIXED_NOW = '2026-05-08T12:00:00Z';

function vehicleFixture(
  status: RawBackendVehicleStatus | null,
  activity: VehicleActivityEvent[] = [],
  extra: Partial<VehicleDoc> = {},
): VehicleDoc {
  return {
    id: 'vehicle_test_1',
    customerId: 'cust_1',
    brand: 'Toyota',
    model: 'Camry',
    status,
    createdAt: FIXED_NOW,
    activity,
    ...extra,
  };
}

export function assertVehicleMemoryInvariants(): void {
  const eq = <T>(a: T, b: T, label: string) => {
    if (a !== b) {
      throw new Error(
        `vehicle invariant failed: ${label} (got=${String(a)} want=${String(b)})`,
      );
    }
  };

  // ── (A) backend status normalisation ───────────────────────────────
  eq(normalizeVehicleStatus('saved'), 'saved', 'raw saved → saved');
  eq(normalizeVehicleStatus('inspection_requested'), 'inspection_requested', 'raw inspection_requested → inspection_requested');
  eq(normalizeVehicleStatus('inspection_completed'), 'inspection_completed', 'raw inspection_completed → inspection_completed');
  eq(normalizeVehicleStatus('purchased'), 'purchased', 'raw purchased → purchased');
  eq(normalizeVehicleStatus('archived'), 'archived', 'raw archived → archived');
  eq(normalizeVehicleStatus('reopened'), 'reopened', 'raw reopened → reopened');
  eq(normalizeVehicleStatus(null), 'saved', 'null → saved (backend default)');
  eq(normalizeVehicleStatus(undefined), 'saved', 'undefined → saved (backend default)');
  eq(normalizeVehicleStatus(''), 'saved', 'empty string → saved (backend default)');
  eq(normalizeVehicleStatus('totally_unknown'), 'unknown', 'unknown → unknown (safe minimum)');

  // ── (B) perception — three orthogonal projections must NOT collapse ──

  // GUARDRAIL 1: vehicle.status ≠ customer.intent
  // `saved` operational status corresponds to `considering` perception.
  eq(
    customerVehiclePerceptionFor({ vehicle: vehicleFixture('saved') }),
    'considering',
    'saved → considering',
  );

  // GUARDRAIL 2: inspected ≠ safe-to-buy
  // Inspection completed with risky verdict MUST surface as
  // 'evaluating_with_concerns', NOT 'evaluating'.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('inspection_completed'),
      reports: [
        { id: 'r1', submittedAt: FIXED_NOW, verdict: 'risky', score: 4.2 },
      ],
    }),
    'evaluating_with_concerns',
    'risky verdict → evaluating_with_concerns (NOT evaluating)',
  );
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('inspection_completed'),
      reports: [
        { id: 'r1', submittedAt: FIXED_NOW, verdict: 'not_recommended', score: 2.0 },
      ],
    }),
    'evaluating_with_concerns',
    'not_recommended verdict → evaluating_with_concerns',
  );
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('inspection_completed'),
      reports: [
        { id: 'r1', submittedAt: FIXED_NOW, verdict: 'recommended', score: 8.5 },
      ],
    }),
    'evaluating',
    'recommended verdict → evaluating',
  );

  // GUARDRAIL 3: quote accepted ≠ vehicle owned
  // An accepted quote without purchase + payment is `negotiating`,
  // NEVER `owned`.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('saved'),
      quotes: [
        { id: 'q1', status: 'accepted', priceFrom: 100, currency: 'EUR', acceptedAt: FIXED_NOW },
      ],
    }),
    'negotiating',
    'accepted quote alone → negotiating (NOT owned)',
  );

  // GUARDRAIL 4: paid ≠ service fulfilled
  // Payment paid without operational `purchased` does NOT make the
  // vehicle `owned`. The customer paid for the inspection — that
  // doesn't transfer ownership.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('inspection_completed'),
      reports: [{ id: 'r1', submittedAt: FIXED_NOW, verdict: 'recommended' }],
      payments: [{ id: 'p1', status: 'paid', amount: 149, currency: 'EUR', paidAt: FIXED_NOW }],
    }),
    'evaluating',
    'paid inspection ≠ owned (still evaluating)',
  );

  // GUARDRAIL 5: purchased ≠ delivered
  // Purchased + paid + NO completed booking → awaiting_delivery, not owned.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('purchased'),
      payments: [{ id: 'p1', status: 'paid', amount: 12000, currency: 'EUR', paidAt: FIXED_NOW }],
      bookings: [{ id: 'b1', status: 'confirmed', createdAt: FIXED_NOW }],
    }),
    'awaiting_delivery',
    'purchased + paid + booking not completed → awaiting_delivery (NOT owned)',
  );

  // GUARDRAIL 6: purchased + paid + delivered (completed booking) → owned
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('purchased'),
      payments: [{ id: 'p1', status: 'paid', amount: 12000, currency: 'EUR', paidAt: FIXED_NOW }],
      bookings: [{ id: 'b1', status: 'completed', createdAt: FIXED_NOW }],
    }),
    'owned',
    'purchased + paid + completed booking → owned',
  );

  // GUARDRAIL 7: purchased + paid + no booking required → owned
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('purchased'),
      payments: [{ id: 'p1', status: 'paid', amount: 12000, currency: 'EUR', paidAt: FIXED_NOW }],
    }),
    'owned',
    'purchased + paid + no bookings → owned (no delivery required)',
  );

  // GUARDRAIL 8: purchased without paid → still awaiting_delivery
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('purchased'),
    }),
    'awaiting_delivery',
    'purchased without paid → awaiting_delivery (race window)',
  );

  // GUARDRAIL 9: archived after purchase ≠ archived without purchase.
  // Sold (parted_with) is terminal for ownership perception.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('archived'),
      payments: [{ id: 'p1', status: 'paid', amount: 12000, currency: 'EUR', paidAt: FIXED_NOW }],
    }),
    'parted_with',
    'archived after paid → parted_with (sold)',
  );
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('archived'),
    }),
    'not_interested',
    'archived without paid → not_interested',
  );

  // GUARDRAIL 10: refunded payment must NOT count toward ownership.
  eq(
    customerVehiclePerceptionFor({
      vehicle: vehicleFixture('purchased'),
      payments: [{ id: 'p1', status: 'refunded', amount: 12000, currency: 'EUR', paidAt: FIXED_NOW }],
    }),
    'awaiting_delivery',
    'purchased + refunded payment → awaiting_delivery (refund REVOKES paid)',
  );

  // GUARDRAIL 11: inspection_requested → inspection_pending (validation stage)
  eq(
    customerVehiclePerceptionFor({ vehicle: vehicleFixture('inspection_requested') }),
    'inspection_pending',
    'inspection_requested → inspection_pending',
  );

  // ── (C) memory stage — derived consistently from perception ────────
  eq(vehicleMemoryStageFor({ vehicle: vehicleFixture('saved') }), 'discovery', 'saved → discovery');
  eq(
    vehicleMemoryStageFor({ vehicle: vehicleFixture('inspection_requested') }),
    'validation',
    'inspection_requested → validation',
  );
  eq(
    vehicleMemoryStageFor({
      vehicle: vehicleFixture('inspection_completed'),
      reports: [{ id: 'r1', submittedAt: FIXED_NOW, verdict: 'recommended' }],
    }),
    'decision',
    'inspection_completed (recommended) → decision',
  );
  eq(
    vehicleMemoryStageFor({
      vehicle: vehicleFixture('purchased'),
      payments: [{ id: 'p1', status: 'paid', currency: 'EUR', amount: 1, paidAt: FIXED_NOW }],
      bookings: [{ id: 'b1', status: 'completed', createdAt: FIXED_NOW }],
    }),
    'ownership',
    'purchased + paid + completed → ownership',
  );
  eq(
    vehicleMemoryStageFor({ vehicle: vehicleFixture('archived') }),
    'parted_ways',
    'archived → parted_ways',
  );

  // ── (D) timeline projection ────────────────────────────────────────

  // Event order: newest first (descending by `at`).
  const tl = projectVehicleTimeline({
    vehicle: vehicleFixture('inspection_completed', [
      { type: 'saved', at: '2026-05-01T10:00:00Z', text: 'Added' },
      { type: 'inspection_requested', at: '2026-05-03T10:00:00Z' },
    ]),
    reports: [
      { id: 'r1', submittedAt: '2026-05-05T10:00:00Z', verdict: 'recommended', score: 8.5, summary: 'Clean car' },
    ],
    quotes: [
      { id: 'q1', status: 'accepted', acceptedAt: '2026-05-06T10:00:00Z', priceFrom: 200, currency: 'EUR' },
    ],
    payments: [
      { id: 'p1', status: 'paid', paidAt: '2026-05-07T10:00:00Z', amount: 200, currency: 'EUR' },
    ],
    bookings: [
      { id: 'b1', status: 'completed', scheduledAt: '2026-05-08T09:00:00Z', createdAt: '2026-05-06T11:00:00Z' },
    ],
  });
  // 2 activity + 1 report + 1 quote + 1 payment + 1 booking = 6
  eq(tl.length, 6, 'timeline includes all 6 entries');
  eq(tl[0]?.kind, 'booking', 'newest entry is the booking (2026-05-08)');
  eq(tl[tl.length - 1]?.kind, 'vehicle_event', 'oldest entry is the saved activity');
  eq(tl[tl.length - 1]?.title, 'Vehicle added', 'oldest entry title');

  // Risky verdict surfaces as `warning` severity in the timeline.
  const tlRisky = projectVehicleTimeline({
    vehicle: vehicleFixture('inspection_completed'),
    reports: [
      { id: 'r1', submittedAt: '2026-05-05T10:00:00Z', verdict: 'risky', score: 4.2 },
    ],
  });
  eq(tlRisky.length, 1, 'risky-only timeline has 1 entry');
  eq(tlRisky[0]?.severity, 'warning', 'risky verdict → warning severity');

  // not_recommended → danger
  const tlBad = projectVehicleTimeline({
    vehicle: vehicleFixture('inspection_completed'),
    reports: [
      { id: 'r1', submittedAt: '2026-05-05T10:00:00Z', verdict: 'not_recommended', score: 2.0 },
    ],
  });
  eq(tlBad[0]?.severity, 'danger', 'not_recommended verdict → danger severity');

  // Quote in 'draft' MUST NOT appear in the customer timeline.
  const tlDraft = projectVehicleTimeline({
    vehicle: vehicleFixture('saved'),
    quotes: [
      { id: 'q_draft', status: 'draft', createdAt: '2026-05-01T10:00:00Z' },
    ],
  });
  eq(tlDraft.length, 0, 'draft quote does not appear on customer timeline');

  // ── (E) memory snapshot ────────────────────────────────────────────
  const mem = projectVehicleMemory({
    vehicle: vehicleFixture('purchased', [
      { type: 'saved', at: '2026-05-01T10:00:00Z' },
    ]),
    reports: [{ id: 'r1', submittedAt: FIXED_NOW, verdict: 'recommended' }],
    quotes: [{ id: 'q1', status: 'accepted', acceptedAt: FIXED_NOW }],
    payments: [{ id: 'p1', status: 'paid', paidAt: FIXED_NOW, amount: 1, currency: 'EUR' }],
    bookings: [{ id: 'b1', status: 'completed', createdAt: FIXED_NOW }],
  });
  eq(mem.operationalStatus, 'purchased', 'snapshot operational = purchased');
  eq(mem.customerPerception, 'owned', 'snapshot perception = owned');
  eq(mem.memoryStage, 'ownership', 'snapshot memory stage = ownership');
  eq(mem.flags.hasInspection, true, 'snapshot has inspection flag');
  eq(mem.flags.hasAcceptedQuote, true, 'snapshot has accepted quote flag');
  eq(mem.flags.hasPaidPayment, true, 'snapshot has paid payment flag');
  eq(mem.flags.hasCompletedBooking, true, 'snapshot has completed booking flag');
  eq(mem.flags.isTerminal, true, 'owned + purchased → terminal');
  eq(mem.counts.reports, 1, 'count reports');
  eq(mem.counts.quotes, 1, 'count quotes');
  eq(mem.counts.payments, 1, 'count payments');
  eq(mem.counts.bookings, 1, 'count bookings');

  // ── (F) merge — refuses silent downgrades ──────────────────────────
  const a: VehicleMemory = {
    vehicleId: 'v1',
    identity: { brand: 'X', model: 'Y' },
    operationalStatus: 'purchased',
    customerPerception: 'owned',
    memoryStage: 'ownership',
    counts: { reports: 1, quotes: 1, payments: 1, bookings: 1 },
    flags: {
      hasInspection: true, hasAcceptedQuote: true, hasPaidPayment: true,
      hasCompletedBooking: true, isTerminal: true,
    },
  };
  const b: VehicleMemory = {
    ...a,
    operationalStatus: 'saved',
    customerPerception: 'considering',
    memoryStage: 'discovery',
    counts: { reports: 0, quotes: 0, payments: 0, bookings: 0 },
    flags: {
      hasInspection: false, hasAcceptedQuote: false, hasPaidPayment: false,
      hasCompletedBooking: false, isTerminal: false,
    },
  };
  const merged = mergeVehicleMemory(a, b)!;
  eq(merged.operationalStatus, 'purchased', 'merge keeps higher operational status (no downgrade)');
  eq(merged.flags.hasPaidPayment, true, 'merge OR-unions flags');
  eq(merged.counts.reports, 1, 'merge takes max counts');

  // archived is sticky.
  const archived: VehicleMemory = { ...a, operationalStatus: 'archived', memoryStage: 'parted_ways' };
  const stale: VehicleMemory = { ...a, operationalStatus: 'inspection_requested', memoryStage: 'validation' };
  eq(
    mergeVehicleMemory(archived, stale)!.operationalStatus,
    'archived',
    'merge: archived sticks vs stale forward state',
  );
  eq(
    mergeVehicleMemory(archived, { ...a, operationalStatus: 'reopened' })!.operationalStatus,
    'reopened',
    'merge: reopened lifts archived',
  );

  // unknown must never erase a known state.
  eq(
    mergeVehicleMemory(a, { ...a, operationalStatus: 'unknown' })!.operationalStatus,
    'purchased',
    'merge: unknown does not erase known state',
  );

  // Cross-vehicle merge returns the next snapshot (caller bug guard).
  const wrong: VehicleMemory = { ...a, vehicleId: 'v2' };
  eq(
    mergeVehicleMemory(a, wrong)!.vehicleId,
    'v2',
    'merge: cross-vehicle returns next (caller bug guard)',
  );
}
