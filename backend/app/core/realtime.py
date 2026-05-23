"""app.core.realtime — NestJS event emitter (HTTP → /api/realtime/emit).

Sprint 21 C4: вынос emit_realtime_event из server.py. Функция использует
shared httpx.AsyncClient через ctx.http_client (привязывается в server.py
startup) — никаких собственных pool'ов, нулевой impact на нагрузку.

Design:
  - Best-effort / non-blocking: exceptions тихо глотаются (как было в server.py).
  - NESTJS_URL читается из app.core.config.
  - http_client берём через ctx, чтобы:
    * не создавать второй connection pool
    * избежать circular import (server.py -> realtime.py -> server.py)
    * в тестах можно замокать ctx.http_client

Module-level коммент: почему НЕ через параметр функции — потому что функция
вызывается из десятков мест в бизнес-логике и менять сигнатуру везде = scope
creep. ctx — естественный DI-контейнер, уже установленный в PRE-COMMIT 0.
"""
from __future__ import annotations

from app.core.context import ctx
from app.core.config import NESTJS_URL, NESTJS_ENABLED
from app.system.realtime import record_event


async def emit_realtime_event(event_type: str, data: dict) -> None:
    """Push event to NestJS realtime controller for WebSocket broadcast.

    Non-blocking best-effort: любая ошибка (network/timeout/NestJS down)
    тихо игнорируется — realtime не должен блокировать бизнес-операции.

    Hygiene-pass: дополнительно зеркалируем событие в локальный in-memory
    ring buffer (`app.system.realtime`), который опрашивается admin/web
    через `/api/realtime/events`. Это спасает Live Feed после выключения
    NestJS.
    """
    # 1) Local mirror — admin/web polling.
    try:
        record_event(event_type, data)
    except Exception:
        pass  # buffer is best-effort

    # 2) NestJS broadcast — только если включён (default off).
    if not NESTJS_ENABLED:
        return
    client = ctx.http_client
    if client is None:
        return
    try:
        await client.post(
            f"{NESTJS_URL}/api/realtime/emit?event_type={event_type}",
            json=data, timeout=2.0,
        )
    except Exception:
        pass  # Non-blocking, best-effort
