"""runtime_ledger/service.py — emit() helper + read accessors.

emit() is the ONLY way events enter the ledger. There is no public
HTTP endpoint that accepts event submissions, no message bus consumer,
no external producer. Events are recorded from inside business-logic
code paths that have just completed a continuity transition.

Append-only contract:
  • emit() performs `insert_one`. Never `update`, never `upsert`, never
    `replace`.
  • Coalescing (Rule 4) is delivered via a UNIQUE INDEX on `dedupKey`.
    A second emit() with the same dedupKey raises DuplicateKeyError,
    which emit() catches and returns `(existing_id, created=False)`.
    No document is ever mutated; the second event simply does not
    exist.

Read contract:
  • get_events(...) is filterable but never aggregates. Pass 1
    forbids projections, dashboards, replay engines, aggregation jobs.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo.errors import DuplicateKeyError

from app.core.db import get_db
from .events import EMITTABLE, EventType, validate_payload

log = logging.getLogger(__name__)

COLLECTION = "runtime_continuity_events"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _default_dedup_key(
    event_type: EventType, subject_id: str, segment: Optional[str]
) -> str:
    """Build a dedup key.

    When `segment` is provided by the caller, it carries the continuity
    boundary (e.g. an inspection_session_id) — events within the same
    segment coalesce. When `segment` is None and the event type
    coalesces, we use the subject_id as the segment (one event per
    subject, ever). When the event type does not coalesce, the dedup
    key includes a fresh uuid so each emit is unique.
    """
    cfg = EMITTABLE[event_type]
    if cfg["coalesces"]:
        seg = segment or subject_id
        return f"{event_type.value}:{subject_id}:{seg}"
    return f"{event_type.value}:{subject_id}:{uuid.uuid4()}"


async def emit(
    event_type: EventType,
    subject_id: str,
    payload: dict[str, Any],
    *,
    emitted_by: Optional[str] = None,
    segment: Optional[str] = None,
    dedup_key: Optional[str] = None,
) -> tuple[str, bool]:
    """Record a continuity-topology transition.

    Returns `(event_id, created)`. When `created` is False the event
    was coalesced — a previous emit with the same dedup_key already
    exists and is preserved unchanged (append-only).

    Raises ValueError on payload validation failure — the caller is
    responsible for fixing the payload, not the ledger.
    """
    if event_type not in EMITTABLE:
        raise ValueError(f"unknown event type: {event_type!r}")

    err = validate_payload(event_type, payload)
    if err is not None:
        raise ValueError(f"runtime_ledger.emit: {err}")

    cfg = EMITTABLE[event_type]

    # Pass 1C — segment closed-enum enforcement. If the event type
    # declares a `segment_enum`, the caller MUST pass `segment=` and
    # its value MUST be one of the enum members. This is the
    # storage-boundary guard against arbitrary uploader labels leaking
    # into the ledger as continuity-segment values.
    seg_enum = cfg.get("segment_enum")
    if seg_enum is not None:
        allowed = {e.value for e in seg_enum}
        if segment is None:
            raise ValueError(
                f"runtime_ledger.emit: {event_type.value} requires `segment=` "
                f"argument (closed enum: {sorted(allowed)})"
            )
        if segment not in allowed:
            raise ValueError(
                f"runtime_ledger.emit: {event_type.value} segment "
                f"{segment!r} is not in the closed enum {sorted(allowed)}"
            )

    # Pass 1C — topology-order invariant. If the event type declares
    # `requires_predecessor` (a string EventType name), the ledger must
    # already contain at least one event of that type for the same
    # subject. This blocks lifecycle-completion emits that bypass
    # earlier substrate transitions (e.g. flipping a job to `done`
    # without going through `inspecting`).
    predecessor_name = cfg.get("requires_predecessor")
    if predecessor_name is not None:
        from app.core.db import get_db as _get_db
        predecessor_value = EventType[predecessor_name].value
        prior = await _get_db()[COLLECTION].find_one(
            {"subjectId": subject_id, "type": predecessor_value},
            {"_id": 1},
        )
        if prior is None:
            raise ValueError(
                f"runtime_ledger.emit: {event_type.value} requires a prior "
                f"{predecessor_value} event for subject {subject_id!r} — "
                f"topology order violated"
            )

    eid = str(uuid.uuid4())
    dk = dedup_key or _default_dedup_key(event_type, subject_id, segment)

    doc = {
        "_id": eid,
        "id": eid,
        "type": event_type.value,
        "subjectType": cfg["subject"].value,
        "subjectId": subject_id,
        "continuity": cfg["continuity"].value,
        "segment": segment,
        "payload": dict(payload),  # defensive copy — caller cannot mutate post-emit
        "emittedAt": _now(),
        "emittedBy": emitted_by,
        "dedupKey": dk,
    }

    db = get_db()
    try:
        await db[COLLECTION].insert_one(doc)
        return (eid, True)
    except DuplicateKeyError:
        # Coalesced. Locate the existing event for a clean return value;
        # the caller usually does not care, but we keep the contract honest.
        existing = await db[COLLECTION].find_one(
            {"dedupKey": dk}, {"_id": 1}
        )
        if existing:
            return (existing["_id"], False)
        # Extremely defensive: index says duplicate but document is gone.
        # Treat as created to avoid silent loss; this path should be
        # impossible under normal operation.
        log.warning(
            "runtime_ledger: dedupKey %r reported duplicate but no doc found", dk
        )
        return (eid, True)


# ── Reads ───────────────────────────────────────────────────────────
# Pass 1 forbids aggregation / projection / replay. Reads are simple
# filtered scans returning recent-first slices. Wider analytical use
# is OUT OF SCOPE for this Pass.


async def get_events(
    *,
    event_type: Optional[EventType] = None,
    continuity: Optional[str] = None,
    subject_id: Optional[str] = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any]]:
    db = get_db()
    q: dict[str, Any] = {}
    if event_type is not None:
        q["type"] = event_type.value
    if continuity is not None:
        q["continuity"] = continuity
    if subject_id is not None:
        q["subjectId"] = subject_id
    cursor = (
        db[COLLECTION]
        .find(q, {"_id": 0})
        .sort("emittedAt", -1)
        .skip(max(0, int(skip)))
        .limit(max(1, min(int(limit), 500)))
    )
    out: list[dict[str, Any]] = []
    async for ev in cursor:
        # ISO normalize emittedAt for wire safety.
        ts = ev.get("emittedAt")
        if isinstance(ts, datetime):
            ev["emittedAt"] = ts.isoformat()
        out.append(ev)
    return out


async def get_events_for_subject(subject_id: str, limit: int = 100) -> list[dict[str, Any]]:
    return await get_events(subject_id=subject_id, limit=limit)
