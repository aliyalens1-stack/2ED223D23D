# Payments-2A — Mobile pay-button (FROZEN 2026-05-16)

## Scope

Customer-facing pay surface on the request detail screen. The minimal
customer path that turns a confirmed pricing snapshot into an opened
Stripe Checkout session.

```
confirmed quote
  → "Оплатить €X" (X read from snapshot)
  → POST /api/payments/snapshot/checkout/{requestId}
  → open checkoutUrl
  → return to /payment-success
  → read transaction by session_id
```

## Out of scope (deferred to subsequent rounds)

- Stripe webhook → Payments-2B
- Auto-prepare quote → Payments-2C
- Admin payments read-only → Payments-2D
- Refunds
- Recalculation
- Amount supplied by frontend

## Invariants (carried up from Payments-1)

1. **Frontend MUST NOT send `amount` to checkout.** The body has only
   `originUrl` and optional `method`. The backend reads
   `car_requests.pricing.customerTotal` from the confirmed snapshot.
2. **The displayed price MUST come from the quote snapshot**, not from
   ad-hoc pricing math on the client. We render
   `€{Math.round(quote.customerTotal)}` after `quote.status === 'confirmed'`.
3. **The Pay button is invisible until the customer has confirmed the
   quote.** This is enforced both client-side (the JSX gate) and
   server-side (409 PRICING_SNAPSHOT_UNCONFIRMED).
4. **No new "pricing" / "checkout" calculator code on the frontend.**
   The new module `src/services/snapshotPayments.ts` is a thin typed
   fetch wrapper — it has no math, no fallback logic, no defaults.

## Files touched

| File | Change |
|------|--------|
| `frontend/src/services/snapshotPayments.ts` | **new** — typed wrappers `createSnapshotCheckout()` + `getSnapshotTransaction()` |
| `frontend/app/auto-request/[id].tsx` | added `payBusy/payError` state, `handlePay`, "Оплатить €X" CTA gated on `quote.status==='confirmed'` && req.status ∈ {open, matching, null} |
| `frontend/app/payment-success.tsx` | poll calls `getSnapshotTransaction(session_id)` first; legacy `/payments/auto-request/status` retained as fallback for in-flight Phase 3.0b sessions |

## Pre-existing bugs incidentally fixed

- `handleQuote` and `handleConfirmQuote` were referenced from JSX but
  not defined — Metro tolerated this, but the "Зафиксировать цену" /
  "Показать стоимость инспекции" CTAs would have thrown
  `ReferenceError` at first click. Both are now defined as small
  `useCallback`'d wrappers around the existing `previewRequestQuote` /
  `confirmRequestQuote` service calls.

## End-to-end verified (mock mode)

```
POST /api/customer/requests              → id=625b9390-…
POST /api/customer/requests/{id}/quote   → {status:pending, customerTotal:199}
POST /api/customer/requests/{id}/quote/confirm
                                         → {status:confirmed, customerTotal:199}
POST /api/payments/snapshot/checkout/{id} body={"originUrl":"…","method":"mock"}
                                         → {sessionId:snap_…, url:…, amount:199, provider:mock,
                                            pricingSnapshot.customerTotal:199, confirmedAt:…}
GET  /api/payments/snapshot/transaction/{sessionId}
                                         → {paid:false, amount:199, status:initiated,
                                            paymentStatus:unpaid, requestId:625b9390-…}
```

Anti-drift wall verified:

```
POST /api/payments/snapshot/checkout/{fresh-id-no-quote}     → 409 CONFLICT
POST /api/payments/snapshot/checkout/{previewed-not-confirmed}→ 409 CONFLICT
POST /api/payments/snapshot/transaction/{sess}/dev-mark-paid (no env) → 403 FORBIDDEN
```

## Namespace discipline (cross-system summary)

The frontend now mirrors the backend's separation cleanly:

```
notifications:
  audit truth       ≠ lifecycle truth        ≠ suppression truth
  (customer-notify)   (notifications/projector)  (Postmark bounces)

payments:
  pricing truth     ≠ payment truth          ≠ provider checkout truth
  (car_requests.    (payment_transactions.    (provider workspace —
   pricing snapshot) pricingSnapshot copy)     reads provider-share
                                                line from snapshot)
```

The Pay button consumes pricing truth, opens a Stripe-owned page, and
hands off the session_id back to payment-success — which reads the
*payment* truth (transaction). The two never merge into a single
calculator.

## Ready for next round

- **Payments-2B** — Stripe webhook → update payment_transactions
  status by `metadata.internalSessionId`. New invariant:

      Stripe webhook may update payment status,
      but may never update pricingSnapshot.
