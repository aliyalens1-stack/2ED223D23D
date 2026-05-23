"""app.admin.dashboard — Sprint 21 C12A.

Admin observability endpoints (3):
  GET /api/admin/live-feed              — governance + orchestrator event feed
  GET /api/admin/alerts                 — plain alerts (failsafe incidents + critical zones)
  GET /api/admin/alerts/enhanced        — alerts with business impact + recommended action

Логика 1-в-1 из server.py. Зависимости, живущие пока в server.py
(`_AVG_ORDER_VALUE`, `_recommend_action`) — через локальный import внутри
функции (безопасно: server.py уже полностью загружен на момент HTTP-запроса).
"""
from __future__ import annotations
from datetime import timedelta

from fastapi import APIRouter, Depends, Request

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc, uid


router = APIRouter()


# ── business-impact constants (were in server.py, moved here in C13) ──
_AVG_ORDER_VALUE = 800  # ₴ mean booking value used for impact math


def _recommend_action(zone: dict) -> str:
    status = zone.get("status")
    ratio = zone.get("ratio", 1.0)
    if status == "CRITICAL":
        return "FORCE_SURGE + raise fanout to 6"
    if status == "SURGE" and ratio > 2.5:
        return "ENABLE_SURGE"
    if status == "BUSY":
        return "INCREASE_FANOUT"
    return "MONITOR"


