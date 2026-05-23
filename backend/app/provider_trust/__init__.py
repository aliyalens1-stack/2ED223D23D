"""Sprint 5 — Trust & Retention Layer.

Bounded context: provider reputation aggregates built from mutual
post-escrow reviews (customer↔provider) with blind reveal.

Public modules:
    engine     — pure recompute logic over provider_reviews
    router     — HTTP surface (submit / reveal / list / aggregate)
    badges     — derive badges from aggregate
    reveal     — sweep job (timeout-based reveal)
"""
