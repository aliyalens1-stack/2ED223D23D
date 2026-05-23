"""app.payments.chronology — Sprint P0.b.C.f.

Payment chronology substrate. NEW SPECIES — independent of:
  - money_audit (admin governance evidence)
  - stripe_webhook_events (provider evidence)
  - booking_timeline (operational booking chronology)

DO NOT import booking-timeline writer/reducer/dedup from this package.
DO NOT project from money_audit or stripe_webhook_events.

Public surface:
  - writer.append_payment_event(...)   — only way to add a row
  - writer.KINDS                       — frozen set of 19 literals
  - writer.ensure_indexes(db)          — startup hook

NO reducer, NO state-machine, NO ChronologyEngine. Explicit literals only.
"""
