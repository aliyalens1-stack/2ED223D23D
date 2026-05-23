"""Sprint 3 Step 3 — Reputation Engine (durable trust layer).

Architectural contract:
    timeline_events + reports + disputes + overrides + verification
        →  reputation aggregates
        →  inspector trust profile

Reputation is a **deterministic projection** over operational events.
Pure read + idempotent write. No random factors. No hidden constants —
every weight and threshold is a named constant in this file.

Public API:
    recompute_reputation(user_id)       → ReputationSnapshot dict
    recompute_for_event(event)          → triggered by timeline append
    ensure_indexes(db)                  → idempotent

Storage:
    users.reputation                    — current snapshot (1 doc per user)
    reputation_snapshots                — append-only history
                                          {userId, snapshot, computedAt, delta, reason}

Invariants:
    - Same inputs → same score (no time-of-day bias, no random tiebreak)
    - All factors explainable (each sub-metric has a numerator/denominator)
    - No irreversible penalties (recompute always reads current state)
    - No hidden floor: hardFloor is computed from open disputes only and
      `hardFloor` + `hardFloorReason` are part of the public snapshot
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from app.core.db import get_db

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Named constants — single source of truth for tuning.
# Every weight / threshold MUST live here. No magic numbers downstream.
# ─────────────────────────────────────────────────────────────────────

# Tier thresholds (inclusive lower bounds).
TIER_BRONZE_MAX = 39
TIER_SILVER_MAX = 64
TIER_GOLD_MAX = 84
# Anything >= 85 → platinum.

# Equal weights for V1 — every sub-metric contributes 1/7 to the final score.
SUB_METRIC_KEYS = (
    "inspectionQuality",
    "evidenceCompleteness",
    "customerAcceptance",
    "disputeRate",
    "aiAlignment",
    "responseDiscipline",
    "verificationScore",
)

# Neutral default for sub-metrics when data is too sparse to compute.
# Rationale: a brand-new inspector should not start at 0 (would freeze
# their tier at bronze on day one with no operational evidence). 100 is
# the neutral starting point; the first negative event will move it.
SPARSE_DEFAULT = 100

# Hard-floor cap. If active (open dispute, fraud freeze), tier cannot
# exceed silver regardless of computed score.
HARD_FLOOR_TIER_MAX = "silver"


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_indexes(db) -> None:
    """Idempotent."""
    try:
        await db.reputation_snapshots.create_index(
            [("userId", 1), ("computedAt", -1)], background=True
        )
        await db.reputation_snapshots.create_index(
            [("tier", 1), ("computedAt", -1)], background=True
        )
        await db.users.create_index(
            [("reputation.score", -1)],
            background=True,
            partialFilterExpression={"reputation": {"$exists": True}},
        )
        await db.users.create_index(
            [("reputation.tier", 1)],
            background=True,
            partialFilterExpression={"reputation": {"$exists": True}},
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"Sprint 3 Step 3: ensure_indexes (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Pure helpers — testable without DB.
# ─────────────────────────────────────────────────────────────────────

def _ratio(numerator: int, denominator: int) -> int:
    """Return 0..100 ratio. Returns SPARSE_DEFAULT when denominator is 0.

    Used for "good-when-high" sub-metrics (inspectionQuality, accept rate).
    """
    if denominator <= 0:
        return SPARSE_DEFAULT
    return max(0, min(100, round(100 * numerator / denominator)))


def _inverse_ratio(bad: int, total: int) -> int:
    """Return 0..100 where higher = less bad.
    Returns SPARSE_DEFAULT when total is 0.
    """
    if total <= 0:
        return SPARSE_DEFAULT
    return max(0, min(100, 100 - round(100 * bad / total)))


def tier_for_score(score: int) -> str:
    """Pure function — same score always → same tier."""
    if score <= TIER_BRONZE_MAX:
        return "bronze"
    if score <= TIER_SILVER_MAX:
        return "silver"
    if score <= TIER_GOLD_MAX:
        return "gold"
    return "platinum"


def cap_tier(tier: str, max_tier: str) -> str:
    """Cap tier at max_tier — used for hard-floor enforcement."""
    order = ["bronze", "silver", "gold", "platinum"]
    if tier not in order or max_tier not in order:
        return tier
    return tier if order.index(tier) <= order.index(max_tier) else max_tier


def compute_score(sub_metrics: Dict[str, int]) -> int:
    """Equal-weight arithmetic mean over SUB_METRIC_KEYS."""
    values = [int(sub_metrics.get(k, SPARSE_DEFAULT)) for k in SUB_METRIC_KEYS]
    if not values:
        return SPARSE_DEFAULT
    return max(0, min(100, round(sum(values) / len(values))))


# ─────────────────────────────────────────────────────────────────────
# DB readers — each input source is a small async function so the engine
# stays readable and each can be mocked individually in tests.
# ─────────────────────────────────────────────────────────────────────

async def _read_report_lifecycle(db, user_id: str) -> Dict[str, int]:
    """Counts from timeline_events for this inspector."""
    pipeline = [
        {"$match": {"inspectorId": user_id, "kind": {"$in": [
            "report_submitted", "report_approved", "report_rejected",
            "customer_accepted", "customer_disputed",
        ]}}},
        {"$group": {"_id": "$kind", "n": {"$sum": 1}}},
    ]
    out = {
        "submitted": 0, "approved": 0, "rejected": 0,
        "accepted": 0, "disputed": 0,
    }
    try:
        async for row in db.timeline_events.aggregate(pipeline):
            k = row["_id"]
            n = int(row.get("n", 0))
            if k == "report_submitted":  out["submitted"] = n
            elif k == "report_approved": out["approved"] = n
            elif k == "report_rejected": out["rejected"] = n
            elif k == "customer_accepted": out["accepted"] = n
            elif k == "customer_disputed": out["disputed"] = n
    except Exception:
        logger.exception("reputation: report lifecycle read failed")
    return out


async def _read_ai_alignment(db, user_id: str) -> Dict[str, int]:
    """drafts vs overrides for this inspector.

    Each draft maps 1:1 to a job. Each override row in `ai_overrides_log`
    is one human change to one AI field. We treat raw count of overrides
    relative to drafts as alignment signal.
    """
    out = {"drafts": 0, "overrides": 0}
    try:
        out["drafts"] = await db.inspection_drafts.count_documents(
            {"inspectorId": user_id}
        )
    except Exception:
        pass
    try:
        # ai_overrides_log keys by jobId — resolve via inspection_jobs.
        job_ids = []
        async for j in db.inspection_jobs.find(
            {"inspectorId": user_id}, {"_id": 1}
        ):
            job_ids.append(j["_id"])
        if job_ids:
            out["overrides"] = await db.ai_overrides_log.count_documents(
                {"jobId": {"$in": job_ids}}
            )
    except Exception:
        logger.exception("reputation: ai overrides read failed")
    return out


async def _read_evidence_completeness(db, user_id: str) -> Dict[str, int]:
    """How many of this inspector's drafts had missing-evidence flags."""
    out = {"drafts": 0, "drafts_with_missing": 0}
    try:
        out["drafts"] = await db.inspection_drafts.count_documents(
            {"inspectorId": user_id}
        )
        out["drafts_with_missing"] = await db.inspection_drafts.count_documents(
            {"inspectorId": user_id, "missingEvidence.0": {"$exists": True}}
        )
    except Exception:
        logger.exception("reputation: evidence read failed")
    return out


