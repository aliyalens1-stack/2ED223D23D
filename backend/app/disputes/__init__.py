"""Sprint 6 — Disputes & Resolution Layer.

Bounded context: dispute lifecycle from open → admin review → resolution.

Scope (P1):
    - User opens dispute (only when escrow is locked but not yet released)
    - request.status + payment.status freeze to 'disputed'
    - Timeline event 'dispute_opened' in service_chat (chat freeze marker)
    - Admin can resolve via 3 actions: release_to_provider | partial_refund | full_refund
    - Reputation impact ONLY on resolved outcomes (not on open) — anti-abuse

OUT of scope (deferred):
    - Evidence uploads (media)
    - AI moderation / NLP triage
    - Legal workflows / chargeback engines
    - External mediators

Storage:
    disputes — one doc per opened dispute, immutable history via resolvedAt + resolverId
"""
