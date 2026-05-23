"""Matching-v2 Sprint 2 — frozen dispatch snapshot persistence.

Companion to `app.matching_v2.policy`. While `policy.py` answers
"what policy SHOULD this job get?", this module answers
"what policy WAS frozen for this job?" — and that answer never moves.

Mongo collection: `matching_dispatch_snapshot`

Document shape (frozen at creation, immutable thereafter):

  {
    "jobId":              "job_123",          # primary key
    "matchingVersion":    "v2",
    "pricingVersion":     "v2",
    "effectiveDensity":   "low",
    "dispatchRadiusKm":   150,                # None for scarce
    "batchSize":          10,                 # 0 for scarce
    "ttlMinutes":         20,                 # None for scarce
    "policy":             "expanded",
    "pricingDigest":      "Berlin: 220 km · standard_remote · +€54",
    "pricingConfirmedAt": "2026-05-17T13:42:23.922021+00:00",
    "createdAt":          "2026-05-17T14:31:02.000000+00:00",
    "createdBy":          "<userId>",
    "status":             "projected"
  }

Invariants enforced here (Sprint 2 scope):

  • Idempotency      — same jobId returns identical doc forever.
  • Pricing bridge   — refuses to freeze unless the pricing projection
                       for this jobId has `status='confirmed'`. The
                       snapshot's density / digest / confirmedAt are
                       copied verbatim from that frozen pricing doc.
  • Recompute-free   — once frozen, NEVER re-derives density or policy
                       even if topology / provider counts shift later.

Not in scope (Sprint 3):
  • status transitions beyond `projected`
  • provider selection, batching execution, escalation, TTL timers
  • bids, notifications, queues
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from app.pricing.projection import get_projection as get_pricing_projection
from app.matching_v2.policy import (
    project_dispatch_policy,
    policy_to_dict,
)


# Public exception — translates to HTTP 409 in the router layer. We keep
# the policy/persistence boundary HTTP-agnostic for testability.
class PricingNotConfirmedError(Exception):
    """Pricing projection for this job is missing or not yet confirmed.

    Dispatch MUST NOT freeze on top of a pending preview — that would
    let the customer see one price and matching act on another.
    """

    code = "PRICING_NOT_CONFIRMED"

    def __init__(self, job_id: str, status: Optional[str]):
        self.job_id = job_id
        self.status = status
        super().__init__(
            f"job {job_id!r} pricing projection is "
            + ("missing" if status is None else f"in status {status!r}")
            + " — dispatch snapshot requires a confirmed pricing snapshot"
        )


MATCHING_VERSION_V2 = "v2"
DISPATCH_SNAPSHOT_STATUS_PROJECTED = "projected"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_dispatch_snapshot(db, *, job_id: str) -> Optional[Dict[str, Any]]:
    """Read-only fetch of the frozen snapshot for `job_id`. Returns None
    when no snapshot has been frozen yet.
    """
    return await db.matching_dispatch_snapshot.find_one(
        {"jobId": job_id},
        {"_id": 0},
    )


async def freeze_dispatch_snapshot(
    db,
    *,
    job_id: str,
    created_by: Optional[str] = None,
) -> Dict[str, Any]:
    """Idempotent freeze. Reads confirmed pricing, projects policy,
    persists the result. Re-running with the same `job_id` returns the
    existing snapshot byte-identical.

    Raises:
      PricingNotConfirmedError — when the pricing projection is missing
        or `status != 'confirmed'`. Dispatch must never be derived from a
        pending preview.

    Why we copy `pricingDigest` and `pricingConfirmedAt`:
      operators reading the dispatch row should see which economics
      decision produced this dispatch without doing a join. That's the
      operational-truth half of the customer-truth/operational-truth
      split.
    """
    # ── Idempotency check first — cheap path, return early ────────────
    existing = await get_dispatch_snapshot(db, job_id=job_id)
    if existing is not None:
        return existing

    # ── Load and validate the pricing projection ──────────────────────
    pricing = await get_pricing_projection(db, job_id=job_id)
    if pricing is None or pricing.get("status") != "confirmed":
        raise PricingNotConfirmedError(
            job_id=job_id,
            status=pricing.get("status") if pricing else None,
        )

    # The pricing projection v2 always carries `densitySnapshot`. v1
    # snapshots have no density signal — they cannot be dispatched
    # through matching-v2. Refusing here preserves the
    # "matching never guesses density" invariant.
    if not isinstance(pricing.get("densitySnapshot"), dict):
        raise PricingNotConfirmedError(job_id=job_id, status="missing-density")

    # ── Project policy from frozen pricing ────────────────────────────
    policy = project_dispatch_policy(pricing)
    policy_dict = policy_to_dict(policy)

    # ── Compose snapshot doc — fields below are the LOCKED contract ───
    snapshot: Dict[str, Any] = {
        "jobId": job_id,
        "matchingVersion": MATCHING_VERSION_V2,
        "pricingVersion": pricing.get("pricingVersion", "v2"),
        # Frozen policy fields (copied from policy projection).
        "effectiveDensity": policy_dict["effectiveDensity"],
        "dispatchRadiusKm": policy_dict["dispatchRadiusKm"],
        "batchSize": policy_dict["batchSize"],
        "ttlMinutes": policy_dict["ttlMinutes"],
        "policy": policy_dict["policy"],
        # Economics bridge — operators see WHICH pricing produced this.
        "pricingDigest": pricing.get("digest", ""),
        "pricingConfirmedAt": pricing.get("confirmedAt"),
        # Provenance.
        "createdAt": _now_iso(),
        "createdBy": created_by,
        "status": DISPATCH_SNAPSHOT_STATUS_PROJECTED,
    }

    # ── Persist with a "first-writer-wins" guard to keep idempotency
    #    robust under concurrent calls. Mongo's `upsert=True` with a
    #    `$setOnInsert` document ensures the first inserter wins and
    #    subsequent inserts read back the original doc.
    await db.matching_dispatch_snapshot.update_one(
        {"jobId": job_id},
        {"$setOnInsert": snapshot},
        upsert=True,
    )
    # Re-read so concurrent callers get whichever doc actually landed.
    frozen = await get_dispatch_snapshot(db, job_id=job_id)
    # Defensive — the upsert above guarantees a doc exists.
    assert frozen is not None
    return frozen


async def ensure_dispatch_indexes(db) -> None:
    """Idempotent index creation. Called once at startup if needed.
    Sprint 2 keeps it optional — listed for completeness so Sprint 3
    can wire it into the bootstrap path."""
    await db.matching_dispatch_snapshot.create_index("jobId", unique=True)


__all__ = [
    "PricingNotConfirmedError",
    "MATCHING_VERSION_V2",
    "DISPATCH_SNAPSHOT_STATUS_PROJECTED",
    "freeze_dispatch_snapshot",
    "get_dispatch_snapshot",
    "ensure_dispatch_indexes",
]
