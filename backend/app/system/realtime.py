"""app.system.realtime — long-poll realtime endpoint (admin/web SSE fallback).

Сделано как минимальная замена внешнего NestJS realtime gateway, который
выключен (`NESTJS_ENABLED=0`). Все реальные события в системе зеркалятся
через `emit_realtime_event` в локальный in-memory ring buffer; admin-panel
и web-app опрашивают `/api/realtime/events?since=<ts>` каждые 2с (см.
`admin/src/services/realtime.ts`).

Контракт ответа `/api/realtime/events`:
  { events: [ {id, type, data, timestamp}, ... ], timestamp: <iso> }

Контракт ответа `/api/realtime/status`:
  { ok: True, timestamp: <iso>, mode: 'polling', bufferSize: <n> }
"""
from __future__ import annotations

import uuid
from collections import deque
from datetime import datetime, timezone
from typing import Any, Deque, Dict, List, Optional

from fastapi import APIRouter, Query

# Ring buffer: keep last 500 events ~ 2-5 минут активности.
# Hard cap чтобы не утечь память: server.py может работать неделями.
_BUFFER_MAX = 500
_buffer: Deque[Dict] = deque(maxlen=_BUFFER_MAX)


def _jsonable(v: Any) -> Any:
    """Coerce a value to a JSON-safe primitive.

    Business code emits events with Mongo documents (containing ObjectId,
    datetime, etc.). FastAPI's default JSON encoder chokes on those, so we
    normalize here once at ingest — cheap and bounded by event volume.
    """
    if v is None or isinstance(v, (bool, int, float, str)):
        return v
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): _jsonable(val) for k, val in v.items() if k != "_id"}
    if isinstance(v, (list, tuple, set)):
        return [_jsonable(x) for x in v]
    # ObjectId, UUID, custom types — fall back to str.
    try:
        return str(v)
    except Exception:
        return None


def record_event(event_type: str, data: dict) -> Dict:
    """Push an event into the in-memory buffer. Idempotent & non-blocking.

    Called by `app.core.realtime.emit_realtime_event` (fan-in from business
    logic) — see that module for invocation sites.
    """
    evt = {
        "id": uuid.uuid4().hex,
        "type": str(event_type),
        "data": _jsonable(data) if data is not None else {},
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    _buffer.append(evt)
    return evt


router = APIRouter()


@router.get("/api/realtime/status")
async def realtime_status():
    """Heartbeat endpoint polled by admin/web on connection bootstrap."""
    return {
        "ok": True,
        "connected": True,
        "mode": "polling",
        "bufferSize": len(_buffer),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/api/realtime/events")
async def realtime_events(
    since: Optional[str] = Query(None, description="ISO timestamp; return events strictly after this point"),
    limit: int = Query(20, ge=1, le=200),
):
    """Long-poll endpoint. Returns events newer than `since` (if provided)."""
    now_iso = datetime.now(timezone.utc).isoformat()
    if not _buffer:
        return {"events": [], "timestamp": now_iso}

    # Snapshot copy (deque is thread-safe append/pop, but iteration may race
    # with appends — copy first).
    snap: List[Dict] = list(_buffer)
    if since:
        filtered = [e for e in snap if e.get("timestamp", "") > since]
    else:
        filtered = snap

    # Newest first, then trim to limit.
    filtered.sort(key=lambda e: e.get("timestamp", ""), reverse=True)
    return {"events": filtered[:limit], "timestamp": now_iso}


@router.post("/api/realtime/emit")
async def realtime_emit(event_type: str = Query(...), payload: Optional[Dict] = None):
    """Test/debug emit endpoint (used by admin Quick Actions panel)."""
    evt = record_event(event_type, payload or {})
    return {"ok": True, "event": evt}
