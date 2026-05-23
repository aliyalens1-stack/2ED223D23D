"""app.core.utils — мелкие helper-функции.

Sprint 21 C1: вынос из server.py. Реализация 1-в-1, никаких изменений.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def uid() -> str:
    return str(uuid.uuid4())
