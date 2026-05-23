"""customer_cognition.router — single endpoint.

GET /api/customer/inspection/{job_id}/report-cognition

Pure read. Customer-gated AND job-owned. Returns deterministic restrained
interpretation built from inspection_drafts + inspection_jobs + reputation.
NEVER proxies operational copy (summary / reasoning / item notes / action
strings) — wording is built entirely in mapper.py.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException, Path

from app.core.identity_runtime import IdentityContext, require_account_kind
from app.core.db import get_db
from .mapper import build_cognition

router = APIRouter(prefix="/api/customer", tags=["customer:cognition"])
_customer_required = require_account_kind("customer")


async def _load_job_for_customer(db, job_id: str, customer_id: str) -> dict | None:
    """Job lookup gated by ownership. Returns None when not owned → caller
    raises 404 (no information leak about job existence)."""
    job = await db.inspection_jobs.find_one(
        {"id": job_id, "customerId": customer_id},
        {"_id": 0},
    )
    return job or None


async def _latest_draft_for_job(db, job_id: str) -> dict | None:
    """Latest persisted draft for this job, regardless of LLM success or not.

    We project only the structural keys the mapper is allowed to read.
    `summary`, `reasoning`, `ai.*`, `topProblems.note`, `recommendedActions`
    item-strings are intentionally NOT projected away here — the projection
    is *defence in depth*; the mapper itself never reads them. Keeping
    the same surface keys lets us audit substrate without code branches.
    """
    return await db.inspection_drafts.find_one(
        {"jobId": job_id},
        sort=[("generatedAt", -1)],
        projection={
            "_id": 0,
            "contradictions": 1,
            "missingEvidence": 1,
            "topProblems": 1,
            "recommendedActions": 1,
            "input": 1,
            "generatedAt": 1,
        },
    )


@router.get("/inspection/{job_id}/report-cognition")
async def get_report_cognition(
    job_id: str = Path(..., min_length=1),
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Customer-facing read of report cognition.

    Response shapes:
      • forming (pre-delivery OR draft missing):
          { ok: false, reason: 'forming', interpretation: '...' }
      • delivered:
          { ok: true, sections: { structurally_matters, remains_uncertain,
                                  supports_interpretation, may_require_review } }
    """
    db = get_db()
    job = await _load_job_for_customer(db, job_id, ctx_.user_id)
    if not job:
        raise HTTPException(status_code=404, detail="inspection not found")

    draft = await _latest_draft_for_job(db, job_id)

    # Reputation snapshot for hard-floor signal. Failure here MUST NOT
    # block the read; hard_floor defaults to False (the conservative
    # direction for customer surface — no theatrical activation).
    hard_floor = False
    inspector_id = job.get("inspectorId")
    if inspector_id:
        try:
            udoc = await db.users.find_one(
                {"_id": inspector_id},
                {"reputation.hardFloor": 1, "_id": 0},
            )
            hard_floor = bool(((udoc or {}).get("reputation") or {}).get("hardFloor"))
        except Exception:
            hard_floor = False

    return build_cognition(draft=draft, job=job, hard_floor=hard_floor)
