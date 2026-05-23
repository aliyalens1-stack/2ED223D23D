/**
 * Quote — entity contract.
 *
 * MIRRORS backend `app/marketplace/requests.py` — `request_quotes`
 * collection. A `Quote` is a provider's offer attached to a customer
 * `Request`; multiple providers compete for the same request and
 * exactly one quote can ultimately be accepted.
 *
 *   Backend persists `status` ∈ {pending, accepted, rejected, expired}
 *   plus `expiresAt`. Shared models a forward-looking 7-state ladder
 *   that absorbs backend strings via `RAW_BACKEND_STATUS_MAP` in
 *   `state-machines/quote.ts`. New backend statuses (`viewed`,
 *   `withdrawn`, `declined`) extend that map first; consumers second.
 *
 * NOT THE SAME DOMAIN AS:
 *   `app/auto_requests/router_candidates.py` — those are recommended
 *   *vehicles* for an auto-selection request, not negotiation quotes
 *   for a service. Different lifecycle, different ownership, different
 *   monetisation. Do NOT reuse this contract for candidate cars.
 *
 * Used by:
 *   - web-app/src/pages/customer/CustomerQuotesPage.tsx     (this sprint)
 *   - web-app/src/pages/provider/ProviderQuoteWorkbench.tsx (Quote 0C)
 */

// ─────────────────────────────────────────────────────────────────────
// (1) OPERATIONAL LIFECYCLE — backend truth.
//
//   draft     — provider composing the quote (pre-send). Not visible to
//               customer or marketplace. Reserved for a forthcoming
//               provider workbench; backend has no `draft` row today.
//   sent      — quote is live, awaiting customer action. Maps from
//               backend `pending`.
//   viewed    — customer opened the quote at least once. Reserved for
//               analytics-driven backend extension; backend has no
//               `viewed` status today.
//   accepted  — customer picked this quote. Triggers booking creation
//               and sibling auto-rejection. Terminal.
//   declined  — quote did not win: either sibling was accepted (backend
//               `rejected`) or customer explicitly declined. Terminal.
//               Provider-side semantics may distinguish later (Quote 0C).
//   expired   — `expiresAt` elapsed before acceptance. Terminal. Cannot
//               become `accepted` even on a race; backend re-checks.
//   withdrawn — provider rescinded the quote before any decision.
//               Reserved. Terminal.
// ─────────────────────────────────────────────────────────────────────

export type QuoteStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'accepted'
  | 'declined'
  | 'expired'
  | 'withdrawn';

export const QUOTE_STATUSES: readonly QuoteStatus[] = [
  'draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn',
] as const;

// ─────────────────────────────────────────────────────────────────────
// (2) CUSTOMER PERCEPTION — what the buyer sees about a quote.
//
// HARD RULE — DO NOT COLLAPSE:
//   `selected` is a CUSTOMER projection of an `accepted` operational
//   quote, in the context of a specific request the customer is
//   looking at. It is NOT a separate operational state.
//
//   ❌ WRONG:  quote.status = 'selected'
//   ✅ RIGHT:  quote.status = 'accepted' AND
//              customerPerceptionFor(quote) = 'selected'
//
// Confusing the two breaks reconciliation with payouts, analytics,
// and the marketplace ranking domain. The orthogonality is enforced
// by the type system: `QuoteStatus` and `QuoteCustomerPerception`
// are disjoint string-literal unions.
//
//   pending      — quote is being computed / arriving. UI shows a
//                  spinner. Maps from `draft`.
//   available    — open for selection. Maps from `sent` and `viewed`.
//   selected     — this is the quote the customer accepted.
//   unavailable  — sibling won, customer declined, expired, withdrawn.
// ─────────────────────────────────────────────────────────────────────

export type QuoteCustomerPerception =
  | 'pending'
  | 'available'
  | 'selected'
  | 'unavailable';

// ─────────────────────────────────────────────────────────────────────
// (3) MARKETPLACE COMPETITIVENESS — what the platform's ranking layer
//     does with the quote.
//
// CONSERVATIVE MVP: only `ranked` and `archived`. `boosted` and
// `shadowed` are intentionally absent until a real marketplace-strategy
// consumer needs them. This module models QUOTE BEHAVIOUR, not
// marketplace strategy.
//
//   ranked    — quote participates in the active marketplace listing.
//   archived  — quote no longer competes (operationally terminal).
// ─────────────────────────────────────────────────────────────────────

export type QuoteCompetitiveness = 'ranked' | 'archived';

// ─────────────────────────────────────────────────────────────────────
// Wire shape — exact mirror of `request_quotes` documents.
// ─────────────────────────────────────────────────────────────────────

/** Backend-current status strings as they appear on the wire. */
export type RawBackendQuoteStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'expired'
  /** Forward-looking mappings — backend may add these later. */
  | 'viewed'
  | 'declined'
  | 'withdrawn'
  | 'draft'
  | (string & {}); // permissive — unknown values fall back to `'sent'`.

export interface QuoteProviderSnapshot {
  name: string;
  slug: string;
  rating: number;
  reviews: number;
  tuvVerified: boolean;
  yearsExperience?: number | null;
  type?: string | null;
}

export interface QuoteDoc {
  id: string;
  requestId: string;
  providerSlug: string;
  provider: QuoteProviderSnapshot;
  priceFrom: number;
  currency: string;
  estimatedTimeMinutes: number;
  responseTime?: string | null;
  message?: string | null;
  status: RawBackendQuoteStatus | null;
  /** ISO-8601 — backend uses `expiresAt < now` to flip pending → expired
   *  on access. Shared uses it for preemptive UI gating. */
  expiresAt?: string | null;
  /** ISO-8601 — set when status flips to `accepted`. */
  acceptedAt?: string | null;
  /** ISO-8601 — created timestamp. */
  createdAt?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Account shape used by permission predicates. Intentionally minimal —
// shared does NOT own a full identity model (that is `identity/account.ts`).
// We accept any object that exposes `kind`; passing the canonical
// `Account` type from `@platform/domain/identity/account` works.
// ─────────────────────────────────────────────────────────────────────

export type AccountKind = 'customer' | 'provider' | 'admin' | 'guest';

export interface AccountLike {
  kind: AccountKind;
  /** Required for provider permission checks. Optional for customer/admin. */
  providerSlug?: string;
  /** Required for customer permission checks (request ownership). */
  userId?: string;
}
