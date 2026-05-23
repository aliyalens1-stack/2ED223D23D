"""app.provider.onboarding — Berlin Provider Onboarding v1 (Sprint B-PO).

One-shot endpoint that takes a fresh provider from "no account" to
"already-bidding-and-earning" in a single API call:

  1. Register user (role=provider_owner)            → JWT
  2. Create organization (Berlin, clusters, trust)  → providerSlug
  3. Enable auto-money (preset Top-2 / €30 / €300)  → first bids placed
  4. Bootstrap zone presence on Berlin Mitte/Neukölln (active=true)

Endpoints
---------
  POST /api/provider/onboarding             — full payload (preferred)
  POST /api/provider/onboarding/quick-start — minimal payload, sane defaults
  POST /api/provider/onboarding/bootstrap-bids — re-seed initial bids (idempotent)

All three reuse the same `_run_onboarding(...)` function so behaviour
is identical regardless of how the caller arrives. Response shape
matches what the web-app onboarding flow expects.
"""
from __future__ import annotations

import logging
import re
from typing import Optional
from datetime import timedelta

import jwt
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import hash_pw
from app.core.utils import now_utc, uid
from app.core.config import JWT_SECRET, JWT_ALGO

logger = logging.getLogger("provider.onboarding")
router = APIRouter(prefix="/api/provider/onboarding", tags=["provider-onboarding"])


# ── Defaults (Berlin-specific) ────────────────────────────────────────
BERLIN_CENTER_LON = 13.405
BERLIN_CENTER_LAT = 52.52
BERLIN_TOP_ZONES = ["berlin-mitte", "berlin-neukolln"]
DEFAULT_CLUSTERS = ["inspection"]
DEFAULT_AUTO_MONEY = {
    "targetRank": 2,
    "maxBid": 30,
    "dailyBudget": 300,
    "strategy": "balanced",
}


# ── Payload models ────────────────────────────────────────────────────
class TrustProfile(BaseModel):
    tuvVerified: bool = False
    yearsExperience: Optional[int] = Field(None, ge=0, le=80)
    brands: list[str] = Field(default_factory=list)
    cities: list[str] = Field(default_factory=lambda: ["Berlin"])


class AutoMoneyConfig(BaseModel):
    enabled: bool = True
    targetRank: int = Field(2, ge=1, le=3)
    maxBid: float = Field(30, ge=1, le=500)
    dailyBudget: float = Field(300, ge=10, le=10000)
    strategy: str = Field("balanced")


class OnboardingPayload(BaseModel):
    email: str
    password: str = Field(..., min_length=6)
    name: Optional[str] = None
    phone: Optional[str] = None
    clusters: list[str] = Field(default_factory=lambda: list(DEFAULT_CLUSTERS))
    profile: TrustProfile = Field(default_factory=TrustProfile)
    autoMoney: AutoMoneyConfig = Field(default_factory=AutoMoneyConfig)
    # Geo-4 — canonical topology binding. Sent during signup, not free-text.
    # When omitted, defaults to Berlin/DE/100km (matches every other Berlin
    # default in this onboarding flow). The client sends canonical ids only;
    # backend resolves lat/lng from CITY_CATALOGUE.
    topologyCountry: str = Field("DE", min_length=2, max_length=2)
    topologyCityId: str = Field("berlin", min_length=1)
    topologyRadiusKm: int = Field(100)


class QuickStartPayload(BaseModel):
    email: str
    password: str = Field(..., min_length=6)
    name: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────
