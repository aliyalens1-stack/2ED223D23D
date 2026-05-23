/**
 * Quote — state machine, projections, permissions, monotonic merge, invariants.
 *
 * Three orthogonal truths for ONE quote domain:
 *
 *   1. Operational         (`QuoteStatus`)            — backend reality.
 *   2. Customer perception (`QuoteCustomerPerception`) — buyer's view.
 *   3. Marketplace         (`QuoteCompetitiveness`)   — ranking layer view.
 *
 * HARD ARCHITECTURAL GUARDRAIL — ENFORCED IN COMMENTS AND TESTS:
 *
 *   `selected` is NOT a `QuoteStatus`. It is a customer perception
 *   ONLY. The operational truth for "this is the quote that won" is
 *   `accepted`. Mixing them — i.e. `quote.status = 'selected'` — has
 *   broken every marketplace this team has shipped before; do not
 *   reintroduce the collapse.
 *
 *   The type system makes the wrong code unspellable: `QuoteStatus`
 *   and `QuoteCustomerPerception` are disjoint string-literal unions
 *   with no overlapping members.
 *
 * Backend reference: `app/marketplace/requests.py`
 *   - `request_quotes` collection: status ∈ {pending, accepted, rejected, expired}
 *   - sibling-auto-rejection on accept (one accepted ⇒ siblings → rejected)
 *   - `expiresAt < now()` flips pending → expired on next access
 *
 * Used by:
 *   - web-app/src/pages/customer/CustomerQuotesPage.tsx     (this sprint)
 *   - web-app/src/pages/provider/ProviderQuoteWorkbench.tsx (Quote 0C)
 */
import type {
  QuoteStatus,
  QuoteCustomerPerception,
  QuoteCompetitiveness,
  QuoteDoc,
  RawBackendQuoteStatus,
  AccountLike,
} from '../contracts/quote';

// ─────────────────────────────────────────────────────────────────────
// (A) Backend → operational normalisation.
//
// Backend currently emits 4 status strings. Forward-looking ones
// (`viewed`, `withdrawn`, `declined`, `draft`) extend the map first;
// shared still has to compile when the wire grows. Unknown values
// fall back to `'sent'` — the closest "open quote" semantic — so
// that consumers never crash on an unmapped string.
// ─────────────────────────────────────────────────────────────────────

const RAW_BACKEND_STATUS_MAP: Readonly<Record<string, QuoteStatus>> = {
  pending: 'sent',
  accepted: 'accepted',
  /** Backend collapses sibling-auto-rejected and customer-explicit-decline
   *  into a single `rejected`. Shared maps both to `declined` here.
   *  Provider-side disambiguation lives in Quote 0C. */
  rejected: 'declined',
  declined: 'declined',
  expired: 'expired',
  withdrawn: 'withdrawn',
  viewed: 'viewed',
  draft: 'draft',
} as const;

export function normalizeBackendQuoteStatus(
  status: RawBackendQuoteStatus | null | undefined,
): QuoteStatus {
  if (!status) return 'sent';
  const mapped = RAW_BACKEND_STATUS_MAP[String(status).toLowerCase()];
  return mapped ?? 'sent';
}

export function statusOf(doc: Pick<QuoteDoc, 'status'> | null | undefined): QuoteStatus {
  return normalizeBackendQuoteStatus(doc?.status ?? null);
}

// ─────────────────────────────────────────────────────────────────────
// (B) Hybrid expiration — backend = source of truth, shared = preemptive
//     UI projection.
//
// Shared NEVER mutates operational status. `isEffectivelyExpired`
// returns true when `expiresAt` is in the past, regardless of whether
// backend has flipped the status yet. Consumers gate UI ("Accept"
// button disabled, badge greyed out) on this projection, while the
// authoritative status field stays untouched.
//
// `effectiveStatus` then collapses the operational+expiration view
// into a single `QuoteStatus` — for surfaces that do not want to
// branch twice.
// ─────────────────────────────────────────────────────────────────────

export function isEffectivelyExpired(
  doc: Pick<QuoteDoc, 'expiresAt'> | null | undefined,
  now: Date | string = new Date(),
): boolean {
  const exp = doc?.expiresAt;
  if (!exp) return false;
  const nowIso = typeof now === 'string' ? now : now.toISOString();
  return String(exp) < nowIso;
}

