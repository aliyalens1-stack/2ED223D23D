"""Matching-v2 router — Sprint 1+2 endpoints.

Sprint 1 (stateless):
  POST /api/matching/v2/project
      body: { jobId: str, pricingSnapshot: { densitySnapshot: {...} } }
      returns the projected dispatch policy without persisting anything.

Sprint 2 (frozen snapshot):
  POST /api/matching/v2/freeze/{jobId}
      Reads the CONFIRMED pricing projection for `jobId`, projects the
      dispatch policy, persists an immutable `matching_dispatch_snapshot`
      row. Idempotent — re-running returns the SAME doc byte-identical.
      Refuses with 409 PRICING_NOT_CONFIRMED when no confirmed pricing
      snapshot exists for the job.

  GET /api/matching/v2/snapshot/{jobId}
      Read-only fetch of the frozen dispatch snapshot. 404 when none.

The dispatch executor (Sprint 3) is NOT in this router. Status stays at
`projected` until executor lands.
"""
from __future__ import annotations
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, decode_and_resolve
from app.matching_v2.policy import (
    project_dispatch_policy,
    policy_to_dict,
)
from app.matching_v2.snapshot import (
    MATCHING_VERSION_V2,
    PricingNotConfirmedError,
    freeze_dispatch_snapshot,
    get_dispatch_snapshot,
)


router = APIRouter(prefix="/api/matching/v2", tags=["matching:v2"])


# ── Sprint 1 schemas ──────────────────────────────────────────────────


class _DensitySnapshotIn(BaseModel):
    """Permissive — only `effectiveDensity` is required for projection."""
    effectiveDensity: str

    class Config:
        extra = "allow"


class _PricingSnapshotIn(BaseModel):
    densitySnapshot: _DensitySnapshotIn

    class Config:
        extra = "allow"


class DispatchPolicyIn(BaseModel):
    jobId: str = Field(min_length=1, max_length=128)
    pricingSnapshot: _PricingSnapshotIn


class DispatchPolicyOut(BaseModel):
    jobId: str
    matchingVersion: str = MATCHING_VERSION_V2
    effectiveDensity: str
    dispatchRadiusKm: int | None
    batchSize: int
    ttlMinutes: int | None
    policy: str


# ── Sprint 2 schemas ──────────────────────────────────────────────────


class DispatchSnapshotOut(BaseModel):
    jobId: str
    matchingVersion: str
    pricingVersion: str
    effectiveDensity: str
    dispatchRadiusKm: int | None
    batchSize: int
    ttlMinutes: int | None
    policy: str
    pricingDigest: str
    pricingConfirmedAt: str | None
    createdAt: str
    createdBy: str | None
    status: str


# ── Sprint 1 endpoint — projection only ───────────────────────────────


@router.post("/project", response_model=DispatchPolicyOut)
async def project_dispatch(
    payload: DispatchPolicyIn,
    ctx_: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
) -> Dict[str, Any]:
    """Project the dispatch policy for a job given its pricing snapshot.
    Pure — no state change.
    """
    try:
        policy = project_dispatch_policy(payload.pricingSnapshot.dict())
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    return {
        "jobId": payload.jobId,
        "matchingVersion": MATCHING_VERSION_V2,
        **policy_to_dict(policy),
    }


# ── Sprint 2 endpoints — freeze + read ────────────────────────────────


@router.post("/freeze/{job_id}", response_model=DispatchSnapshotOut)
async def freeze_snapshot(
    job_id: str,
    ctx_: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
) -> Dict[str, Any]:
    """Freeze (or return existing) dispatch snapshot for `job_id`.

    Idempotent. Reads the confirmed pricing projection for the job and
    projects the policy on top of it. The resulting snapshot is
    immutable — subsequent calls return the same document.

    409 PRICING_NOT_CONFIRMED — no confirmed pricing for this job. The
    customer must confirm the price first (per the pricing-v2 contract).
    """
    db = get_db()
    try:
        return await freeze_dispatch_snapshot(
            db, job_id=job_id, created_by=ctx_.user_id,
        )
    except PricingNotConfirmedError as e:
        # Emit a pre-normalised envelope so the global HTTPException
        # handler short-circuits on `error=True` and preserves our
        # specific `code` instead of deriving "CONFLICT" from the
        # HTTP status reason.
        raise HTTPException(
            status_code=409,
            detail={
                "error": True,
                "code": e.code,
                "message": str(e),
                "details": {"jobId": job_id, "pricingStatus": e.status},
            },
        )


@router.get("/snapshot/{job_id}", response_model=DispatchSnapshotOut)
async def read_snapshot(
    job_id: str,
    ctx_: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
) -> Dict[str, Any]:
    """Read-only fetch of the frozen dispatch snapshot. 404 when none.
    """
    db = get_db()
    doc = await get_dispatch_snapshot(db, job_id=job_id)
    if doc is None:
        raise HTTPException(
            status_code=404,
            detail={
                "code": "DISPATCH_SNAPSHOT_NOT_FOUND",
                "message": f"no dispatch snapshot for job {job_id!r} — "
                           "call POST /api/matching/v2/freeze/{jobId} first",
            },
        )
    return doc


__all__ = ["router"]