def _slugify(name: str, email: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") if name else ""
    if not base:
        base = email.split("@")[0].lower()
    base = re.sub(r"[^a-z0-9-]+", "-", base).strip("-") or "provider"
    return f"{base[:32]}-{uid()[:6]}"


def _make_jwt(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "iat": int(now_utc().timestamp()),
        "exp": int((now_utc() + timedelta(days=7)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


async def _create_user(db, email: str, password: str, name: str) -> tuple[str, dict]:
    """Insert provider_owner user. Raises 409 if duplicate."""
    email_norm = email.strip().lower()
    if not email_norm or "@" not in email_norm:
        raise HTTPException(400, "Valid email required")
    existing = await db.users.find_one({"email": email_norm})
    if existing:
        raise HTTPException(409, "User with this email already exists")
    first_name = (name or email_norm.split("@")[0]).split()[0]
    last_name = " ".join((name or "").split()[1:]) or ""
    user_doc = {
        "email": email_norm,
        "passwordHash": hash_pw(password),
        "firstName": first_name,
        "lastName": last_name,
        "role": "provider_owner",
        "isActive": True,
        "createdAt": now_utc().isoformat(),
    }
    res = await db.users.insert_one(user_doc)
    return str(res.inserted_id), {**user_doc, "_id": str(res.inserted_id)}


async def _create_organization(
    db, owner_id: str, name: str, email: str, phone: Optional[str],
    clusters: list[str], profile: TrustProfile,
) -> dict:
    """Insert organizations doc with Berlin defaults. Returns the doc (no _id)."""
    display_name = name or email.split("@")[0].title() + " Auto-Check"
    slug = _slugify(display_name, email)
    badges: list[str] = []
    if profile.tuvVerified:
        badges.extend(["verified", "tuv"])
    if (profile.yearsExperience or 0) >= 10:
        badges.append("experienced")
    why_reasons: list[str] = []
    if profile.tuvVerified:
        why_reasons.append("TÜV-zertifiziert")
    if profile.yearsExperience:
        why_reasons.append(f"{profile.yearsExperience}+ Jahre Erfahrung")
    if profile.brands:
        why_reasons.append(f"Spezialist: {', '.join(profile.brands[:3])}")

    org = {
        "id": uid(),
        "name": display_name,
        "slug": slug,
        "description": (
            f"TÜV-zertifizierte Fahrzeugprüfung in Berlin. "
            f"{profile.yearsExperience or 5}+ Jahre Erfahrung. "
            f"Pre-Kauf-Inspektion, mobil bei Ihnen vor Ort."
        ),
        "type": "mobile",
        "ownerId": owner_id,
        "email": email,
        "phone": phone or "",
        "status": "active",
        "isVerified": profile.tuvVerified,
        "location": {"type": "Point", "coordinates": [BERLIN_CENTER_LON, BERLIN_CENTER_LAT]},
        "address": "Berlin, mobile on-site",
        "city": "Berlin",
        "country": "DE",
        "currency": "EUR",
        "ratingAvg": 0.0,
        "reviewsCount": 0,
        "bookingsCount": 0,
        "completedBookingsCount": 0,
        "avgResponseTimeMinutes": 10,
        "visibilityScore": 70,
        "visibilityState": "normal",
        "isOnline": True,
        "badges": badges,
        "whyReasons": why_reasons,
        "priceFrom": 149,
        "workHours": "Mo-Sa 08:00-20:00",
        "clusters": [c for c in clusters if c] or list(DEFAULT_CLUSTERS),
        "providerType": "inspector",
        "trustProfile": {
            "tuvVerified": profile.tuvVerified,
            "yearsExperience": profile.yearsExperience or 0,
            "brands": profile.brands,
            "cities": profile.cities or ["Berlin"],
        },
        "createdAt": now_utc().isoformat(),
    }
    await db.organizations.insert_one(org)
    org.pop("_id", None)
    return org


async def _enable_auto_money(db, slug: str, cfg: AutoMoneyConfig, clusters: list[str]) -> dict:
    """Insert auto_money doc + run one immediate tick. Lazy-import to avoid cycle."""
    if not cfg.enabled:
        return {"enabled": False}
    today = now_utc().strftime("%Y-%m-%d")
    am_doc = {
        "providerSlug": slug,
        "enabled": True,
        "targetRank": cfg.targetRank,
        "maxBid": float(cfg.maxBid),
        "dailyBudget": float(cfg.dailyBudget),
        "strategy": cfg.strategy,
        "clusters": clusters or None,
        "zones": BERLIN_TOP_ZONES,
        "day": today,
        "spent": 0,
        "leadsReceived": 0,
        "createdAt": now_utc().isoformat(),
        "updatedAt": now_utc().isoformat(),
    }
    await db.auto_money.update_one(
        {"providerSlug": slug},
        {"$set": am_doc, "$setOnInsert": {"id": uid()}},
        upsert=True,
    )
    # Trigger one immediate tick so first bids land before user sees dashboard
    tick_result: dict = {"ran": False}
    try:
        from app.growth.auto_money import auto_money_tick
        cfg_doc = await db.auto_money.find_one({"providerSlug": slug}, {"_id": 0})
        tick_result = await auto_money_tick(cfg_doc or {})
        tick_result["ran"] = True
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[onboarding] immediate auto_money tick failed for {slug}: {exc}")
        tick_result = {"ran": False, "error": str(exc)[:200]}
    return {"enabled": True, "config": cfg.model_dump(), "tick": tick_result}


async def _bootstrap_bids(db, slug: str, clusters: list[str]) -> list[dict]:
    """Create at least one provider_bid per (top-zone, cluster) so the dashboard
    shows non-empty state immediately. Idempotent (skips zones that already
    have an active bid for this provider+cluster).
    """
    placed: list[dict] = []
    for zone in BERLIN_TOP_ZONES:
        for cluster in clusters or list(DEFAULT_CLUSTERS):
            existing = await db.provider_bids.find_one({
                "providerSlug": slug, "zone": zone, "cluster": cluster, "active": True,
            })
            if existing:
                continue
            bid_doc = {
                "id": uid(),
                "providerSlug": slug,
                "zone": zone,
                "cluster": cluster,
                "bid": 5.0,                    # symbolic floor — auto-money will tune up
                "dailyBudget": 300.0,
                "spent": 0,
                "active": True,
                "leadsReceived": 0,
                "lastChargedAt": None,
                "source": "onboarding",
                "createdAt": now_utc().isoformat(),
                "updatedAt": now_utc().isoformat(),
            }
            await db.provider_bids.insert_one(bid_doc)
            placed.append({"zone": zone, "cluster": cluster, "bid": bid_doc["bid"]})
    return placed


async def _set_provider_location(db, slug: str) -> None:
    """Pin provider on Berlin map so they're visible in marketplace queries."""
    await db.provider_locations.update_one(
        {"providerId": slug},
        {
            "$set": {
                "providerSlug": slug,
                "isOnline": True,
                "location": {
                    "type": "Point",
                    "coordinates": [BERLIN_CENTER_LON, BERLIN_CENTER_LAT],
                },
                "updatedAt": now_utc().isoformat(),
            },
            "$setOnInsert": {"providerId": slug, "createdAt": now_utc().isoformat()},
        },
        upsert=True,
    )


async def _run_onboarding(payload: OnboardingPayload) -> dict:
    db = get_db()

    # 1. user
    user_id, _user_doc = await _create_user(db, payload.email, payload.password, payload.name or "")

    # 2. organization
    clusters = [c for c in (payload.clusters or DEFAULT_CLUSTERS) if c] or list(DEFAULT_CLUSTERS)
    org = await _create_organization(
        db, owner_id=user_id, name=payload.name or "",
        email=payload.email, phone=payload.phone,
        clusters=clusters, profile=payload.profile,
    )

    # 2b. Geo-4 — canonical topology binding. MUST happen before any
    # marketplace-active surface (location pin / bids / auto-money), so
    # the new provider satisfies the invariant:
    #
    #     provider cannot become marketplace-active without provider_topology
    #
    # If the requested city/country isn't in CITY_CATALOGUE we fall back
    # to the Berlin default. We never silently skip — the projection
    # downstream depends on this being set.
    try:
        from app.geo.topology import upsert_topology
        try:
            await upsert_topology(
                user_id=user_id,
                country_code=payload.topologyCountry,
                city_id=payload.topologyCityId,
                travel_radius_km=payload.topologyRadiusKm,
            )
        except ValueError as ve:
            logger.warning(
                f"[onboarding] topology rejected ({ve}); "
                "falling back to Berlin/DE/100km default"
            )
            await upsert_topology(
                user_id=user_id,
                country_code="DE",
                city_id="berlin",
                travel_radius_km=100,
            )
    except Exception as exc:  # noqa: BLE001
        # Provider account is created but topology missing — surface this
        # via the coverage projection so ops see it. We do NOT block
        # registration (that would make the activation gate brittle).
        logger.error(f"[onboarding] topology bind failed (non-fatal): {exc}")

    # 3. presence + bootstrap bids — must run BEFORE auto_money tick
    #    so auto_money has a 'real' provider record + at least one bid row to tune
    try:
        await _set_provider_location(db, org["slug"])
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[onboarding] provider_locations upsert failed: {exc}")

    seeded_bids = await _bootstrap_bids(db, org["slug"], clusters)

    # 4. auto-money
    auto_money_state = await _enable_auto_money(db, org["slug"], payload.autoMoney, clusters)

    # 5. issue JWT
    token = _make_jwt(user_id, payload.email.lower(), "provider_owner")

    return {
        "ok": True,
        "accessToken": token,
        "user": {
            "id": user_id,
            "email": payload.email.lower(),
            "role": "provider_owner",
            "firstName": (payload.name or payload.email.split("@")[0]).split()[0],
            "lastName": "",
        },
        "provider": {
            "slug": org["slug"],
            "name": org["name"],
            "clusters": org["clusters"],
            "city": org["city"],
            "trustProfile": org["trustProfile"],
        },
        "autoMoney": auto_money_state,
        "seededBids": seeded_bids,
        "nextStep": {
            "redirectTo": "/provider",
            "label": "Zum Dashboard",
        },
    }


# ── Endpoints ─────────────────────────────────────────────────────────
@router.post("")
async def onboarding_full(payload: OnboardingPayload):
    """Full provider onboarding — register + organization + auto-money + bids."""
    return await _run_onboarding(payload)


@router.post("/quick-start")
async def onboarding_quick_start(payload: QuickStartPayload):
    """One-click flow: only email/password/name needed. Everything else preset."""
    full = OnboardingPayload(
        email=payload.email,
        password=payload.password,
        name=payload.name,
        clusters=list(DEFAULT_CLUSTERS),
        profile=TrustProfile(tuvVerified=False, yearsExperience=5, brands=[], cities=["Berlin"]),
        autoMoney=AutoMoneyConfig(**DEFAULT_AUTO_MONEY),
    )
    return await _run_onboarding(full)


@router.post("/bootstrap-bids")
async def onboarding_bootstrap_bids(request: Request):
    """Idempotent re-seed of initial bids for an already-onboarded provider.
    Body: { providerSlug, clusters? } — useful if the auto_money tick failed
    on first attempt or provider was created via admin without onboarding.
    """
    db = get_db()
    body = await request.json()
    slug = (body.get("providerSlug") or "").strip()
    if not slug:
        raise HTTPException(400, "providerSlug required")
    org = await db.organizations.find_one({"slug": slug}, {"_id": 0})
    if not org:
        raise HTTPException(404, f"Provider not found: {slug}")
    clusters = body.get("clusters") or org.get("clusters") or list(DEFAULT_CLUSTERS)
    placed = await _bootstrap_bids(db, slug, clusters)
    return {"ok": True, "providerSlug": slug, "seededBids": placed}
