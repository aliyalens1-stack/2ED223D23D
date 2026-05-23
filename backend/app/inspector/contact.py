"""Customer Contact Unlock Flow — Sprint 2 Step 2 (read-only).

Contact layer NEVER mutates lifecycle status.
It only:
  1. resolves visibility for the current job status
  2. masks/reveals the customer payload accordingly
  3. mirrors the moment of reveal into `contact_reveal_log` + timeline_events
     (the mirror itself is driven by the lifecycle, not by this layer)

Canonical visibility ladder (Sprint 2 Step 2):

    job.status        → contact stage
    ──────────────────────────────────
    open              → hidden
    claimed           → hidden          (lifecycle owns the next step)
    accepted          → masked          (intermediate, if used by ops)
    on_route          → revealed
    arrived           → revealed
    inspecting        → revealed
    in_progress       → revealed
    awaiting_report   → revealed
    submitted         → revealed
    approved          → revealed
    customer_accepted → revealed
    rejected          → revealed        (inspector may still need to follow up)
    cancelled         → hidden

Idempotency: `contact_reveal_log` is keyed by stable `_id = reveal_<jobId>_<stage>`,
so the same (job, stage) edge writes exactly one row no matter how many times
the lifecycle is replayed.

Ownership (LM2 mitigation): we check ownership against `inspectorAccountId`
first (canonical), then fall back to `inspectorId` (legacy). No data migration
in Step 2.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db

router = APIRouter(prefix="/api/inspector", tags=["inspector:contact"])

STATE_HIDDEN = "hidden"
STATE_MASKED = "masked"
STATE_REVEALED = "revealed"


# ─────────────────────────────────────────────────────────────────────
# Pure visibility resolver
# ─────────────────────────────────────────────────────────────────────
_REVEALED_STATUSES = {
    "on_route", "arrived", "inspecting", "in_progress", "on_site",
    "awaiting_report", "report_draft", "submitted", "report_submitted",
    "approved", "done", "completed", "customer_accepted", "rejected",
}
_MASKED_STATUSES = {"accepted"}
# Everything else (open / claimed / cancelled / unknown) → hidden


def resolve_contact_visibility(job_status: Optional[str]) -> str:
    """Pure function: lifecycle status → contact stage.

    Single source of truth for the visibility ladder. Used by GET /contact,
    by lifecycle hooks (auto-emit on stage edge), and by tests.
    """
    if not job_status:
        return STATE_HIDDEN
    s = job_status.lower()
    if s in _REVEALED_STATUSES:
        return STATE_REVEALED
    if s in _MASKED_STATUSES:
        return STATE_MASKED
    return STATE_HIDDEN


# Legacy alias kept for callers (e.g. nothing in repo, but external admin
# tools may import it).
def _stage_for(status: Optional[str]) -> str:  # pragma: no cover - legacy alias
    return resolve_contact_visibility(status)


# ─────────────────────────────────────────────────────────────────────
# Masking helpers
# ─────────────────────────────────────────────────────────────────────
def _mask_phone(p: Optional[str]) -> Optional[str]:
    if not p:
        return None
    digits = re.sub(r"\D", "", p)
    if len(digits) <= 4:
        return "•" * len(digits)
    masked = "•" * (len(digits) - 4) + digits[-4:]
    return ("+" if p.strip().startswith("+") else "") + masked


def _mask_name(n: Optional[str]) -> Optional[str]:
    if not n:
        return None
    parts = n.strip().split()
    if not parts:
        return None
    first = parts[0]
    rest = " ".join(p[0] + "." for p in parts[1:])
    return f"{first} {rest}".strip()


# ─────────────────────────────────────────────────────────────────────
# Ownership check (LM2)
# ─────────────────────────────────────────────────────────────────────
def _is_owner(job: Dict[str, Any], uid: str) -> bool:
    """Canonical check: inspectorAccountId first, then legacy inspectorId."""
    acc = job.get("inspectorAccountId")
    if acc and str(acc) == str(uid):
        return True
    legacy = job.get("inspectorId")
    if legacy and str(legacy) == str(uid):
        return True
    return False


# ─────────────────────────────────────────────────────────────────────
# Public API surface
# ─────────────────────────────────────────────────────────────────────
@router.get("/jobs/{job_id}/contact")
async def get_contact(
    job_id: str = Path(...),
    uid: str = Depends(get_user_id_required),
) -> Dict[str, Any]:
    """Return the contact payload appropriate for the current job stage.

    Never leaks the full phone in `hidden` / `masked` stages. Read-only —
    does NOT mutate job status under any circumstance.
    """
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    if job.get("inspectorId") or job.get("inspectorAccountId"):
        if not _is_owner(job, uid):
            raise HTTPException(403, "not your job")

    stage = resolve_contact_visibility(job.get("status"))
    cust = job.get("customer") or {}
    # Fallback: pull from car_requests if job doesn't carry customer snapshot
    if not cust and job.get("requestId"):
        req = await db.car_requests.find_one({"_id": job["requestId"]}) or {}
        cust = req.get("customer") or {
            "name": req.get("customerName"),
            "phone": req.get("customerPhone"),
            "preferredLanguage": req.get("language"),
        }

    full_name = cust.get("name")
    full_phone = cust.get("phone")
    notes = cust.get("notes")

    if stage == STATE_HIDDEN:
        # Adapt hint to the actual lifecycle position
        status = (job.get("status") or "").lower()
        if status == "claimed":
            hint = "Контакт откроется когда выедешь"
        elif status in {"open", ""}:
            hint = "Контакт откроется после принятия задания"
        else:
            hint = "Контакт скрыт"
        out_name = "Клиент подтверждён"
        out_phone = None
        whatsapp = None
        call = None
        notes_out = None
    elif stage == STATE_MASKED:
        hint = "Полный телефон откроется когда выедешь"
        out_name = _mask_name(full_name) or "—"
        out_phone = _mask_phone(full_phone)
        whatsapp = None
        call = None
        notes_out = None
    else:  # revealed
        hint = "Полный доступ к клиенту"
        out_name = full_name or "—"
        out_phone = full_phone
        whatsapp = (
            f"https://wa.me/{re.sub(r'[^0-9]', '', full_phone)}" if full_phone else None
        )
        call = f"tel:{full_phone}" if full_phone else None
        notes_out = notes

    return {
        "stage": stage,
        "name": out_name,
        "phone": out_phone,
        "whatsapp": whatsapp,
        "call": call,
        "preferredLanguage": cust.get("preferredLanguage"),
        "timezone": cust.get("timezone"),
        "notes": notes_out,
        "revealHint": hint,
    }


class RevealBody(BaseModel):
    trigger: str  # legacy field, no longer used for mutation


@router.post("/jobs/{job_id}/contact/reveal", deprecated=True)
async def trigger_reveal_deprecated(
    body: RevealBody,
    job_id: str = Path(...),
    uid: str = Depends(get_user_id_required),
):
    """DEPRECATED (Sprint 2 Step 2).

    Old flow: this endpoint advanced job status AND logged the reveal.
    New flow: lifecycle endpoints (`/on-route`, `/arrived`, `/start-inspection`)
    own status; `record_reveal_for_lifecycle` is invoked from inside the
    lifecycle. This endpoint is kept ONLY for backward compatibility with
    mobile clients ≤ Sprint 2 and is now a no-op safe to call: it returns
    the *current* visibility derived from the durable lifecycle, never
    mutates anything, and re-emits the reveal log idempotently if the
    lifecycle is already at a revealed/masked stage.
    """
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    if job.get("inspectorId") or job.get("inspectorAccountId"):
        if not _is_owner(job, uid):
            raise HTTPException(403, "not your job")

    current_status = (job.get("status") or "").lower()
    current_stage = resolve_contact_visibility(current_status)
    # Best-effort idempotent backfill — useful for old clients that called
    # /reveal but lifecycle is already past the transition.
    if current_stage in {STATE_MASKED, STATE_REVEALED}:
        await _record_reveal_log(
            job=job,
            new_stage=current_stage,
            reason=body.trigger or current_status,
        )

    return {
        "ok": True,
        "deprecated": True,
        "newStage": current_stage,
        "newStatus": current_status,
        "hint": "Status is driven by the lifecycle endpoints; this endpoint no longer mutates.",
    }


# ─────────────────────────────────────────────────────────────────────
# Internal: reveal log writer (called from lifecycle hooks)
# ─────────────────────────────────────────────────────────────────────
async def _record_reveal_log(
    *,
    job: Dict[str, Any],
    new_stage: str,
    reason: str,
) -> Optional[Dict[str, Any]]:
    """Idempotent canonical reveal-log entry.

    Document shape (per Step 2 spec):
      {
        "_id":                "reveal_<jobId>_<stage>",
        "id":                 "reveal_<jobId>_<stage>",
        "jobId":              "...",
        "inspectorAccountId": "...",
        "inspectorId":        "..." (legacy fallback),
        "customerId":         "...",
        "stage":              "masked|revealed",
        "reason":             "on_route|arrived|...",
        "timestamp":          ISO,
        "metadata":           { ... }
      }
    """
    if new_stage not in {STATE_MASKED, STATE_REVEALED}:
        return None  # we only audit the meaningful edges

    db = get_db()
    job_id = job.get("_id")
    if not job_id:
        return None

    record_id = f"reveal_{job_id}_{new_stage}"
    customer_id = None
    if job.get("requestId"):
        try:
            req = await db.car_requests.find_one(
                {"_id": job["requestId"]}, {"_id": 0, "userId": 1}
            )
            customer_id = (req or {}).get("userId")
        except Exception:
            pass

    doc = {
        "_id": record_id,
        "id": record_id,
        "jobId": str(job_id),
        "inspectorAccountId": job.get("inspectorAccountId"),
        "inspectorId": job.get("inspectorId"),
        "customerId": customer_id,
        "stage": new_stage,
        "reason": reason,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "metadata": {
            "vehicleId": job.get("vehicleId"),
            "requestId": job.get("requestId"),
            "city": job.get("city"),
        },
    }

    try:
        await db.contact_reveal_log.update_one(
            {"_id": record_id},
            {"$setOnInsert": doc},
            upsert=True,
        )
    except Exception:
        import logging
        logging.getLogger("server").warning("contact_reveal_log write failed", exc_info=True)
        return None

    return doc


async def record_reveal_for_lifecycle(
    *,
    job: Dict[str, Any],
    new_status: str,
    inspector_id: Optional[str] = None,
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Called from lifecycle hooks (claim_job, transition_status, …).

    1. Computes the OLD and NEW contact stage from old/new job status.
    2. If the stage edge crossed into masked/revealed, writes an idempotent
       reveal log entry AND mirrors a canonical timeline event.

    Returns `(new_stage, log_doc)` for caller inspection — both are None
    when there's no stage change to record.
    """
    # We don't know the OLD status from caller's perspective; the lifecycle
    # gate already validated it. We derive `new_stage` and write the reveal
    # log idempotently: if the same (jobId, stage) edge already exists, it
    # is a no-op.
    new_stage = resolve_contact_visibility(new_status)
    if new_stage == STATE_HIDDEN:
        return None, None

    log = await _record_reveal_log(
        job=job,
        new_stage=new_stage,
        reason=new_status,
    )
    if not log:
        return new_stage, None

    # Timeline mirror — canonical kinds `contact_masked` / `contact_revealed`.
    try:
        from app.inspector.timeline import append_event

        kind = "contact_revealed" if new_stage == STATE_REVEALED else "contact_masked"
        await append_event(
            kind=kind,
            job_id=str(job.get("_id")),
            vehicle_id=job.get("vehicleId"),
            inspector_id=inspector_id or job.get("inspectorId"),
            customer_id=log.get("customerId"),
            actor_type="system",
            actor_id="lifecycle",
            actor_label="Lifecycle",
            severity="info",
            title="Контакт раскрыт" if new_stage == STATE_REVEALED else "Контакт частично раскрыт",
            text=f"Триггер: {new_status}",
            metadata={
                "reason": new_status,
                "stage": new_stage,
                "requestId": job.get("requestId"),
            },
            stable_key=f"{job.get('_id')}_{new_stage}",
        )
    except Exception:
        import logging
        logging.getLogger("server").debug("timeline mirror (contact) failed", exc_info=True)

    return new_stage, log


__all__ = [
    "router",
    "resolve_contact_visibility",
    "record_reveal_for_lifecycle",
    "_record_reveal_log",
    "STATE_HIDDEN",
    "STATE_MASKED",
    "STATE_REVEALED",
]
