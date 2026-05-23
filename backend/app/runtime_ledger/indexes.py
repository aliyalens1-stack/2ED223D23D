"""runtime_ledger/indexes.py — collection indexes.

Three indexes serve all Pass 1 reads, plus a unique index on dedupKey
which IS the append-only coalescing mechanism (Rule 4).
"""
from __future__ import annotations

import logging
from app.core.db import get_db

log = logging.getLogger(__name__)

COLLECTION = "runtime_continuity_events"


async def ensure_indexes() -> None:
    db = get_db()
    coll = db[COLLECTION]
    try:
        # Append-only coalescing (Rule 4): unique key per (event-type,
        # subject, segment) prevents duplicate inserts at the storage
        # layer. Sparse because legacy events (none yet) would lack it.
        await coll.create_index("dedupKey", unique=True, sparse=False)
        # Subject scan: "all events for this request / job / report".
        await coll.create_index([("subjectId", 1), ("emittedAt", -1)])
        # Type-grouped recent feed (admin inspection endpoint).
        await coll.create_index([("type", 1), ("emittedAt", -1)])
        # Continuity-branch recent feed.
        await coll.create_index([("continuity", 1), ("emittedAt", -1)])
        log.info("runtime_ledger: %s indexes ensured", COLLECTION)
    except Exception as e:
        log.warning("runtime_ledger: ensure_indexes failed: %s", e)
