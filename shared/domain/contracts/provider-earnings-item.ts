/**
 * ProviderEarningsItem — provider-facing earnings projection.
 *
 * Doctrine (see /app/memory/PRD.md, Phase 3.1):
 *   "What does provider believe about money?"
 *   work completed ≠ client paid ≠ provider earned ≠ provider paid out
 *
 * THIS IS NOT A STATE MACHINE.
 * THIS IS NOT FINANCIAL TRUTH.
 *
 * Sources of truth (not touched by this contract):
 *   - booking truth     → db.bookings.finalPrice              (gross customer-side)
 *   - payment truth     → db.payments                         (customer → platform)
 *   - lead-fee truth    → db.auction_charges                  (provider → platform)
 *   - inspection truth  → db.inspection_reports.status        (operational closure)
 *
 * The projector lives in `backend/app/provider/earnings.py`. It is the
 * ONLY place allowed to map underlying truths into ProviderEarningsItemState.
 *
 * Hard boundaries:
 *   1. ProviderEarningsItem has no own write authority. Phase 3.1 has no
 *      mutation endpoints — money state advances are derivational, computed
 *      from the underlying truths each request.
 *   2. Provider UI MUST NOT branch on raw payment.status / charge.status.
 *      If a new perception is needed, grow `ProviderEarningsItemState`
 *      HERE (and in the projector) — never branch in the UI.
 *   3. lead_fee items NEVER carry state='paid_out'. paid_out is a
 *      provider-facing money-IN lifecycle slot. Mixing deductions there
 *      semantically collapses "money I received" with "money platform
 *      took". Keep the two disjoint forever — that is what `deducted`
 *      exists for.
 *   4. Currency boundary is hard. Items in different currencies NEVER
 *      auto-sum. Summary is `byCurrency: [...]`, never one collapsed total.
 *      Phase 3.1 does no FX conversion. Period.
 */

/**
 * Six states. Provider-facing money perception.
 *
 * Phase 3.1 emits only:
 *   - `pending`       (work closed, customer hasn't paid yet)
 *   - `payable`       (platform has the money, transfer to provider pending)
 *   - `disputed_hold` (linked payment disputed/refunded/chargeback)
 *   - `deducted`      (lead_fee items — final the moment recorded)
 *
 * Phase 3.1 RESERVES (never emits):
 *   - `processing`    (payout pipeline running — Phase 3.3)
 *   - `paid_out`      (settled to provider — Phase 3.3)
 *
 * Adding a new state here = doctrine decision. Do NOT widen this union to
 * mirror payment-provider lexicon (`succeeded`, `requires_action`, etc.).
 */
export type ProviderEarningsItemState =
  | 'pending'
  | 'payable'
  | 'processing'      // RESERVED — Phase 3.3
  | 'paid_out'        // RESERVED — Phase 3.3
  | 'disputed_hold'
  | 'deducted';

/**
 * Earnings item kind.
 *
 * - `job`      : positive earning from a completed work item (booking
 *                or approved inspection report).
 * - `lead_fee` : negative deduction (provider paid platform for the lead).
 *                MUST always carry state='deducted' and amount.net < 0.
 *
 * Phase 3.1 ships exactly these two kinds. Subscription / boost purchases
 * (`db.provider_purchases`) are operational costs — NOT earnings — and
 * stay out of this projection. If/when needed, they get their own
 * projection (ProviderCostItem), not a new kind here.
 */
export type ProviderEarningsItemKind = 'job' | 'lead_fee';

/**
 * Money breakdown for ONE item. Gross/fee/net is sufficient for provider
 * perception; deeper splits (taxes, processor fees, etc.) belong to a
 * future ProviderEarningsBreakdown projection if ever needed.
 */
export interface ProviderEarningsItemAmount {
  /**
   * What the customer agreed to pay for this work (gross).
   * 0 for lead_fee items.
   */
  gross: number;
  /**
   * Platform / lead-cost deductions specific to THIS item.
   * Always non-negative.
   * For lead_fee items: this is the lead price.
   */
  fee: number;
  /**
   * What the provider actually nets.
   *   job      : net = gross - fee     (≥ 0 in normal flows)
   *   lead_fee : net = -fee            (always negative)
   */
  net: number;
  /** ISO 4217. Items in different currencies NEVER auto-sum. */
  currency: string;
}

/**
 * Why money is not currently moving for this item. Set only for
 * state='disputed_hold'. The code set is small and closed — adding a
 * new code is a doctrine decision, not a UI patch.
 */
export type ProviderEarningsItemBlockedCode =
  | 'payment_disputed'
  | 'payment_refunded'
  | 'admin_hold'
  | 'documents_missing';

export interface ProviderEarningsItemBlockedReason {
  code: ProviderEarningsItemBlockedCode;
  /** Already-localized one-liner. UI shows verbatim. */
  message: string;
  /** Who unblocks. UI renders the right contact CTA. */
  contactWho: 'support' | 'admin' | 'customer';
}

export interface ProviderEarningsItemService {
  /** Provider-friendly label. e.g. "Pre-purchase inspection · BMW X5". */
  label: string;
  /** Display name; pre-truncated server-side. */
  customerName?: string;
}

export interface ProviderEarningsItem {
  /** Opaque id. 'er_<bookingId>' for jobs, 'lf_<chargeId>' for lead_fees. */
  id: string;
  kind: ProviderEarningsItemKind;
  state: ProviderEarningsItemState;

  /**
   * Back-pointer to the ProviderWorkItem that produced this earning.
   * UI uses it to jump to the work item; it MUST NOT be parsed for
   * business logic.
   */
  workItemId?: string;

  amount: ProviderEarningsItemAmount;

  /** When the item entered its current state (ISO). Drives "5 min ago". */
  recognizedAt: string;

  /**
   * Soft SLA. After this moment, UI may render an "expected by X" /
   * "overdue" hint. The projector decides — UI does NOT compute SLA on
   * its own.
   */
  expectedSettlementBy?: string;

  /** Present iff state='disputed_hold'. */
  blockedReason?: ProviderEarningsItemBlockedReason;

  service: ProviderEarningsItemService;
}

/**
 * Per-currency aggregation. NEVER mixed across currencies.
 *
 * Each state-bucket carries `count` and `net`. Phase 3.1 deliberately
 * does NOT publish a single "total" number — provider sees one row per
 * currency and reads them as orthogonal realities.
 */
export interface ProviderEarningsCurrencyBucket {
  currency: string;
  pending:        { count: number; net: number };
  payable:        { count: number; net: number };
  processing:     { count: number; net: number };
  paid_out:       { count: number; net: number };
  disputed_hold:  { count: number; net: number };
  deducted:       { count: number; net: number };
}

export interface ProviderEarningsSummary {
  byCurrency: ProviderEarningsCurrencyBucket[];
}

/** Wire envelope for `GET /api/provider/earnings/items`. */
export interface ProviderEarningsItemsResponse {
  items: ProviderEarningsItem[];
  summary: ProviderEarningsSummary;
}

/** Wire envelope for `GET /api/provider/earnings/summary`. */
export interface ProviderEarningsSummaryResponse {
  summary: ProviderEarningsSummary;
  /** Server-side computed timestamp the summary reflects. */
  lastRefreshedAt: string;
}
