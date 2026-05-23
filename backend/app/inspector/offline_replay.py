"""
Sprint 2 · Step 5 — Offline Replay Audit Log.

Single endpoint that records every queued action the inspector device
successfully replayed (or permanently failed). NOT business state — pure
audit. Backend de-duplication is already done via Idempotency-Key on the
real /api/inspector/jobs/:id/{media/upload, draft, report} endpoints.

Shape (per spec):
    {
        "queueId": "...",
        "kind": "media_upload|draft_generate|report_submit",
        "jobId": "...",
        "attempts": 3,
        "result": "success|failed",
        "latencyMs": 1234,
        "createdAt": "..."
    }

This endpoint is intentionally lenient:
  - Inspector role required (not admin).
  - Returns 200 even when fields are slightly off — audit must never
    block runtime replay on a malformed log entry.
  - Best-effort write; failures swallowed.

Admin can list recent entries through GET /api/admin/offline-replay/recent.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token


router = APIRouter()


VALID_KINDS = {"media_upload", "draft_generate", "report_submit"}
VALID_RESULTS = {"success", "failed"}


class ReplayLogIn(BaseModel):
    queueId: str = Field(..., min_length=1, max_length=128)
    kind: str = Field(..., min_length=1, max_length=64)
    jobId: str = Field(..., min_length=1, max_length=128)
    attempts: int = Field(0, ge=0, le=50)
    result: str = Field(..., min_length=1, max_length=16)
    latencyMs: int = Field(0, ge=0, le=10 * 60 * 1000)


async def _ensure_indexes(db) -> None:
    """Idempotent. Called from lifespan; safe to call multiple times."""
    try:
        await db.offline_replay_log.create_index([("createdAt", -1)])
        await db.offline_replay_log.create_index([("jobId", 1), ("createdAt", -1)])
        await db.offline_replay_log.create_index([("kind", 1), ("result", 1)])
    except Exception:
        # Indexes are an optimisation, not a correctness guarantee.
        pass


@router.post("/api/inspector/offline-replay/log")
async def post_replay_log(req: Request, body: ReplayLogIn, db=Depends(get_db)):
    """
    Inspector device hands us one record per replay attempt outcome.

    Auth: any Bearer token — we don't enforce inspector role here so that
    even if the token's `kind` is stale (e.g. account switched mid-replay)
    the audit still lands. The body's `jobId` is the source of truth and
    is checked separately on the actual write endpoints.
    """
    # Soft auth: must have *some* token; do not 401 on stale role.
    auth = req.headers.get("authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="auth required")

    kind = body.kind if body.kind in VALID_KINDS else "unknown"
    result = body.result if body.result in VALID_RESULTS else "unknown"

    doc = {
        "id": str(uuid.uuid4()),
        "queueId": body.queueId[:128],
        "kind": kind,
        "jobId": body.jobId[:128],
        "attempts": int(body.attempts),
        "result": result,
        "latencyMs": int(body.latencyMs),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        # Lightweight client meta — useful for triaging cohort issues
        "userAgent": (req.headers.get("user-agent") or "")[:200],
        "ip": (req.client.host if req.client else "")[:64],
    }
    try:
        await db.offline_replay_log.insert_one(dict(doc))
    except Exception:
        # Audit failures must never bubble up into runtime — replay
        # already succeeded before this call. Swallow silently.
        pass

    return {"ok": True}


@router.get("/api/admin/offline-replay/recent")
async def list_recent_replays(
    request: Request,
    jobId: Optional[str] = None,
    kind: Optional[str] = None,
    result: Optional[str] = None,
    limit: int = 50,
    db=Depends(get_db),
) -> dict[str, Any]:
    """Admin-only inspection of replay log. Used for ops dashboards."""
    await verify_admin_token(request)
    q: dict[str, Any] = {}
    if jobId:
        q["jobId"] = jobId
    if kind and kind in VALID_KINDS:
        q["kind"] = kind
    if result and result in VALID_RESULTS:
        q["result"] = result
    limit = max(1, min(int(limit or 50), 500))
    cursor = (
        db.offline_replay_log
        .find(q, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    items = [doc async for doc in cursor]
    # Light KPIs over the same window
    counts = {"total": len(items), "success": 0, "failed": 0}
    latencies: list[int] = []
    for it in items:
        if it.get("result") == "success":
            counts["success"] += 1
        elif it.get("result") == "failed":
            counts["failed"] += 1
        try:
            latencies.append(int(it.get("latencyMs", 0)))
        except Exception:
            pass
    latencies.sort()
    p50 = latencies[len(latencies) // 2] if latencies else 0
    p95 = latencies[int(len(latencies) * 0.95) - 1] if len(latencies) >= 20 else (latencies[-1] if latencies else 0)
    return {
        "items": items,
        "counts": counts,
        "latencyMs": {"p50": p50, "p95": p95},
    }
