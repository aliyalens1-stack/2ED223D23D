"""app.integrations — admin-configurable third-party credential store.

Phase 4 Sprint A: real production-ready integration layer where ALL
provider credentials (Stripe, PayPal, Firebase, Postmark, etc.) live
in a Mongo collection and are editable through admin endpoints — no
.env redeploy required.

Public surface:
  • credentials_service.get(provider)         — returns active credentials dict (decrypted)
  • credentials_service.upsert(provider, data) — encrypt + save + invalidate cache
  • credentials_service.list_summaries()      — masked summary list for admin UI
  • credentials_service.set_enabled(...)
  • credentials_service.test(provider)        — provider-specific live test
  • router_admin_integrations                  — /api/admin/integrations/* CRUD
  • stripe_service                             — credentials-aware Stripe ops
  • router_stripe                              — /api/payments/stripe/* + /api/webhooks/stripe
"""