async def _read_response_discipline(db, user_id: str) -> Dict[str, int]:
    """jobs assigned vs jobs cleanly completed.

    "clean" = status=='done' AND no no-show / abandonment flag.
    """
    out = {"assigned": 0, "clean": 0}
    try:
        out["assigned"] = await db.inspection_jobs.count_documents(
            {"inspectorId": user_id}
        )
        out["clean"] = await db.inspection_jobs.count_documents({
            "inspectorId": user_id,
            "status": "done",
            "noShow": {"$ne": True},
            "abandoned": {"$ne": True},
        })
    except Exception:
        logger.exception("reputation: lifecycle read failed")
    return out


async def _read_verification_score(db, user_id: str) -> Dict[str, int]:
    """Inspector documents — approved / total."""
    out = {"approved": 0, "total": 0}
    try:
        out["total"] = await db.inspector_verifications.count_documents(
            {"userId": user_id}
        )
        out["approved"] = await db.inspector_verifications.count_documents(
            {"userId": user_id, "status": "approved"}
        )
    except Exception:
        logger.exception("reputation: verification read failed")
    return out


async def _has_open_dispute(db, user_id: str) -> bool:
    """Hard-floor signal: any customer_disputed event without a later
    customer_accepted on the same reportId is treated as open.
    """
    try:
        disputed = []
        async for ev in db.timeline_events.find(
            {"inspectorId": user_id, "kind": "customer_disputed"},
            {"reportId": 1, "timestamp": 1, "_id": 0},
        ):
            disputed.append(ev)
        for d in disputed:
            rid = d.get("reportId")
            if not rid:
                # Conservative: an un-keyed dispute counts as open.
                return True
            later_accept = await db.timeline_events.find_one({
                "inspectorId": user_id,
                "kind": "customer_accepted",
                "reportId": rid,
                "timestamp": {"$gt": d.get("timestamp", "")},
            })
            if not later_accept:
                return True
    except Exception:
        logger.exception("reputation: hard-floor read failed")
    return False


