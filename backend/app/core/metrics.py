"""app.core.metrics — lightweight request/error counters для /api/system/health.

Sprint 21 C6: вынесены из server.py module-level globals (_request_counter,
_error_counters). Singleton instance `metrics` — один на процесс, пишется
middleware в server.py, читается в app/system/health.py.

Не thread-safe (server.py всё равно async single-process). Если в будущем
понадобится multi-worker — заменить на shared store (Redis/Mongo).
"""
from __future__ import annotations
from datetime import datetime, timezone


class _Metrics:
    """Mutable singleton — атрибуты напрямую изменяются из middleware."""

    def __init__(self):
        self.request_counter: int = 0
        self.error_counters: dict = {
            "by_code": {},
            "by_status": {},
            "by_route": {},
            "total": 0,
            "since": datetime.now(timezone.utc).isoformat(),
        }


metrics = _Metrics()
