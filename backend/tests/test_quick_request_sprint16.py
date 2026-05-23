"""Sprint 16 — Auto-Pricing (Surge) backend tests.

Validates:
  • POST /api/quick-request/resolve adds surge / surgeLabel / surgeKind / zoneId / zoneName / zoneStatus
  • Each solution has priceFrom (base) and finalPrice (= base * surge)
  • Zone with status BUSY/SURGE/CRITICAL → surge >= 1.2, finalPrice > priceFrom
  • Zone with status BALANCED → surge == 1.0, finalPrice == priceFrom
  • Booking persists basePrice + surge + surgeLabel + surgeKind + finalPrice + zoneId + zoneName
  • Provider inbox surfaces finalPrice / surge / surgeLabel / surgeKind
  • TTL + uniqueness indexes (Mongo)
  • Existing endpoints remain green
  • Race condition (atomic accept) still works
"""
import os
import time
import pytest
import requests
import motor.motor_asyncio
import asyncio

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
TIMEOUT = 30

# Local Mongo — same DB name backend uses
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME   = os.environ.get("DB_NAME", "test_database")

# Coordinates for predictable zones
LOC_CENTER  = {"lat": 50.4501, "lng": 30.5234}   # kyiv-center BUSY (seed surge 1.3)
LOC_OBOLON  = {"lat": 50.5100, "lng": 30.4900}   # kyiv-obolon CRITICAL (seed surge 1.8)
LOC_PODIL   = {"lat": 50.4650, "lng": 30.5150}   # kyiv-podil BALANCED (seed surge 1.0)
LOC_SVIATOSHYN = {"lat": 50.4580, "lng": 30.3700}  # kyiv-sviatoshyn BALANCED (seed surge 1.0)

_state = {}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ─── Existing endpoints regression ───────────────────────────────
class TestExistingEndpoints:
    def test_health(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=TIMEOUT)
        assert r.status_code == 200, r.text

    def test_marketplace_providers(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/providers", timeout=TIMEOUT)
        assert r.status_code == 200, r.text

    def test_marketplace_stats(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/stats", timeout=TIMEOUT)
        assert r.status_code == 200, r.text

    def test_zones(self, session):
        r = session.get(f"{BASE_URL}/api/zones", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        data = r.json()
        zones = data.get("zones", data) if isinstance(data, dict) else data
        assert isinstance(zones, list) and len(zones) >= 1
        z0 = zones[0]
        # Each zone exposes a surgeMultiplier (Sprint 16 requirement)
        assert "surgeMultiplier" in z0


# ─── Surge fields contract ───────────────────────────────────────
class TestResolveSurgeContract:
    def test_resolve_high_demand_zone_returns_surge_fields(self, session):
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "battery dead", "location": LOC_OBOLON},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text
        d = r.json()

        # Zone-level surge envelope
        for k in ("surge", "surgeLabel", "surgeKind", "zoneId", "zoneName", "zoneStatus"):
            assert k in d, f"resolve must return {k}, got keys={list(d.keys())}"
        assert isinstance(d["surge"], (int, float))
        assert isinstance(d["surgeLabel"], str) and d["surgeLabel"]
        assert d["surgeKind"] in ("high", "normal", "low")
        assert d["zoneStatus"] in ("BUSY", "SURGE", "CRITICAL", "BALANCED", "QUIET")

        # Per-solution pricing
        sols = d.get("solutions") or []
        assert len(sols) >= 1
        for s in sols:
            for k in ("priceFrom", "finalPrice", "surge", "surgeLabel", "surgeKind"):
                assert k in s, f"solution missing {k}: {s}"
            assert isinstance(s["priceFrom"], int) and s["priceFrom"] > 0
            assert isinstance(s["finalPrice"], int) and s["finalPrice"] > 0
            # finalPrice = round(priceFrom * surge)
            expected = round(s["priceFrom"] * s["surge"])
            assert abs(s["finalPrice"] - expected) <= 1, (
                f"finalPrice {s['finalPrice']} != round(priceFrom*surge)={expected}"
            )
        _state["high_zone_payload"] = d

    def test_high_demand_zone_surge_gte_1_2(self, session):
        d = _state.get("high_zone_payload")
        assert d is not None, "previous test must run"
        if d["zoneStatus"] in ("BUSY", "SURGE", "CRITICAL"):
            assert d["surge"] >= 1.2, f"high-demand surge expected >=1.2, got {d['surge']}"
            assert d["surgeKind"] == "high"
            for s in d["solutions"]:
                assert s["finalPrice"] > s["priceFrom"], (
                    f"finalPrice {s['finalPrice']} must exceed base {s['priceFrom']} on surge zone"
                )

    def test_balanced_zone_surge_equals_1(self, session):
        # Try Podil first; if engine flipped it, try Sviatoshyn
        for loc in (LOC_PODIL, LOC_SVIATOSHYN):
            r = session.post(
                f"{BASE_URL}/api/quick-request/resolve",
                json={"text": "tire flat", "location": loc},
                timeout=TIMEOUT,
            )
            assert r.status_code == 200, r.text
            d = r.json()
            if d.get("zoneStatus") == "BALANCED" and abs(d["surge"] - 1.0) < 0.05:
                # Validate basePrice == finalPrice for balanced
                for s in d["solutions"]:
                    assert s["finalPrice"] == s["priceFrom"], (
                        f"BALANCED zone: finalPrice {s['finalPrice']} must equal base {s['priceFrom']}"
                    )
                assert d["surgeKind"] == "normal"
                assert "Normal" in d["surgeLabel"] or d["surgeLabel"]
                return
        pytest.skip("No BALANCED zone available — engine has shifted seed surges")

    def test_low_demand_zone_optional(self, session):
        """surge < 1.0 is optional in seed data — don't fail if no zone is in QUIET state."""
        for loc in (LOC_PODIL, LOC_SVIATOSHYN, LOC_CENTER, LOC_OBOLON):
            r = session.post(
                f"{BASE_URL}/api/quick-request/resolve",
                json={"text": "oil change", "location": loc},
                timeout=TIMEOUT,
            )
            d = r.json()
            if d.get("surge", 1.0) < 1.0:
                assert d["surgeKind"] == "low"
                for s in d["solutions"]:
                    assert s["finalPrice"] <= s["priceFrom"], (
                        f"low-demand: finalPrice {s['finalPrice']} should be <= base {s['priceFrom']}"
                    )
                return
        pytest.skip("No QUIET zone in current dataset — feature wired but not exercised")


# ─── Booking snapshot at /accept ─────────────────────────────────
class TestAcceptBookingSnapshot:
    def test_accept_persists_pricing_snapshot(self, session):
        # Create surge request in CRITICAL zone
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "battery dead", "location": LOC_OBOLON},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200
        d = r.json()
        rid = d["requestId"]
        targets = d.get("targetProviders") or []
        if not targets:
            pytest.skip("no providers targeted")
        first = targets[0]

        # Accept by first
        r1 = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/accept",
            json={"providerSlug": first},
            timeout=TIMEOUT,
        )
        assert r1.status_code == 200, r1.text
        a = r1.json()
        assert a.get("success") is True
        booking_id = a.get("bookingId")
        assert booking_id

        # Verify booking via DB (no GET-by-id endpoint exists for QR bookings)
        async def _fetch():
            cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
            doc = await cli[DB_NAME].bookings.find_one({"id": booking_id}, {"_id": 0})
            cli.close()
            return doc
        booking = asyncio.run(_fetch())
        assert booking, f"booking {booking_id} not in DB"
        for k in ("basePrice", "surge", "surgeLabel", "surgeKind", "finalPrice", "zoneId", "zoneName"):
            assert k in booking, f"booking missing pricing field {k}: {list(booking.keys())}"
        assert booking["basePrice"] > 0
        assert booking["finalPrice"] >= booking["basePrice"] if booking["surge"] >= 1 else True
        assert isinstance(booking["surge"], (int, float))
        # Cross-check finalPrice math
        assert abs(booking["finalPrice"] - round(booking["basePrice"] * booking["surge"])) <= 1

        # Race: 2nd accept => 409
        if len(targets) >= 2:
            r2 = session.post(
                f"{BASE_URL}/api/quick-request/{rid}/accept",
                json={"providerSlug": targets[1]},
                timeout=TIMEOUT,
            )
            assert r2.status_code == 409, r2.text


