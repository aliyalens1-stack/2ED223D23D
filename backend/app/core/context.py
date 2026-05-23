"""AppContext — shared container для DB, realtime, logger.

Sprint 21 PRE-COMMIT 0 contract:
  - Container существует, заполняется в server.py после создания `db`.
  - Модули могут делать `from app.core.context import ctx`, но
    в PRE-COMMIT 0 НИКТО этого ещё не делает.
  - Реальная миграция `db.x → ctx.db.x` идёт модуль за модулем (C5+).
  - `ctx.ready` НЕ трогается здесь — будет выставлен только в startup_event
    после полной инициализации (C10+: после load_persisted(), индексов, лупов).
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
import logging


@dataclass
class RealtimeEmitters:
    """Namespace для 4 NestJS event emitter'ов (server.py:711-740)."""
    event: Optional[Callable] = None                 # emit_realtime_event
    booking_status: Optional[Callable] = None        # emit_booking_status_changed
    provider_new_request: Optional[Callable] = None  # emit_provider_new_request
    provider_location: Optional[Callable] = None     # emit_provider_location


@dataclass
class AppContext:
    mongo: Any = None                       # AsyncIOMotorClient
    db: Any = None                          # motor database (client[DB_NAME])
    http_client: Any = None                 # httpx.AsyncClient (shared pool for NestJS/realtime)
    emit: RealtimeEmitters = field(default_factory=RealtimeEmitters)
    logger: logging.Logger = field(default_factory=lambda: logging.getLogger("app"))
    ready: bool = False                     # выставляется в startup_event (C10+)


# Singleton — заполняется в server.py при загрузке модуля
ctx: AppContext = AppContext()
