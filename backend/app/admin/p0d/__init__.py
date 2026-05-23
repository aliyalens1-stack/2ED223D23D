"""P0.d — Admin money/moderation surface.

Three subdomains share one append-only audit collection (`money_audit`):

  payouts   — approve / hold / process    (+ state-machine with `failed` terminal)
  payments  — refund   / retry            (escrow service_payments)
  reviews   — flag     / restore / exclude-rating

Critical invariant (the P0.d acceptance test):

    Released, paid, and refunded history cannot be silently rewritten.

Guards:
  * paid + failed are TERMINAL — admin actions reject mutation
  * released + refunded payments cannot be re-refunded/re-retried
  * Each mutating action writes one row to `money_audit` BEFORE returning
  * Each mutating action mirrors `actorId/at` onto the entity (immutable)
"""
from .audit import write_money_audit, ensure_indexes  # noqa: F401
from .router import router  # noqa: F401

__all__ = ["router", "write_money_audit", "ensure_indexes"]
