"""app.system.health — liveness/readiness endpoints.

Sprint 21 C6: вынесены из server.py:
  - GET /api/health          (basic liveness, был в C2 расширен DB-ping)
  - GET /api/system/health   (extended: engine liveness, WS, errors/5min)

Зависимости:
  - app.core.db.get_db() — Mongo access
  - app.core.context.ctx.http_client — shared httpx pool
  - app.core.config.NESTJS_URL
  - app.core.metrics.metrics — singleton с request_counter/error_counters
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from fastapi import APIRouter

from app.core.db import get_db
from app.core.context import ctx
from app.core.config import NESTJS_URL, NESTJS_ENABLED
from app.core.metrics import metrics


router = APIRouter()  # no prefix — paths явно указаны целиком


@router.get("/api/health")
async def health():
    """Basic liveness — DB ping + NestJS health check. Existing контракт
    (status/nestjs/timestamp) + добавленный в C2 ключ 'db'."""
    db_ok = False
    try:
        await get_db().command("ping")
        db_ok = True
    except Exception:
        pass
    # NestJS статус: либо проверяем реальный subprocess (если включен),
    # либо чисто "disabled" (default).
    if not NESTJS_ENABLED:
        nestjs_status = "disabled"
    else:
        nestjs_ok = False
        try:
            if ctx.http_client is not None:
                r = await ctx.http_client.get(
                    f"{NESTJS_URL}/api/admin/automation/dashboard", timeout=2.0
                )
                nestjs_ok = r.status_code < 500
        except Exception:
            pass
        nestjs_status = "healthy" if nestjs_ok else "starting"
    return {
        "status": "ok",
        "db": "connected" if db_ok else "error",
        "nestjs": nestjs_status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/api/system/health")
async def system_health():
    """Enhanced health: counts, engine liveness, WS status, errors/5min."""
    db = get_db()
    # Engine liveness — check last orchestrator log
    last_orch = await db.orchestrator_logs.find_one(
        {}, {"_id": 0, "createdAt": 1}, sort=[("createdAt", -1)]
    )
    last_fb = await db.action_feedback.find_one(
        {}, {"_id": 0, "createdAt": 1}, sort=[("createdAt", -1)]
    )
    orch_alive = False
    fb_alive = False
    if last_orch and last_orch.get("createdAt"):
        try:
            age = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(last_orch["createdAt"].replace("Z", "+00:00"))
            ).total_seconds()
            orch_alive = age < 60
        except Exception:
            pass
    if last_fb and last_fb.get("createdAt"):
        try:
            age = (
                datetime.now(timezone.utc)
                - datetime.fromisoformat(last_fb["createdAt"].replace("Z", "+00:00"))
            ).total_seconds()
            fb_alive = age < 300
        except Exception:
            pass

    # WS connections from NestJS (только если включен)
    ws_conns = 0
    if NESTJS_ENABLED:
        try:
            if ctx.http_client is not None:
                r = await ctx.http_client.get(f"{NESTJS_URL}/api/realtime/status", timeout=3)
                if r.status_code == 200:
                    ws_conns = r.json().get("connectedClients", 0)
        except Exception:
            pass

    # Errors in last 5 min
    five_min_ago = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
    errors_5min = await db.system_logs.count_documents(
        {"level": {"$in": ["error", "warn"]}, "timestamp": {"$gte": five_min_ago}}
    )

    return {
        "status": "ok" if orch_alive and fb_alive else "degraded",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "requestsTotal": metrics.request_counter,
        "errorsLast5Min": errors_5min,
        "errorsTotal": metrics.error_counters["total"],
        "wsConnections": ws_conns,
        "orchestratorAlive": orch_alive,
        "feedbackAlive": fb_alive,
        "counters": metrics.error_counters,
    }
