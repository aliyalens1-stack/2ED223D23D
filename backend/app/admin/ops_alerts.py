"""Sprint 8 — Admin Operational Alerts.

Provides a single endpoint with a compact operational health snapshot.
NOT a SOC dashboard. NOT alertmanager. Just enough signal for a small
ops team to triage manually:

    - high_dispute_providers   — providers with disputes_lost > 3 in 30d
    - frozen_providers          — Stripe-frozen accounts
    - platform_frozen           — global escrow freeze status
    - stuck_escrow              — service_payments in 'paid' > 24h
    - failed_webhooks           — stripe_webhook_events errors in 24h
    - pending_disputes          — open + in_review counts

Endpoint:
    GET /api/admin/ops/alerts
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List

from fastapi import APIRouter, Depends

from app.core.db import get_db
from app.core.security import verify_admin_token

logger = logging.getLogger(__name__)
router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


@router.get("/api/admin/ops/alerts")
async def operational_alerts(_: dict = Depends(verify_admin_token)) -> Dict[str, Any]:
    db = get_db()
    now = _now()
    cutoff_24h = (now - timedelta(hours=24)).isoformat()
    cutoff_30d = (now - timedelta(days=30)).isoformat()

    # 1. High-dispute providers (lost disputes ≥3 in last 30d).
    pipeline = [
        {"$match": {
            "status": "resolved",
            "resolution": {"$in": ["full_refund", "partial_refund"]},
            "resolvedAt": {"$gte": cutoff_30d},
        }},
        {"$group": {"_id": "$providerId", "lost": {"$sum": 1}}},
        {"$match": {"lost": {"$gte": 3}}},
        {"$sort": {"lost": -1}},
        {"$limit": 50},
    ]
    high_dispute: List[Dict[str, Any]] = []
    async for row in db.disputes.aggregate(pipeline):
        high_dispute.append({"providerId": row["_id"], "lostDisputes30d": row["lost"]})

    # 2. Frozen providers.
    frozen_cursor = db.users.find(
        {"stripeFrozen": True},
        {"_id": 1, "stripeAccountId": 1, "stripeFrozenReason": 1, "stripeFrozenAt": 1, "email": 1},
    ).limit(50)
    frozen_providers: List[Dict[str, Any]] = []
    async for u in frozen_cursor:
        frozen_providers.append({
            "providerId": str(u.get("_id")),
            "stripeAccountId": u.get("stripeAccountId"),
            "reason": u.get("stripeFrozenReason"),
            "frozenAt": u.get("stripeFrozenAt"),
            "email": u.get("email"),
        })

    # 3. Platform-wide freeze.
    settings = await db.platform_settings.find_one({"type": "payments"}, {"_id": 0}) or {}
    platform_frozen = bool(settings.get("frozen"))

    # 4. Stuck escrow — paid but no release for >24h.
    stuck_cursor = db.service_payments.find(
        {"status": "paid", "createdAt": {"$lte": cutoff_24h}},
        {"_id": 0, "id": 1, "requestId": 1, "customerId": 1, "providerId": 1,
         "amount": 1, "createdAt": 1, "completedAt": 1},
    ).sort("createdAt", 1).limit(20)
    stuck_escrow = await stuck_cursor.to_list(length=20)

    stuck_total = await db.service_payments.count_documents({
        "status": "paid", "createdAt": {"$lte": cutoff_24h},
    })

    # 5. Failed webhooks (sandbox=False AND any error markers in last 24h).
    failed_webhooks: List[Dict[str, Any]] = []
    try:
        async for ev in db.stripe_webhook_events.find(
            {"receivedAt": {"$gte": cutoff_24h}, "error": {"$exists": True}},
            {"_id": 1, "type": 1, "receivedAt": 1, "error": 1},
        ).limit(20):
            failed_webhooks.append({
                "eventId": str(ev.get("_id")),
                "type": ev.get("type"),
                "receivedAt": ev.get("receivedAt"),
                "error": ev.get("error"),
            })
    except Exception:
        pass

    # 6. Pending dispute counts.
    open_disputes = await db.disputes.count_documents({"status": "open"})
    in_review_disputes = await db.disputes.count_documents({"status": "in_review"})

    return {
        "generatedAt": now.isoformat(),
        "highDisputeProviders": high_dispute,
        "frozenProviders": frozen_providers,
        "platformFrozen": platform_frozen,
        "platformFrozenReason": settings.get("frozenReason"),
        "stuckEscrow": {"count": stuck_total, "sample": stuck_escrow},
        "failedWebhooks24h": failed_webhooks,
        "disputeQueue": {"open": open_disputes, "inReview": in_review_disputes},
        # Severity heuristic — drives admin UI badge.
        "severity": (
            "critical"
            if platform_frozen or stuck_total > 5
            else "warning"
            if (high_dispute or len(frozen_providers) > 0 or open_disputes > 0)
            else "ok"
        ),
    }