/**
 * Operational status with preemptive expiration applied. Returns
 * `'expired'` when `expiresAt` is in the past AND the backend status
 * is still in an "open" position (`draft` / `sent` / `viewed`). For
 * already-terminal positions (`accepted`, `declined`, `withdrawn`,
 * `expired`) the original status is preserved — once you've won or
 * lost, the clock is irrelevant.
 */
export function effectiveStatus(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt'> | null | undefined,
  now: Date | string = new Date(),
): QuoteStatus {
  const s = statusOf(doc);
  if (s === 'draft' || s === 'sent' || s === 'viewed') {
    if (isEffectivelyExpired(doc, now)) return 'expired';
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────
// (C) Allowed transitions on the operational ladder.
//
// Surfaces NEVER drive transitions directly — only the backend mutates
// the row. This map is for assertion (mergeMonotonic) and for UI
// preflight ("can the customer-facing Accept button be enabled?").
//
// Notable rules:
//   - `accepted` cannot succeed `expired` — race condition guard.
//   - `accepted` is terminal — no path back, no refund-style relapse.
//   - `withdrawn` only from `draft` / `sent` / `viewed` (provider can
//     pull a quote before customer decides; not after).
//   - `viewed` is a forward step from `sent` only — there's no
//     "un-view".
// ─────────────────────────────────────────────────────────────────────

export function allowedTransitions(
  current: QuoteStatus,
): readonly QuoteStatus[] {
  switch (current) {
    case 'draft':
      return ['sent', 'withdrawn'] as const;
    case 'sent':
      return ['viewed', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
    case 'viewed':
      return ['accepted', 'declined', 'expired', 'withdrawn'] as const;
    case 'accepted':
    case 'declined':
    case 'expired':
    case 'withdrawn':
      return [] as const;
    default:
      return [] as const;
  }
}

export function isTerminal(status: QuoteStatus): boolean {
  return status === 'accepted'
      || status === 'declined'
      || status === 'expired'
      || status === 'withdrawn';
}

// ─────────────────────────────────────────────────────────────────────
// (D) Customer perception projection.
//
// This is where `selected` lives — and ONLY here. Note the function
// signature: it takes BOTH the quote and an optional context flag
// (`isCustomerSelection`). The flag answers "is this the quote the
// customer's UI is currently treating as selected?". A quote is
// `selected` from the customer's perspective when:
//
//   1. Its operational status is `accepted`, AND
//   2. The customer is looking at the same request context.
//
// Without (2) — e.g. the customer has many requests, each with its
// own accepted quote — every accepted quote would falsely render as
// `selected` in unrelated contexts. The flag forces the consumer to
// be explicit about which row, in which list, in which view.
//
// Default flag is `true`: in the typical request-detail page, every
// `accepted` quote on screen IS the selected one — there is exactly
// one per request.
// ─────────────────────────────────────────────────────────────────────

export interface CustomerPerceptionContext {
  /** ISO-8601. Defaults to "now". */
  now?: Date | string;
  /** When `false`, an `accepted` operational status projects to
   *  `'unavailable'` instead of `'selected'`. Use this when the
   *  consumer is NOT on the request-detail page (e.g. a global
   *  "all my quotes" feed where multiple sibling-rejected quotes
   *  appear next to a different request's winner). Default `true`. */
  isCustomerSelection?: boolean;
}

export function customerPerceptionFor(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt'> | null | undefined,
  ctx: CustomerPerceptionContext = {},
): QuoteCustomerPerception {
  if (!doc) return 'pending';
  const s = effectiveStatus(doc, ctx.now ?? new Date());
  switch (s) {
    case 'draft':
      return 'pending';
    case 'sent':
    case 'viewed':
      return 'available';
    case 'accepted':
      // `selected` is the customer-perception projection of operational
      // `accepted`. The `isCustomerSelection` flag prevents accidental
      // collapse across unrelated request contexts (see comment above).
      return ctx.isCustomerSelection === false ? 'unavailable' : 'selected';
    case 'declined':
    case 'expired':
    case 'withdrawn':
      return 'unavailable';
    default:
      return 'unavailable';
  }
}

// ─────────────────────────────────────────────────────────────────────
// (E) Marketplace competitiveness projection.
//
// CONSERVATIVE MVP: `ranked` for active quotes, `archived` for terminals.
// `boosted` and `shadowed` will join when a real ranking consumer
// surfaces. Premature modelling of strategy here would force this file
// to grow tracking/algorithm concerns it shouldn't own.
// ─────────────────────────────────────────────────────────────────────

export function competitivenessFor(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt'> | null | undefined,
  now: Date | string = new Date(),
): QuoteCompetitiveness {
  return isTerminal(effectiveStatus(doc, now)) ? 'archived' : 'ranked';
}

// ─────────────────────────────────────────────────────────────────────
// (F) Permissions — inline, explicit, capability-aware.
//
// We resist the temptation to factor these into `permissions/quote.ts`
// just yet (Architecture.md Section J / K — no premature module).
// When a second domain needs the same shape, Shared 0C will extract
// the pattern naturally.
//
// Rules below mirror backend write-paths (`accept_quote`, sibling
// rejection, expiration check). Frontend uses them for accurate UI
// gating; backend is still the authoritative gate.
// ─────────────────────────────────────────────────────────────────────

/**
 * Customer can accept/select an open quote on a request they own.
 * Backend re-validates on `POST /api/quotes/{id}/accept`; this is UI
 * gating only.
 *
 *   - account.kind must be `'customer'`.
 *   - quote must be operationally open (`sent` / `viewed`).
 *   - quote must NOT be effectively expired (preemptive).
 *   - account ownership of the parent request is the consumer's
 *     responsibility to verify (we don't have the request doc here);
 *     pass the right account or pre-filter the list.
 */
export function canAcceptQuote(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt'> | null | undefined,
  account: AccountLike | null | undefined,
  now: Date | string = new Date(),
): boolean {
  if (!doc || !account || account.kind !== 'customer') return false;
  const s = effectiveStatus(doc, now);
  return s === 'sent' || s === 'viewed';
}

/**
 * Alias of `canAcceptQuote` — separate name signals customer-perception
 * intent ("can the customer SELECT this in the UI") vs operational
 * intent ("can backend accept this transition"). Same rules today;
 * leave both so future divergence (e.g. preview-vs-commit) doesn't
 * require renaming consumers.
 */
export function canSelectQuote(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt'> | null | undefined,
  account: AccountLike | null | undefined,
  now: Date | string = new Date(),
): boolean {
  return canAcceptQuote(doc, account, now);
}

/**
 * Provider can withdraw their own quote before any decision lands.
 *
 *   - account.kind must be `'provider'`.
 *   - account.providerSlug must match `doc.providerSlug`.
 *   - quote must be operationally open (`draft` / `sent` / `viewed`).
 *   - effective expiration locks withdrawal (backend would refuse anyway).
 */
export function canWithdrawQuote(
  doc: Pick<QuoteDoc, 'status' | 'expiresAt' | 'providerSlug' | 'provider'> | null | undefined,
  account: AccountLike | null | undefined,
  now: Date | string = new Date(),
): boolean {
  if (!doc || !account || account.kind !== 'provider') return false;
  const ownerSlug = doc.providerSlug ?? doc.provider?.slug;
  if (!ownerSlug || ownerSlug !== account.providerSlug) return false;
  const s = effectiveStatus(doc, now);
  return s === 'draft' || s === 'sent' || s === 'viewed';
}

/**
 * Who can read a quote.
 *
 *   - admin: always.
 *   - provider: only their own quote.
 *   - customer: any quote on their own request (consumer pre-filters
 *     by ownership; this predicate is permissive at the customer kind
 *     because we don't have the request linkage in scope).
 *   - guest: never.
 *
 * Withdrawn quotes are visible to admin/provider for audit but
 * invisible to the customer (per spec rule: "withdrawn invisible to
 * customer").
 */
export function canViewQuote(
  doc: Pick<QuoteDoc, 'status' | 'providerSlug' | 'provider'> | null | undefined,
  account: AccountLike | null | undefined,
): boolean {
  if (!doc || !account) return false;
  const s = statusOf(doc);
  switch (account.kind) {
    case 'admin':
      return true;
    case 'provider': {
      const ownerSlug = doc.providerSlug ?? doc.provider?.slug;
      return Boolean(ownerSlug && ownerSlug === account.providerSlug);
    }
    case 'customer':
      return s !== 'withdrawn';
    case 'guest':
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────
// (G) Monotonic merge — refuses silent downgrades.
//
//   - Terminal states (`accepted` / `declined` / `expired` /
//     `withdrawn`) are sticky; nothing supersedes them.
//   - Among terminals, equality only — we do NOT pick a "winner"
//     between two contradictory terminals. That's a backend bug;
//     surface MUST not silently choose one.
//   - Among open positions, the higher-on-ladder wins
//     (draft < sent < viewed < open-but-resolved).
//   - `null` / `undefined` is the bottom; any value wins.
// ─────────────────────────────────────────────────────────────────────

const OPEN_ORDER: Readonly<Record<QuoteStatus, number>> = {
  draft: 0,
  sent: 1,
  viewed: 2,
  // Terminals get -1 — they don't participate in ordinal comparisons,
  // they short-circuit via the explicit branches in `mergeMonotonic`.
  accepted: -1,
  declined: -1,
  expired: -1,
  withdrawn: -1,
} as const;

export function mergeMonotonic(
  prev: QuoteStatus | null | undefined,
  next: QuoteStatus | null | undefined,
): QuoteStatus | null {
  if (!prev && !next) return null;
  if (!prev) return next ?? null;
  if (!next) return prev;
  if (prev === next) return prev;

  const prevTerminal = isTerminal(prev);
  const nextTerminal = isTerminal(next);

  // Both terminal but different → contradiction. Keep `prev` and
  // let the consumer log/alert. We do NOT pick winner; that's a
  // backend write bug, not a presentation choice.
  if (prevTerminal && nextTerminal) return prev;

  // One terminal beats any non-terminal (or stale poll trying to
  // resurrect a closed quote — common race condition).
  if (prevTerminal) return prev;
  if (nextTerminal) return next;

  // Both on the open ladder — pick the higher.
  return OPEN_ORDER[next] > OPEN_ORDER[prev] ? next : prev;
}

// ─────────────────────────────────────────────────────────────────────
// (H) Self-test invariants — runtime-callable, framework-free.
//
// Same pattern as `inspection-report.ts` and `payment.ts`. Surfaces
// opt-in via `assertQuoteInvariants()`; tree-shaken in production.
// ─────────────────────────────────────────────────────────────────────

export function assertQuoteInvariants(): void {
  const eq = <T>(a: T, b: T, label: string) => {
    if (a !== b) {
      throw new Error(
        `quote invariant failed: ${label} (got=${String(a)} want=${String(b)})`,
      );
    }
  };

  // ── (A) backend normalisation ──────────────────────────────────────
  eq(normalizeBackendQuoteStatus('pending'), 'sent', 'pending → sent');
  eq(normalizeBackendQuoteStatus('accepted'), 'accepted', 'accepted → accepted');
  eq(normalizeBackendQuoteStatus('rejected'), 'declined', 'rejected → declined');
  eq(normalizeBackendQuoteStatus('expired'), 'expired', 'expired → expired');
  eq(normalizeBackendQuoteStatus('viewed'), 'viewed', 'viewed → viewed');
  eq(normalizeBackendQuoteStatus('withdrawn'), 'withdrawn', 'withdrawn → withdrawn');
  eq(normalizeBackendQuoteStatus('draft'), 'draft', 'draft → draft');
  eq(normalizeBackendQuoteStatus(null), 'sent', 'null → sent (safe fallback)');
  eq(normalizeBackendQuoteStatus(undefined), 'sent', 'undefined → sent');
  eq(normalizeBackendQuoteStatus('totally_unknown'), 'sent', 'unknown → sent (safe fallback)');

  // ── (B) hybrid expiration ──────────────────────────────────────────
  const past = '2020-01-01T00:00:00Z';
  const future = '2099-01-01T00:00:00Z';
  const fakeNow = '2026-01-01T00:00:00Z';
  eq(isEffectivelyExpired({ expiresAt: past }, fakeNow), true, 'past expiresAt → expired');
  eq(isEffectivelyExpired({ expiresAt: future }, fakeNow), false, 'future expiresAt → not expired');
  eq(isEffectivelyExpired({ expiresAt: null }, fakeNow), false, 'no expiresAt → not expired');

  // effectiveStatus folds clock into open positions only
  eq(effectiveStatus({ status: 'pending', expiresAt: past }, fakeNow), 'expired', 'pending+past → expired');
  eq(effectiveStatus({ status: 'pending', expiresAt: future }, fakeNow), 'sent', 'pending+future → sent');
  eq(effectiveStatus({ status: 'accepted', expiresAt: past }, fakeNow), 'accepted', 'accepted+past stays accepted (terminal wins)');
  eq(effectiveStatus({ status: 'rejected', expiresAt: past }, fakeNow), 'declined', 'rejected+past → declined (clock irrelevant)');

  // ── (C) allowed transitions ────────────────────────────────────────
  eq(allowedTransitions('draft').includes('sent'), true, 'draft → sent allowed');
  eq(allowedTransitions('draft').includes('withdrawn'), true, 'draft → withdrawn allowed');
  eq(allowedTransitions('sent').includes('accepted'), true, 'sent → accepted allowed');
  eq(allowedTransitions('sent').includes('expired'), true, 'sent → expired allowed');
  eq(allowedTransitions('viewed').includes('accepted'), true, 'viewed → accepted allowed');
  eq(allowedTransitions('expired').length, 0, 'expired is terminal');
  eq(allowedTransitions('expired').includes('accepted' as QuoteStatus), false, 'expired CANNOT become accepted (race guard)');
  eq(allowedTransitions('accepted').length, 0, 'accepted is terminal');
  eq(allowedTransitions('declined').length, 0, 'declined is terminal');
  eq(allowedTransitions('withdrawn').length, 0, 'withdrawn is terminal');

  eq(isTerminal('accepted'), true, 'accepted is terminal');
  eq(isTerminal('declined'), true, 'declined is terminal');
  eq(isTerminal('expired'), true, 'expired is terminal');
  eq(isTerminal('withdrawn'), true, 'withdrawn is terminal');
  eq(isTerminal('sent'), false, 'sent is not terminal');
  eq(isTerminal('viewed'), false, 'viewed is not terminal');
  eq(isTerminal('draft'), false, 'draft is not terminal');

  // ── (D) customer perception projection ─────────────────────────────
  eq(customerPerceptionFor({ status: 'pending', expiresAt: future }, { now: fakeNow }), 'available', 'pending → available');
  eq(customerPerceptionFor({ status: 'viewed', expiresAt: future }, { now: fakeNow }), 'available', 'viewed → available');
  eq(customerPerceptionFor({ status: 'draft', expiresAt: future }, { now: fakeNow }), 'pending', 'draft → pending');
  eq(customerPerceptionFor({ status: 'accepted', expiresAt: future }, { now: fakeNow }), 'selected', 'accepted (default) → selected');
  eq(customerPerceptionFor({ status: 'accepted', expiresAt: future }, { now: fakeNow, isCustomerSelection: false }), 'unavailable', 'accepted (cross-context) → unavailable');
  eq(customerPerceptionFor({ status: 'rejected', expiresAt: future }, { now: fakeNow }), 'unavailable', 'rejected → unavailable');
  eq(customerPerceptionFor({ status: 'withdrawn', expiresAt: future }, { now: fakeNow }), 'unavailable', 'withdrawn → unavailable (invisible to customer)');
  eq(customerPerceptionFor({ status: 'pending', expiresAt: past }, { now: fakeNow }), 'unavailable', 'pending+expired → unavailable (preemptive)');
  eq(customerPerceptionFor(null), 'pending', 'null doc → pending');

  // ── (E) competitiveness ────────────────────────────────────────────
  eq(competitivenessFor({ status: 'pending', expiresAt: future }, fakeNow), 'ranked', 'open quote → ranked');
  eq(competitivenessFor({ status: 'pending', expiresAt: past }, fakeNow), 'archived', 'expired-by-clock → archived');
  eq(competitivenessFor({ status: 'accepted', expiresAt: future }, fakeNow), 'archived', 'accepted → archived');
  eq(competitivenessFor({ status: 'rejected', expiresAt: future }, fakeNow), 'archived', 'rejected → archived');

  // ── (F) permissions ────────────────────────────────────────────────
  const cust: AccountLike = { kind: 'customer', userId: 'u1' };
  const prov: AccountLike = { kind: 'provider', providerSlug: 'auto-x' };
  const provOther: AccountLike = { kind: 'provider', providerSlug: 'auto-y' };
  const admin: AccountLike = { kind: 'admin' };
  const guest: AccountLike = { kind: 'guest' };
  const openQuote = { status: 'pending' as const, expiresAt: future, providerSlug: 'auto-x', provider: { slug: 'auto-x', name: 'Auto X', rating: 5, reviews: 1, tuvVerified: true } };
  const expiredQuote = { ...openQuote, expiresAt: past };
  const acceptedQuote = { ...openQuote, status: 'accepted' as const };

  eq(canAcceptQuote(openQuote, cust, fakeNow), true, 'customer can accept open quote');
  eq(canAcceptQuote(expiredQuote, cust, fakeNow), false, 'customer cannot accept expired (preemptive)');
  eq(canAcceptQuote(acceptedQuote, cust, fakeNow), false, 'customer cannot re-accept accepted');
  eq(canAcceptQuote(openQuote, prov, fakeNow), false, 'provider cannot accept (only customer can)');
  eq(canAcceptQuote(openQuote, guest, fakeNow), false, 'guest cannot accept');
  eq(canSelectQuote(openQuote, cust, fakeNow), true, 'canSelectQuote === canAcceptQuote');

  eq(canWithdrawQuote(openQuote, prov, fakeNow), true, 'provider-owner can withdraw open');
  eq(canWithdrawQuote(openQuote, provOther, fakeNow), false, 'other provider cannot withdraw');
  eq(canWithdrawQuote(openQuote, cust, fakeNow), false, 'customer cannot withdraw');
  eq(canWithdrawQuote(acceptedQuote, prov, fakeNow), false, 'provider cannot withdraw accepted (terminal)');
  eq(canWithdrawQuote(expiredQuote, prov, fakeNow), false, 'provider cannot withdraw expired (preemptive)');

  eq(canViewQuote(openQuote, admin), true, 'admin can view any');
  eq(canViewQuote(openQuote, prov), true, 'provider can view own');
  eq(canViewQuote(openQuote, provOther), false, 'provider cannot view other');
  eq(canViewQuote(openQuote, cust), true, 'customer can view non-withdrawn');
  eq(canViewQuote({ ...openQuote, status: 'withdrawn' }, cust), false, 'customer cannot see withdrawn (invisibility rule)');
  eq(canViewQuote(openQuote, guest), false, 'guest cannot view');

  // ── (G) monotonic merge ────────────────────────────────────────────
  eq(mergeMonotonic('accepted', 'sent'), 'accepted', 'accepted sticks vs stale sent');
  eq(mergeMonotonic('expired', 'accepted'), 'expired', 'expired blocks late accepted (race guard)');
  eq(mergeMonotonic('accepted', 'expired'), 'accepted', 'accepted wins vs late expired');
  eq(mergeMonotonic('declined', 'sent'), 'declined', 'declined sticks vs stale sent');
  eq(mergeMonotonic('withdrawn', 'sent'), 'withdrawn', 'withdrawn sticks vs stale sent');
  // Two contradictory terminals: keep prev (consumer should alert).
  eq(mergeMonotonic('declined', 'expired'), 'declined', 'two terminals → keep prev (no silent winner)');
  eq(mergeMonotonic('sent', 'viewed'), 'viewed', 'sent → viewed forward step');
  eq(mergeMonotonic('draft', 'sent'), 'sent', 'draft → sent forward step');
  eq(mergeMonotonic('viewed', 'draft'), 'viewed', 'no downgrade viewed → draft');
  eq(mergeMonotonic(null, 'sent'), 'sent', 'null is bottom');
  eq(mergeMonotonic('sent', null), 'sent', 'null does not erase');
  eq(mergeMonotonic('accepted', 'accepted'), 'accepted', 'idempotent equality');
}
