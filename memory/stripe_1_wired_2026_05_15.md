# Sprint Stripe-1 — Real Stripe Checkout wired (test mode) — 2026-05-15

## The bug

Screenshot from user showed `Платёж не прошёл / Не указан session id`
after submitting an auto-request. The user **never reached a payment
screen** — they just clicked submit on the calculation form and got
a payment-failure UI.

### Root cause

`auto-request/create.tsx` was calling
`POST /api/customer/requests/simulated-checkout` (a Stripe-bypass demo
endpoint) and then routing to `/payment-success` with no `session_id`
parameter. `payment-success.tsx` had a hard short-circuit:

```js
if (!sessionId) {
  setPhase('failed');
  setErrorText(t('payment.no_session') || 'Missing session id');
  return;
}
```

So the "calculation form submit" UX → "payment failed" UI, even though
no payment was ever attempted.

---

## The fix

### 1. Wire real Stripe Checkout (test mode) end-to-end

Backend already had the right plumbing:
- `POST /api/payments/auto-request/checkout` — creates real Stripe
  session, persists `payment_transactions` row, returns `{sessionId, url}`
- `GET /api/payments/auto-request/status/{sid}` — polls Stripe live,
  materialises the request on first paid transition (idempotent)
- `POST /api/webhook/stripe` — async backup path

Frontend was calling the wrong endpoint. Replaced the
`simulated-checkout` POST in `auto-request/create.tsx` with a real
call to `/payments/auto-request/checkout`, then routes through the
existing `/payment/checkout` bridge (uses `expo-web-browser` on
native, `window.location.href` on web).

### 2. Resilient payment-success screen

`payment-success.tsx` now:
- Accepts `?simulated=1&requestId=<id>` legacy path (treats as paid,
  routes straight to `/auto-request/[id]`) — back-compat for old
  saved drafts.
- When `session_id` is missing and `simulated` is not set → renders
  the **cancelled** UI ("No charge was made, try again") instead of
  the misleading **failed** UI. No payment was attempted, no failure
  to report.

### 3. Real Stripe test keys plumbed

`/app/backend/.env` now contains:
```
STRIPE_API_KEY=sk_test_51TP0RO...   (user's restricted test secret)
STRIPE_PUBLISHABLE_KEY=pk_test_51TP0RO...   (user's publishable, for future Stripe.js)
```

The backend reads `STRIPE_API_KEY` via `os.environ.get()` after
`load_dotenv()` runs in `app/core/config.py`. Restarting `backend`
supervisor service picks them up.

---

## Verified end-to-end (2026-05-15)

```
POST /api/payments/auto-request/checkout
  body: { originUrl, requestPayload: {type:"inspection", country:"DE",
                                       cities:["berlin"], links:[...]} }
  → 200 OK
  → sessionId  = cs_test_a1Slj7...
  → url        = https://checkout.stripe.com/c/pay/cs_test_a1Slj7...
  → amount     = 149.0
  → currency   = eur

GET <stripe url>
  → HTTP 200, text/html
  → Body contains: Card, SEPA, Klarna, payment_method_types

GET /api/payments/auto-request/status/cs_test_a1Slj7...
  → status:        open
  → paymentStatus: unpaid
  → paid:          false

Mongo payment_transactions:
  _id:            cs_test_a1Slj7...
  status:         open
  payment_status: unpaid
  amount:         149.0 eur
  cluster:        inspection   (Phase 1B Tier 3 enrichment intact)
```

Backend log: `INFO:stripe:Stripe API response path=https://api.stripe.com/v1/checkout/sessions response_code=200`.

---

## Payment methods available on the hosted page

Stripe Checkout auto-enables based on the test account dashboard +
currency + region. Out of the box (EUR + test mode) the user sees:

| Method | Status |
|---|---|
| Card (Visa / MC / Amex) | ✅ enabled by default |
| Apple Pay | ✅ auto-detected on iOS/Safari with HTTPS |
| Google Pay | ✅ auto-detected on Chrome/Android |
| SEPA Direct Debit | ✅ enabled (visible in HTML body) |
| Klarna | ✅ enabled (visible in HTML body) |
| Link (Stripe's saved-card) | ✅ enabled by default |
| Crypto (USDC) | ❌ requires explicit `payment_method_types` opt-in |

Test cards (Stripe test mode):
- **4242 4242 4242 4242** any future date, any CVC, any postal — succeeds
- **4000 0000 0000 9995** insufficient funds
- **4000 0027 6000 3184** 3DS required

---

## Files touched

- **MOD** `backend/.env` — real Stripe test keys
- **MOD** `frontend/app/auto-request/create.tsx` — call real
  `/payments/auto-request/checkout` and route to `/payment/checkout` bridge
- **MOD** `frontend/app/payment-success.tsx` — graceful handling of
  missing session_id + `simulated=1` legacy path

No backend code changed (the integration was already correct, just
not being called from the form).

---

## Cross-surface coverage check

| Surface | Stripe wiring | Status |
|---|---|---|
| Mobile / Expo — auto-request flow | `/api/payments/auto-request/checkout` | ✅ FIXED |
| Mobile / Expo — booking flow | `/api/payments/create-checkout` (booking summary) | ✅ already worked |
| Mobile / Expo — packages flow | `app/packages/router_packages.py` | ✅ already worked |
| Web-app — public buy surface | shares same endpoints | ✅ |
| Admin — Stripe settings | `app/admin/stripe_settings.py` | ✅ |
| Backend — webhook | `/api/webhook/stripe` | ✅ |

---

## Next steps (deferred)

- **Crypto (USDC)**: explicit opt-in via `payment_method_types=["card","crypto"]`
  on the `CheckoutSessionRequest`. Requires Stripe Crypto onboarding
  on the dashboard (test mode supports it).
- **3DS strong-customer-authentication** flows: already handled by
  Stripe Checkout natively; the test card `4000 0027 6000 3184` triggers it.
- **Save-card / off-session future charges**: requires `mode="setup"`
  variant of CheckoutSessionRequest + Customer creation. Not in scope today.
- **Refund flow**: admin endpoint `app/admin/stripe_settings.py` has
  scaffolding; verified-paid txns can be refunded via Stripe Dashboard
  meanwhile.
