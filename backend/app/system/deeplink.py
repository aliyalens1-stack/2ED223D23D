"""app.system.deeplink — stateless resolver for `asearch://` deep-links.

Sprint P0.b.C.e — Deep-links into chronology surfaces.

CONTRACT (frozen):
  - Endpoint is NOT a permission engine. It returns ONLY target metadata
    {surface, route, params, requiredRole}.
  - Endpoint does NOT inspect Authorization header.
  - Response is identical for unauth / customer / provider / admin callers.
  - Real authorisation lives on the target REST/WS endpoint or screen guard
    (already enforced by P0.b.C.a..d invariants).
  - Closed whitelist of 4 surfaces — no generic registry, no plugin loader.

REF FORMAT:
  <surface-key>:<resource-id>
  e.g.  booking-timeline.customer:test-req-abc123

OUT OF SCOPE (P0.b.C.e):
  - signing / HMAC of refs
  - TTL / expiry
  - universal-link domain verification
  - mutating deep-links
"""
from __future__ import annotations

from typing import Optional
from fastapi import APIRouter, HTTPException, Query


router = APIRouter()  # no prefix — full path used


# Closed whitelist. Order intentional: customer/provider/inspector/admin
# mirrors the 4 chronology actor projections in P0.b.C.a..d.
SURFACES = {
    "booking-timeline.customer": {
        "route": "/customer/booking/[id]/timeline",
        "paramKey": "id",
        "requiredRole": "customer",
    },
    "booking-timeline.provider": {
        "route": "/provider/booking/[id]/timeline",
        "paramKey": "id",
        "requiredRole": "provider",
    },
    "job-timeline.inspector": {
        "route": "/inspector/jobs/[jobId]/timeline",
        "paramKey": "jobId",
        "requiredRole": "inspector",
    },
    "booking-forensic.admin": {
        "route": "/admin/booking/[id]/forensic",
        "paramKey": "id",
        "requiredRole": "admin",
    },
    # P0.b.C.f — payment chronology surfaces. 3 actors, NO inspector.
    "payment-activity.customer": {
        "route": "/customer/payment/[id]/chronology",
        "paramKey": "id",
        "requiredRole": "customer",
    },
    "payout-activity.provider": {
        "route": "/provider/payout/[id]/chronology",
        "paramKey": "id",
        "requiredRole": "provider",
    },
    "payment-forensic.admin": {
        "route": "/admin/payment/[id]/forensic",
        "paramKey": "id",
        "requiredRole": "admin",
    },
}


def _err(message: str) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail={"error": True, "code": "INVALID_DEEPLINK", "message": message},
    )


@router.get("/api/deeplink/resolve")
async def resolve_deeplink(ref: Optional[str] = Query(default=None)):
    """Resolve a deep-link ref to its expo-router target.

    Query params:
      ref: <surface-key>:<resource-id>  (required)

    Returns:
      200 {
        surface: str,                # surface key, e.g. "booking-timeline.customer"
        route: str,                  # expo-router path template, e.g. "/customer/booking/[id]/timeline"
        params: { <paramKey>: str }, # resolved params, e.g. { id: "test-req-abc" }
        requiredRole: str,           # role expected by target ("customer" | "provider" | "inspector" | "admin")
      }

    Errors:
      400 INVALID_DEEPLINK — malformed ref, unknown surface, or empty id
      422 — missing ?ref= query param (FastAPI default)
    """
    if not ref:
        # FastAPI's Query(default=None) lets None through; treat as 422
        # explicitly to match REST convention rather than silently 400-ing.
        raise HTTPException(
            status_code=422,
            detail={"error": True, "code": "MISSING_REF", "message": "ref query param is required"},
        )

    if ":" not in ref:
        raise _err("ref must be in the form <surface>:<resource-id>")

    surface_key, _, resource_id = ref.partition(":")
    surface_key = surface_key.strip()
    resource_id = resource_id.strip()

    if not surface_key:
        raise _err("surface key is empty")
    if not resource_id:
        raise _err("resource id is empty")

    spec = SURFACES.get(surface_key)
    if not spec:
        raise _err(f"unknown surface: {surface_key}")

    return {
        "surface": surface_key,
        "route": spec["route"],
        "params": {spec["paramKey"]: resource_id},
        "requiredRole": spec["requiredRole"],
    }


@router.get("/api/deeplink/surfaces")
async def list_surfaces():
    """Read-only catalogue of known deep-link surfaces.

    Provided for discoverability / debugging. Same opacity invariant: no
    auth check, identical for all callers.
    """
    return {
        "surfaces": [
            {
                "key": key,
                "route": spec["route"],
                "paramKey": spec["paramKey"],
                "requiredRole": spec["requiredRole"],
            }
            for key, spec in SURFACES.items()
        ]
    }