# ─────────────────────────────────────────────────────────────────────
# Public: recompute_reputation
# ─────────────────────────────────────────────────────────────────────

async def recompute_reputation(user_id: str) -> Optional[Dict[str, Any]]:
    """Pure read of all inputs → write users.reputation + append snapshot.

    Returns the new snapshot dict on success, None on failure.
    """
    if not user_id:
        return None
    db = get_db()

    # 1. Gather raw inputs.
    rep_lifecycle = await _read_report_lifecycle(db, user_id)
    ai = await _read_ai_alignment(db, user_id)
    ev = await _read_evidence_completeness(db, user_id)
    rd = await _read_response_discipline(db, user_id)
    vs = await _read_verification_score(db, user_id)
    hard_floor = await _has_open_dispute(db, user_id)

    # 2. Compute sub-metrics (each is a pure function of the counts).
    inspection_quality = _ratio(rep_lifecycle["approved"], rep_lifecycle["submitted"])
    customer_acceptance = _ratio(
        rep_lifecycle["accepted"],
        rep_lifecycle["accepted"] + rep_lifecycle["disputed"],
    )
    dispute_rate = _inverse_ratio(
        rep_lifecycle["disputed"],
        rep_lifecycle["accepted"] + rep_lifecycle["disputed"],
    )
    ai_alignment = _inverse_ratio(ai["overrides"], ai["drafts"])
    evidence_completeness = _inverse_ratio(ev["drafts_with_missing"], ev["drafts"])
    response_discipline = _ratio(rd["clean"], rd["assigned"])
    verification_score = _ratio(vs["approved"], vs["total"])

    sub = {
        "inspectionQuality": inspection_quality,
        "evidenceCompleteness": evidence_completeness,
        "customerAcceptance": customer_acceptance,
        "disputeRate": dispute_rate,
        "aiAlignment": ai_alignment,
        "responseDiscipline": response_discipline,
        "verificationScore": verification_score,
    }
    score = compute_score(sub)

    # 3. Tiering with hard-floor cap.
    raw_tier = tier_for_score(score)
    tier = cap_tier(raw_tier, HARD_FLOOR_TIER_MAX) if hard_floor else raw_tier
    hard_floor_reason = "open_dispute" if hard_floor else None

    now_iso = datetime.now(timezone.utc).isoformat()
    snapshot = {
        "score": score,
        "tier": tier,
        "rawTier": raw_tier,
        "hardFloor": hard_floor,
        "hardFloorReason": hard_floor_reason,
        "updatedAt": now_iso,
        "computedAt": now_iso,
        **sub,
        "inputs": {
            "reportLifecycle": rep_lifecycle,
            "aiAlignment": ai,
            "evidence": ev,
            "responseDiscipline": rd,
            "verification": vs,
        },
    }

    # 4. Read previous snapshot to detect tier change for timeline write.
    prev_tier: Optional[str] = None
    try:
        u = await db.users.find_one(
            {"_id": user_id}, {"reputation.tier": 1, "_id": 0}
        )
        if u and isinstance(u.get("reputation"), dict):
            prev_tier = u["reputation"].get("tier")
    except Exception:
        pass

    # 5. Persist current snapshot on users.* (idempotent overwrite).
    try:
        await db.users.update_one(
            {"_id": user_id},
            {"$set": {"reputation": snapshot}},
        )
    except Exception:
        logger.exception("reputation: users update failed")

    # 6. Append-only history row.
    delta_tier = None
    if prev_tier and prev_tier != tier:
        delta_tier = {"from": prev_tier, "to": tier}
    try:
        await db.reputation_snapshots.insert_one({
            "userId": user_id,
            "score": score,
            "tier": tier,
            "computedAt": now_iso,
            "hardFloor": hard_floor,
            "hardFloorReason": hard_floor_reason,
            "subMetrics": sub,
            "tierChange": delta_tier,
        })
    except Exception:
        logger.exception("reputation: snapshot insert failed")

    # 7. Emit timeline event on tier change OR hard-floor activation.
    try:
        from app.inspector.timeline import append_event
        if delta_tier:
            order = ["bronze", "silver", "gold", "platinum"]
            promoted = order.index(tier) > order.index(prev_tier)
            kind = "reputation_promoted" if promoted else "reputation_dropped"
            await append_event(
                kind=kind,
                inspector_id=user_id,
                actor_type="system",
                actor_label="reputation engine",
                severity="success" if promoted else "warning",
                title=("Рейтинг повышен" if promoted else "Рейтинг понижен"),
                text=f"{prev_tier} → {tier} (score {score})",
                metadata={
                    "prevTier": prev_tier, "newTier": tier,
                    "score": score, "subMetrics": sub,
                },
                stable_key=f"{user_id}_{now_iso}",
            )
        if hard_floor and not (prev_tier == HARD_FLOOR_TIER_MAX and tier == HARD_FLOOR_TIER_MAX):
            await append_event(
                kind="reputation_flagged",
                inspector_id=user_id,
                actor_type="system",
                actor_label="reputation engine",
                severity="warning",
                title="Hard floor: open dispute",
                text=f"Tier capped at {HARD_FLOOR_TIER_MAX} until disputes resolve.",
                metadata={
                    "reason": hard_floor_reason, "rawTier": raw_tier, "tier": tier,
                },
                stable_key=f"{user_id}_floor_{now_iso}",
            )
    except Exception:
        logger.exception("reputation: timeline emit failed")

    return snapshot


