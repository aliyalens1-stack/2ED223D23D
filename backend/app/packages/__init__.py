"""app.packages — Sprint 3 CORE monetization (credits-based inspection economy).

Collections:
- inspection_packages (static catalog: 1 / 3 / 5 inspections)
- inspection_credits (per-user: balance / reserved / used)
- inspection_credit_ledger (every delta — MUST be immutable)
- package_payments (pending / paid / failed — Stripe + PayPal mock)

Principles:
- All money flows through platform (never directly to inspector).
- Ledger is append-only. Any balance change leaves a trace.
- reserve-on-create-request, consume-on-job-complete, release-on-cancel.
"""
