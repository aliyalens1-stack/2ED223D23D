"""app.integrations.router_admin_integrations — /api/admin/integrations CRUD.

Admin-only surface for managing third-party provider credentials.
ALL endpoints require admin auth via `verify_admin_token`.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.security import verify_admin_token
from app.core.db import db
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

from . import credentials_service, stripe_service

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/admin/integrations",
    tags=["admin-integrations"],
    dependencies=[Depends(verify_admin_token)],
)


# Known providers (admin UI uses this for "add new" picker).
KNOWN_PROVIDERS = [
    "stripe",
    "paypal",
    "firebase_push",
    "expo_push",
    "postmark",
    "sendgrid",
    "twilio_sms",
]


class UpsertPayload(BaseModel):
    payload: dict = Field(default_factory=dict)
    mode: str = Field(default="test")  # "test" | "live"
    enabled: bool = Field(default=True)


class ToggleRequest(BaseModel):
    enabled: bool


@router.get("/")
async def list_all(_: Request):
    """List ALL configured providers with masked payloads."""
    summaries = await credentials_service.list_summaries(db=db)
    return {"providers": summaries, "known_providers": KNOWN_PROVIDERS}


@router.get("/{provider}")
async def get_one(provider: str, _: Request):
    """Get one provider config (masked secrets)."""
    rec = await credentials_service.get(provider, db=db)
    if not rec:
        raise HTTPException(status_code=404, detail=f"provider '{provider}' not configured")
    return {
        "provider": rec["provider"],
        "mode": rec["mode"],
        "enabled": rec["enabled"],
        "payload": credentials_service.mask_payload(rec["payload"]),
        "updated_at": rec["updated_at"],
        "updated_by": rec["updated_by"],
    }


@router.put("/{provider}")
async def upsert(
    provider: str,
    body: UpsertPayload,
    request: Request,
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """Upsert provider credentials. Secrets in payload replace stored values."""
    actor = "admin"
    try:
        principal = getattr(request.state, "principal", None)
        if principal:
            actor = principal.get("email") or principal.get("user_id") or "admin"
    except Exception:  # noqa: BLE001
        pass
    result = await credentials_service.upsert(
        provider, body.payload, mode=body.mode, enabled=body.enabled, actor=actor, db=db
    )
    # P6.B.2 — Attribution: HIGH-priority secret rotation event.
    try:
        await record_admin_mutation(
            db, ctx,
            action="integration.upsert",
            domain="integration_credential",
            entity_id=provider,
            extra={"mode": body.mode, "enabled": body.enabled,
                   "payloadKeys": sorted((body.payload or {}).keys())},
        )
    except Exception as _attr_e:
        logger.warning(f"[integrations] attribution upsert failed: {_attr_e}")
    return result


@router.post("/{provider}/toggle")
async def toggle(
    provider: str,
    body: ToggleRequest,
    request: Request,
    ctx: AttributionContext = Depends(get_attribution_context),
):
    actor = "admin"
    try:
        principal = getattr(request.state, "principal", None)
        if principal:
            actor = principal.get("email") or principal.get("user_id") or "admin"
    except Exception:  # noqa: BLE001
        pass
    try:
        await credentials_service.set_enabled(provider, body.enabled, actor=actor, db=db)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    try:
        await record_admin_mutation(
            db, ctx,
            action="integration.toggle",
            domain="integration_credential",
            entity_id=provider,
            extra={"enabled": body.enabled},
        )
    except Exception as _attr_e:
        logger.warning(f"[integrations] attribution toggle failed: {_attr_e}")
    return {"provider": provider, "enabled": body.enabled}


@router.post("/{provider}/test")
async def test(
    provider: str,
    _: Request,
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """Provider-specific connection test. Returns {ok, stage, ...details}."""
    if provider == "stripe":
        result = await stripe_service.test_connection(db)
    else:
        rec = await credentials_service.get(provider, db=db)
        if not rec:
            result = {"ok": False, "stage": "credentials", "error": "not configured"}
        elif not rec.get("enabled"):
            result = {"ok": False, "stage": "credentials", "error": "disabled"}
        else:
            result = {
                "ok": True,
                "stage": "credentials_present",
                "note": f"no live test wired for '{provider}' yet — keys are stored and decryptable",
            }
    try:
        await record_admin_mutation(
            db, ctx,
            action="integration.test",
            domain="integration_credential",
            entity_id=provider,
            extra={"ok": bool(result.get("ok")), "stage": result.get("stage")},
        )
    except Exception as _attr_e:
        logger.warning(f"[integrations] attribution test failed: {_attr_e}")
    return result


@router.delete("/{provider}")
async def delete(
    provider: str,
    _: Request,
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """Remove a provider's credentials entirely."""
    res = await db["integration_credentials"].delete_one({"_id": provider})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f"provider '{provider}' not configured")
    credentials_service.invalidate_cache(provider)
    try:
        await record_admin_mutation(
            db, ctx,
            action="integration.delete",
            domain="integration_credential",
            entity_id=provider,
        )
    except Exception as _attr_e:
        logger.warning(f"[integrations] attribution delete failed: {_attr_e}")
    return {"provider": provider, "deleted": True}
