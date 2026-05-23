"""app.core.db — единая точка входа к MongoDB через AppContext.

Sprint 21 C2: вводим get_db() lazy-аксессор. Модули получают mongo database
через эту функцию, а не через глобальный `db` из server.py. Это развязывает
зависимости и позволит:
  - мокать БД в тестах
  - подменять БД (read-replica, shadow copy)
  - выносить модули без импорта server.py

PRE-COMMIT 0 инициализировал ctx.db. C2 вводит helper. Миграция вызовов
`db.x` → `get_db().x` идёт точечно по мере выноса каждого модуля.

Sprint 21 C10: дополнительно экспортируется `db` — lazy-proxy объект. Он
проксирует любой attribute access к `ctx.db.<attr>`, вычисляя его в момент
обращения. Позволяет модулям писать `from app.core.db import db` и далее
использовать `await db.collection.find(...)` без переписывания сотен
call-sites. Проксируется через __getattr__ на инстансе класса (в отличие от
PEP 562 module-level __getattr__, это РАБОТАЕТ при LOAD_GLOBAL изнутри модуля,
потому что `db` — обычный объект в namespace модуля).
"""
from __future__ import annotations
from typing import Any

from app.core.context import ctx


def get_db() -> Any:
    """Возвращает motor database из AppContext.

    Raises:
        RuntimeError: если ctx.db ещё не заполнен (т.е. импорт из модуля,
        который загружается ДО server.py инициализации).
    """
    if ctx.db is None:
        raise RuntimeError(
            "DB not initialized in AppContext. "
            "Убедитесь что server.py загружен до первого вызова get_db()."
        )
    return ctx.db


class _DBProxy:
    """Тонкий lazy-proxy над ctx.db — каждый attribute lookup резолвится
    в момент использования. Read-only, никакого кеширования.

    Почему так: motor AsyncIOMotorDatabase не reusable через restart/reload,
    и мы НЕ хотим схватить ссылку на stale db в момент импорта модуля.
    """
    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        if ctx.db is None:
            raise RuntimeError(
                "DB not initialized in AppContext. "
                "Убедитесь что server.py загружен до первого вызова db."
            )
        return getattr(ctx.db, name)

    def __getitem__(self, key: str) -> Any:
        if ctx.db is None:
            raise RuntimeError("DB not initialized in AppContext.")
        return ctx.db[key]

    def __repr__(self) -> str:
        return f"<_DBProxy ctx.db={ctx.db!r}>"


db = _DBProxy()