# ─────────────────────────────────────────────────────────────────────
# Event-driven hook — called from inspector/timeline.append_event for
# kinds that move reputation. Best-effort; never bubbles errors.
# ─────────────────────────────────────────────────────────────────────

REPUTATION_TRIGGER_KINDS = {
    "report_submitted",
    "report_approved",
    "report_rejected",
    "customer_accepted",
    "customer_disputed",
    "verification_approved",
    "verification_rejected",
}


async def recompute_for_event(event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Best-effort projection trigger. Resolves inspectorId, recomputes."""
    kind = event.get("kind")
    if kind not in REPUTATION_TRIGGER_KINDS:
        return None
    inspector_id = event.get("inspectorId")
    if not inspector_id:
        return None
    try:
        return await recompute_reputation(str(inspector_id))
    except Exception:
        logger.exception("reputation: recompute_for_event failed")
        return None


__all__ = [
    "recompute_reputation",
    "recompute_for_event",
    "ensure_indexes",
    "tier_for_score",
    "cap_tier",
    "compute_score",
    "SUB_METRIC_KEYS",
    "TIER_BRONZE_MAX",
    "TIER_SILVER_MAX",
    "TIER_GOLD_MAX",
    "HARD_FLOOR_TIER_MAX",
    "REPUTATION_TRIGGER_KINDS",
]
