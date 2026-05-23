"""app.system.system — debug/service endpoints под /api/system/*.

Sprint 21 C6: 7 endpoints вынесены из server.py (все admin-auth protected):
  - GET  /api/system/errors            (system_logs viewer)
  - GET  /api/system/errors/stats      (aggregated stats)
  - GET  /api/system/breaker           (NestJS proxy circuit breaker state)
  - GET  /api/system/alert-dispatches  (alert history)
  - POST /api/system/test-alert        (fire test alert)
  - GET  /api/system/idempotency/{key} (idempotency record)
  - GET  /api/system/audit             (audit log view)

Зависимости:
  - app.core.db.get_db()
  - app.core.security.verify_admin_token
  - prod_readiness.nest_breaker, dispatch_alert (внешний модуль backend/)
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.core.metrics import metrics
from prod_readiness import nest_breaker, dispatch_alert


router = APIRouter(prefix="/api/system")


@router.get("/errors")
async def system_errors(request: Request, _=Depends(verify_admin_token)):
    """Last error/warn entries from system_logs."""
    db = get_db()
    limit = int(request.query_params.get("limit", 100))
    level = request.query_params.get("level")
    q: dict = {}
    if level:
        q["level"] = level
    else:
        q["level"] = {"$in": ["error", "warn"]}
    route = request.query_params.get("route")
    if route:
        q["route"] = {"$regex": route, "$options": "i"}
    items = await db.system_logs.find(q, {"_id": 0}).sort("timestamp", -1).to_list(min(limit, 500))
    return {"items": items, "total": len(items)}


@router.get("/errors/stats")
async def system_errors_stats(_=Depends(verify_admin_token)):
    """Aggregated stats for admin dashboard."""
    db = get_db()
    now = datetime.now(timezone.utc)
    buckets = []
    for i in range(11, -1, -1):  # last 12 windows of 5 minutes
        start_iso = (now - timedelta(minutes=(i + 1) * 5)).isoformat()
        end_iso = (now - timedelta(minutes=i * 5)).isoformat()
        n = await db.system_logs.count_documents({
            "level": {"$in": ["error", "warn"]},
            "timestamp": {"$gte": start_iso, "$lt": end_iso},
        })
        buckets.append({"from": start_iso, "to": end_iso, "count": n})

    # Top errors (last 24h)
    day_ago = (now - timedelta(hours=24)).isoformat()
    pipeline = [
        {"$match": {"level": {"$in": ["error", "warn"]}, "timestamp": {"$gte": day_ago}}},
        {"$group": {"_id": "$errorCode", "count": {"$sum": 1}, "lastMessage": {"$last": "$message"}}},
        {"$sort": {"count": -1}},
        {"$limit": 10},
    ]
    top_codes = [{"code": r["_id"] or "UNKNOWN", "count": r["count"], "lastMessage": r.get("lastMessage")}
                 async for r in db.system_logs.aggregate(pipeline)]

    # Top affected routes
    pipeline_r = [
        {"$match": {"level": {"$in": ["error", "warn"]}, "timestamp": {"$gte": day_ago}}},
        {"$group": {"_id": "$route", "count": {"$sum": 1}}},
        {"$sort": {"count": -1}},
        {"$limit": 10},
    ]
    top_routes = [{"route": r["_id"] or "?", "count": r["count"]}
                  async for r in db.system_logs.aggregate(pipeline_r)]

    # Rate: errors/min (last 5 min)
    last_5 = sum(b["count"] for b in buckets[-1:])
    return {
        "errorsLast5Min": last_5,
        "errorRate": round(last_5 / 5.0, 2),
        "timeline": buckets,
        "topCodes": top_codes,
        "topRoutes": top_routes,
        "countersLive": metrics.error_counters,
    }


@router.get("/breaker")
async def system_breaker(_=Depends(verify_admin_token)):
    """Expose NestJS proxy circuit breaker state."""
    return {"nestjs": nest_breaker.state()}


@router.get("/alert-dispatches")
async def system_alert_dispatches(request: Request, _=Depends(verify_admin_token)):
    db = get_db()
    limit = int(request.query_params.get("limit", 50))
    level = request.query_params.get("level")
    q: dict = {}
    if level:
        q["level"] = level
    docs = await db.alert_dispatches.find(q, {"_id": 0}).sort("dispatchedAt", -1).limit(limit).to_list(limit)
    return {"dispatches": docs, "total": len(docs)}


@router.post("/test-alert")
async def system_test_alert(request: Request, _=Depends(verify_admin_token)):
    db = get_db()
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    level = body.get("level", "info")
    code = body.get("code", "TEST_ALERT")
    message = body.get("message", "Test alert from /api/system/test-alert")
    doc = await dispatch_alert(db, level=level, code=code, message=message,
                               meta={"source": "manual-test"})
    return {"ok": True, "dispatched": doc}


@router.get("/idempotency/{key}")
async def system_idempotency_get(key: str, _=Depends(verify_admin_token)):
    db = get_db()
    doc = await db.idempotency_keys.find_one({"key": key}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Idempotency-Key not found")
    # normalize expiresAt for JSON output
    if isinstance(doc.get("expiresAt"), datetime):
        doc["expiresAt"] = doc["expiresAt"].isoformat()
    return doc


@router.get("/audit")
async def system_audit(request: Request, _=Depends(verify_admin_token)):
    db = get_db()
    limit = int(request.query_params.get("limit", 50))
    actor = request.query_params.get("actor")
    action = request.query_params.get("action")
    q: dict = {}
    if actor:
        q["actor"] = actor
    if action:
        q["action"] = action
    docs = await db.audit_logs.find(q, {"_id": 0}).sort("timestamp", -1).limit(limit).to_list(limit)
    return {"audit": docs, "total": len(docs)}
