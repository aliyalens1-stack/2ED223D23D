"""customer_continuity.router — single endpoint.

GET /api/customer/inspection/{job_id}/continuity

Pure read. Customer-gated AND job-owned. Returns deterministic continuity
narrative with maturity, interpretation and de-duped events.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Path

from app.core.identity_runtime import IdentityContext, require_account_kind
from app.core.db import get_db
from .mapper import (
    CUSTOMER_VISIBLE_KINDS,
    derive_maturity,
    interpretation_for,
    map_event,
    trust_phrase_for,
)

router = APIRouter(prefix="/api/customer", tags=["customer:continuity"])
_customer_required = require_account_kind("customer")


async def _load_job_for_customer(db, job_id: str, customer_id: str) -> dict | None:
    """Find an inspection job belonging to the calling customer.

    Accepts either internal `id` or `_id` style keys. Returns None when not
    owned by this customer — caller turns that into 404 (no info leak).
    """
    job = await db.inspection_jobs.find_one(
        {"id": job_id, "customerId": customer_id},
        {"_id": 0},
    )
    if not job:
        return None
    return job


@router.get("/inspection/{job_id}/continuity")
async def get_inspection_continuity(
    job_id: str = Path(..., min_length=1),
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Customer-facing read of inspection continuity.

    Response shapes (mutually exclusive):
      • ok=true → { maturity, interpretation, events: [...] }
      • ok=false → { reason: "insufficient_continuity" }
    """
    db = get_db()
    job = await _load_job_for_customer(db, job_id, ctx_.user_id)
    if not job:
        raise HTTPException(status_code=404, detail="inspection not found")

    # Pull only customer-visible kinds for this job, oldest → newest.
    cursor = db.timeline_events.find(
        {"jobId": job_id, "kind": {"$in": list(CUSTOMER_VISIBLE_KINDS)}},
        {"_id": 0},
    ).sort("timestamp", 1)

    raw_events: list[dict] = []
    async for ev in cursor:
        raw_events.append(ev)

    # Map → customer continuity events; dedupe identical (title, text) pairs
    # appearing back-to-back (e.g. assignment_accepted + assignment_claimed).
    customer_events: list[dict] = []
    last_key: tuple[str, str] | None = None
    kinds_present: set[str] = set()
    for raw in raw_events:
        kinds_present.add(raw.get("kind"))
        mapped = map_event(raw)
        if not mapped:
            continue
        key = (mapped["title"], mapped["text"])
        if key == last_key:
            continue
        customer_events.append(mapped)
        last_key = key

    # Maturity needs to know whether the report is *delivered to the customer*
    # specifically. We treat job.status in {'delivered','completed'} as canonical
    # delivery; falling back to event presence keeps the heuristic honest if
    # status field is missing.
    status = (job.get("status") or "").lower()
    report_delivered = status in {"delivered", "completed", "report_delivered"}
    maturity = derive_maturity(kinds_present, report_delivered)

    if maturity == "insufficient":
        return {"ok": False, "reason": "insufficient_continuity"}

    # Trust phrasing — pulled from the assigned inspector's durable reputation
    # snapshot (users.reputation), gated by hard-floor flag. Tier names and
    # scores NEVER cross this boundary — only the phrase from `trust_phrase_for`.
    # Field is OMITTED entirely when sparse, never empty-stringed.
    trust_line: str | None = None
    inspector_id = job.get("inspectorId")
    if inspector_id:
        try:
            udoc = await db.users.find_one(
                {"_id": inspector_id},
                {"reputation.tier": 1, "reputation.hardFloor": 1, "_id": 0},
            )
            rep = (udoc or {}).get("reputation") or {}
            trust_line = trust_phrase_for(
                tier=rep.get("tier"),
                hard_floor=bool(rep.get("hardFloor")),
            )
        except Exception:
            # Never block the read — trust line is restrained by design.
            trust_line = None

    response = {
        "ok": True,
        "maturity": maturity,
        "interpretation": interpretation_for(maturity),
        "events": customer_events,
    }
    if trust_line:
        response["trust"] = trust_line

    # Phase D Pass 1D-A — restrained interpretation became available.
    #
    # Emit only when maturity has crystallised past the pre-interpretive
    # phases. Doctrine:
    #   • `insufficient` → ok:false returned earlier; no emit
    #   • `forming`      → coordination only, interpretation NOT yet
    #                      available; no emit
    #   • `accumulating` → interpretation still forming; no emit
    #   • `established`  → report submitted/approved → interpretation
    #                      delivered → emit
    #   • `delivered`    → final report visible to customer → emit
    #
    # NOT emitted on: draft generated / report opened / customer page
    # render / customer interaction. The event means "interpretation
    # became available", NOT "customer viewed it".
    #
    # Coalesce on job_id → ONE event per job, ever. Predecessor invariant
    # enforced at the storage boundary (requires INSPECTION_CONTINUITY_ESTABLISHED).
    # Best-effort: ledger failure does NOT affect the response.
    if maturity in {"established", "delivered"}:
        try:
            from app.runtime_ledger import emit as _rl_emit, EventType as _RLEventType
            await _rl_emit(
                _RLEventType.REPORT_INTERPRETATION_DELIVERED,
                subject_id=job_id,
                payload={},
                emitted_by=ctx_.user_id,
            )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                f"runtime_ledger emit (interpretation_delivered) failed "
                f"for job {job_id}: {exc}"
            )

    return response