@router.get("/api/admin/live-feed")
async def compat_admin_live_feed(request: Request, _=Depends(verify_admin_token)):
    limit = int(request.query_params.get("limit", 50))
    events = []
    govs = await db.governance_actions.find({}, {"_id": 0}).sort("createdAt", -1).to_list(limit // 2)
    for g in govs:
        events.append({
            "id": g.get("id"),
            "type": g.get("type", "governance"),
            "category": "governance",
            "message": g.get("message") or g.get("type") or "governance action",
            "createdAt": g.get("createdAt"),
            "meta": g,
        })
    orch = await db.orchestrator_logs.find({}, {"_id": 0}).sort("createdAt", -1).to_list(limit // 2)
    for o in orch:
        events.append({
            "id": o.get("id") or uid(),
            "type": o.get("action", "orchestrator"),
            "category": "orchestrator",
            "message": f"Zone {o.get('zoneId','?')}: {o.get('action','action')}",
            "createdAt": o.get("createdAt"),
            "meta": o,
        })
    events.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return {"events": events[:limit], "total": len(events)}


@router.get("/api/admin/alerts")
async def compat_admin_alerts(request: Request, _=Depends(verify_admin_token)):
    alerts = []
    incidents = await db.failsafe_incidents.find({"status": "open"}, {"_id": 0}).sort("detectedAt", -1).to_list(50)
    for i in incidents:
        name = (i.get("ruleName") or "").lower()
        level = "critical" if "crisis" in name or "crash" in name else "warning"
        alerts.append({
            "id": i.get("id"),
            "level": level,
            "category": "failsafe",
            "title": i.get("ruleName", "Failsafe incident"),
            "message": f"{i.get('affectedEntityType')}/{i.get('affectedEntityId')} — {i.get('actionTaken')}",
            "createdAt": i.get("detectedAt"),
            "meta": i,
        })
    crit = await db.zones.find({"status": "CRITICAL"},
                                {"_id": 0, "id": 1, "name": 1, "ratio": 1,
                                 "demandScore": 1, "supplyScore": 1, "updatedAt": 1}).to_list(20)
    for z in crit:
        alerts.append({
            "id": f"zone-{z.get('id')}",
            "level": "critical",
            "category": "zone",
            "title": f"Zone {z.get('name')} is CRITICAL",
            "message": f"Demand {z.get('demandScore')} / Supply {z.get('supplyScore')} (ratio {z.get('ratio')})",
            "createdAt": z.get("updatedAt"),
            "meta": z,
        })
    alerts.sort(key=lambda x: x.get("createdAt") or "", reverse=True)
    return {"alerts": alerts, "total": len(alerts)}


@router.get("/api/admin/alerts/enhanced")
async def enhanced_admin_alerts(_=Depends(verify_admin_token)):
    """Sprint 9 — alerts annotated with business impact and recommended action."""
    # Lazy import убран — `_AVG_ORDER_VALUE` и `_recommend_action` теперь
    # живут в этом же модуле (перенесены в C13).

    alerts = []

    # Zone-based alerts (CRITICAL + SURGE)
    zones_bad = await db.zones.find(
        {"status": {"$in": ["SURGE", "CRITICAL"]}},
        {"_id": 0}
    ).to_list(50)
    for z in zones_bad:
        demand = z.get("demandScore", 0)
        supply = max(1, z.get("supplyScore", 1))
        conversion = max(0.1, min(0.95, supply / max(demand, 1)))
        match_rate = z.get("matchRate", int(conversion * 100))
        lost_per_hour = int(demand * _AVG_ORDER_VALUE * (1 - conversion))
        missed = max(0, int(demand - supply))
        alerts.append({
            "id": f"zone-{z.get('id')}",
            "level": "critical" if z.get("status") == "CRITICAL" else "warning",
            "category": "zone",
            "type": "CRITICAL_ZONE" if z.get("status") == "CRITICAL" else "SURGE_ZONE",
            "zone": z.get("name"),
            "zoneId": z.get("id"),
            "title": f"Zone {z.get('name')} — {z.get('status')}",
            "message": f"Ratio {z.get('ratio')}, demand {demand}, supply {supply}",
            "impact": {
                "lostRevenuePerHour": lost_per_hour,
                "missedBookings": missed,
                "matchRate": match_rate,
                "avgEta": z.get("avgEta"),
            },
            "recommendedAction": _recommend_action(z),
            "createdAt": z.get("updatedAt"),
        })

    # 5xx errors in last 5 min = money-loss signal
    cutoff5 = (now_utc() - timedelta(minutes=5)).isoformat()
    err_count = await db.system_logs.count_documents({
        "level": "error", "status": {"$gte": 500},
        "timestamp": {"$gte": cutoff5},
    })
    if err_count > 0:
        alerts.append({
            "id": "errors-5xx-5m",
            "level": "critical" if err_count > 3 else "warning",
            "category": "errors",
            "type": "BACKEND_ERROR_SPIKE",
            "title": f"{err_count} server errors in last 5 min",
            "message": "5xx responses from backend — potential GMV loss",
            "impact": {
                "lostRevenuePerHour": err_count * 12 * _AVG_ORDER_VALUE // 10,  # est 10% conversion hit
                "missedBookings": err_count // 3,
            },
            "recommendedAction": "INVESTIGATE_LOGS",
            "createdAt": now_utc().isoformat(),
        })

    # Failsafe incidents (pass-through)
    incidents = await db.failsafe_incidents.find({"status": "open"}, {"_id": 0}).sort("detectedAt", -1).to_list(20)
    for i in incidents:
        alerts.append({
            "id": i.get("id"),
            "level": "critical" if "crit" in (i.get("ruleName") or "").lower() else "warning",
            "category": "failsafe",
            "type": "FAILSAFE_INCIDENT",
            "title": i.get("ruleName", "Failsafe incident"),
            "message": f"{i.get('affectedEntityType')}/{i.get('affectedEntityId')}",
            "impact": {"missedBookings": 1},
            "recommendedAction": i.get("actionTaken") or "REVIEW",
            "createdAt": i.get("detectedAt"),
        })

    # Totals
    total_lost = sum(a.get("impact", {}).get("lostRevenuePerHour", 0) or 0 for a in alerts)
    total_missed = sum(a.get("impact", {}).get("missedBookings", 0) or 0 for a in alerts)

    alerts.sort(key=lambda x: (x.get("level") != "critical", -(x.get("impact", {}).get("lostRevenuePerHour", 0) or 0)))

    return {
        "alerts": alerts,
        "total": len(alerts),
        "summary": {
            "totalLostRevenuePerHour": total_lost,
            "totalMissedBookings": total_missed,
            "criticalCount": sum(1 for a in alerts if a["level"] == "critical"),
        },
    }