# ─── Provider inbox shows surge ──────────────────────────────────
class TestProviderInboxSurge:
    def test_inbox_returns_surge_fields(self, session):
        r = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "engine misfire", "location": LOC_OBOLON},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200
        d = r.json()
        rid = d["requestId"]
        targets = d.get("targetProviders") or []
        if not targets:
            pytest.skip("no targets")
        slug = targets[0]
        r2 = session.get(f"{BASE_URL}/api/quick-request/inbox/{slug}", timeout=TIMEOUT)
        assert r2.status_code == 200, r2.text
        items = r2.json().get("items", [])
        item = next((it for it in items if it.get("requestId") == rid), None)
        assert item, f"request {rid} not in inbox of {slug}"
        for k in ("priceEstimate", "finalPrice", "surge", "surgeLabel", "surgeKind"):
            assert k in item, f"inbox item missing {k}: {item}"
        assert item["surgeKind"] in ("high", "normal", "low")
        if item["surge"] > 1.0:
            assert item["finalPrice"] > item["priceEstimate"]


# ─── TTL + unique indexes (Mongo) ────────────────────────────────
class TestMongoIndexes:
    def test_quick_requests_ttl_and_unique(self):
        async def _check():
            cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
            db = cli[DB_NAME]
            qr_ix = await db.quick_requests.list_indexes().to_list(50)
            of_ix = await db.quick_request_offers.list_indexes().to_list(50)
            cli.close()
            return qr_ix, of_ix

        qr_ix, of_ix = asyncio.run(_check())

        def _has_ttl(ix_list, key, expire_after):
            for ix in ix_list:
                if dict(ix.get("key", {})).get(key) == 1 and ix.get("expireAfterSeconds") == expire_after:
                    return True
            return False

        def _has_unique(ix_list, key):
            for ix in ix_list:
                if dict(ix.get("key", {})).get(key) == 1 and ix.get("unique") is True:
                    return True
            return False

        assert _has_ttl(qr_ix, "expiresAt", 604800), f"quick_requests missing TTL on expiresAt 7d: {qr_ix}"
        assert _has_ttl(of_ix, "expiresAt", 604800), f"quick_request_offers missing TTL: {of_ix}"
        assert _has_unique(qr_ix, "id"), f"quick_requests.id must be unique: {qr_ix}"
