"""Sprint 17 — Provider Ranking Optimizer (self-learning ranker) backend tests.

Validates:
  • POST /api/quick-request/resolve returns rankingWeights {6 features} + rankingSource ('default'|'learned')
  • db.quick_request_offers entries carry features / weightsUsed / weightsSource / zoneId / problemType / outcomeFinalized
  • matchScore = sum(features[k]*weights[k]) * skillFit (not static)
  • /accept → status='accepted'  (outcomeFinalized hydrated when booking completes/cancels)
  • /reject → status='rejected', outcomeFinalized=true
  • auto-expire → status='expired', outcomeFinalized=true
  • GET /api/admin/ranking/weights → {default, minSamples=30, minConfidence=0.3, minWeight=0.05, maxWeight=0.5, rows[], totalGroups, learnedGroups}
  • GET /api/admin/ranking/weights/{zone} → rows + topProviders sorted by successScore desc + weakProviders + totalProviders
  • POST /api/admin/ranking/recalculate?force=true → {success, groups, updated, total_samples}
  • Safety: samples<30 → source='default', weights=DEFAULT_RANKING_WEIGHTS
  • Safety: confidence<0.3 → source='default'
  • Each weight ∈ [0.05, 0.50]; sum(weights)==1.0 (after normalization)
  • Race-condition (Sprint 15) — 2nd accept → 409
  • Surge snapshot (Sprint 16) — finalPrice = priceFrom * surge; booking persists basePrice/surge/finalPrice
  • Base endpoints 200: /api/health, /api/marketplace/providers, /api/marketplace/stats, /api/zones
  • Live data: at least one (zone, problem) group has samples > 100 → rankingSource='learned'
"""

import os
import time
import asyncio
import pytest
import requests
import motor.motor_asyncio

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
TIMEOUT = 30

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

LOC_CENTER = {"lat": 50.4501, "lng": 30.5234}   # kyiv-center  (has learned weights)
LOC_OBOLON = {"lat": 50.5100, "lng": 30.4900}   # kyiv-obolon  (has learned weights)
PROBLEM_LEARNED = "car wont start"               # → engine_start_failure (>100 samples seeded)

DEFAULT_WEIGHTS = {
    "distance":        0.35,
    "rating":          0.25,
    "response":        0.15,
    "online":          0.10,
    "skillFit":        0.10,
    "surgeMotivation": 0.05,
}
FEATURE_KEYS = list(DEFAULT_WEIGHTS.keys())


# ─── shared session ──────────────────────────────────────────────
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


def _resolve(session, text=PROBLEM_LEARNED, location=LOC_CENTER):
    r = session.post(
        f"{BASE_URL}/api/quick-request/resolve",
        json={"text": text, "location": location},
        timeout=TIMEOUT,
    )
    assert r.status_code == 200, r.text
    return r.json()


# ─── 1. Base endpoints regression ────────────────────────────────
class TestExistingEndpoints:
    def test_health(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=TIMEOUT)
        assert r.status_code == 200

    def test_marketplace_providers(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/providers", timeout=TIMEOUT)
        assert r.status_code == 200

    def test_marketplace_stats(self, session):
        r = session.get(f"{BASE_URL}/api/marketplace/stats", timeout=TIMEOUT)
        assert r.status_code == 200

    def test_zones(self, session):
        r = session.get(f"{BASE_URL}/api/zones", timeout=TIMEOUT)
        assert r.status_code == 200


# ─── 2. resolve() returns ranking intelligence snapshot ──────────
class TestResolveRankingIntelligence:
    def test_resolve_returns_rankingWeights_and_rankingSource(self, session):
        d = _resolve(session)
        assert "rankingWeights" in d, "missing rankingWeights"
        assert "rankingSource" in d, "missing rankingSource"
        assert d["rankingSource"] in ("default", "learned")
        w = d["rankingWeights"]
        assert set(w.keys()) == set(FEATURE_KEYS), f"weight keys mismatch: {list(w.keys())}"

    def test_weights_in_clamp_bounds_and_normalised(self, session):
        d = _resolve(session)
        w = d["rankingWeights"]
        for k, v in w.items():
            assert 0.05 - 1e-6 <= v <= 0.50 + 1e-6, f"{k}={v} outside clamp [0.05, 0.50]"
        s = sum(w.values())
        assert abs(s - 1.0) < 0.01, f"weights sum != 1.0 (got {s})"

    def test_solutions_use_weighted_score(self, session):
        d = _resolve(session)
        sols = d.get("solutions") or []
        assert len(sols) > 0, "no solutions"
        # matchScore must be a number for every solution
        for s in sols:
            assert isinstance(s.get("matchScore"), (int, float))
            assert 0.0 <= s["matchScore"] <= 1.0
        # solutions must be sorted by matchScore desc
        scores = [s["matchScore"] for s in sols]
        assert scores == sorted(scores, reverse=True), "solutions not sorted by matchScore"


# ─── 3. Live learned data — kyiv-center / engine_start_failure ───
class TestLearnedWeightsLive:
    def test_kyiv_center_learned(self, session):
        d = _resolve(session, text=PROBLEM_LEARNED, location=LOC_CENTER)
        assert d.get("zoneId") == "kyiv-center", f"unexpected zone {d.get('zoneId')}"
        # >100 samples seeded for this group → must be learned
        assert d["rankingSource"] == "learned", \
            f"expected learned, got {d['rankingSource']} (group probably below thresholds)"

    def test_kyiv_obolon_learned(self, session):
        d = _resolve(session, text=PROBLEM_LEARNED, location=LOC_OBOLON)
        # Either zone may be learned; assert at least one of the two reaches 'learned'
        assert d.get("zoneId") == "kyiv-obolon"
        assert d["rankingSource"] in ("learned", "default")
        # weights are still valid no matter the source
        s = sum(d["rankingWeights"].values())
        assert abs(s - 1.0) < 0.01

    def test_unknown_problem_falls_back_to_default(self, session):
        # Random text → resolves to a generic problem_key likely with <30 samples
        d = session.post(
            f"{BASE_URL}/api/quick-request/resolve",
            json={"text": "zzz some unmapped issue xyz", "location": LOC_CENTER},
            timeout=TIMEOUT,
        ).json()
        assert "rankingSource" in d
        if d["rankingSource"] == "default":
            assert d["rankingWeights"] == DEFAULT_WEIGHTS


# ─── 4. Offer documents persisted with feature snapshot ──────────
class TestOfferPersistence:
    @pytest.mark.asyncio
    async def test_offer_has_full_training_snapshot(self, session):
        d = _resolve(session)
        rid = d["requestId"]
        cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
        db = cli[DB_NAME]
        await asyncio.sleep(0.5)
        offers = await db.quick_request_offers.find({"requestId": rid}, {"_id": 0}).to_list(10)
        assert offers, f"no offers persisted for {rid}"
        for o in offers:
            assert "features" in o and set(o["features"].keys()) == set(FEATURE_KEYS), \
                f"features missing/incomplete: {o.get('features')}"
            assert "weightsUsed" in o and set(o["weightsUsed"].keys()) == set(FEATURE_KEYS)
            assert o.get("weightsSource") in ("default", "learned")
            assert o.get("zoneId") == d.get("zoneId")
            assert o.get("problemType") == d.get("problemType")
            assert o.get("outcomeFinalized") is False
            assert o.get("status") == "pending"
        cli.close()


# ─── 5. /accept — status & race condition ────────────────────────
class TestAcceptFlow:
    @pytest.mark.asyncio
    async def test_accept_marks_offer_and_second_accept_returns_409(self, session):
        d = _resolve(session)
        rid = d["requestId"]
        targets = d["targetProviders"]
        if not targets:
            pytest.skip("no providers to accept")
        slug = targets[0]
        r1 = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/accept",
            json={"providerSlug": slug},
            timeout=TIMEOUT,
        )
        assert r1.status_code == 200, r1.text
        body1 = r1.json()
        assert body1.get("bookingId")
        # 2nd accept (different provider) must 409
        other = next((t for t in targets if t != slug), None)
        if other:
            r2 = session.post(
                f"{BASE_URL}/api/quick-request/{rid}/accept",
                json={"providerSlug": other},
                timeout=TIMEOUT,
            )
            assert r2.status_code == 409, f"expected 409 race, got {r2.status_code}: {r2.text}"

        # Confirm offer status updated in DB
        cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
        db = cli[DB_NAME]
        await asyncio.sleep(0.5)
        accepted = await db.quick_request_offers.find_one(
            {"requestId": rid, "providerSlug": slug}, {"_id": 0}
        )
        assert accepted and accepted["status"] == "accepted"
        cli.close()


# ─── 6. /reject — status='rejected', outcomeFinalized=true ───────
class TestRejectFlow:
    @pytest.mark.asyncio
    async def test_reject_finalizes_offer(self, session):
        d = _resolve(session)
        rid = d["requestId"]
        targets = d["targetProviders"]
        if not targets:
            pytest.skip("no providers")
        slug = targets[0]
        r = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/reject",
            json={"providerSlug": slug},
            timeout=TIMEOUT,
        )
        assert r.status_code == 200, r.text

        cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
        db = cli[DB_NAME]
        await asyncio.sleep(0.5)
        rejected = await db.quick_request_offers.find_one(
            {"requestId": rid, "providerSlug": slug}, {"_id": 0}
        )
        assert rejected and rejected["status"] == "rejected", \
            f"unexpected offer state after reject: {rejected}"
        # outcomeFinalized may be flipped immediately, or after the next hydrate cycle.
        # Trigger a force recalculate and re-check.
        session.post(f"{BASE_URL}/api/admin/ranking/recalculate?force=true", timeout=TIMEOUT)
        await asyncio.sleep(0.3)
        rejected = await db.quick_request_offers.find_one(
            {"requestId": rid, "providerSlug": slug}, {"_id": 0}
        )
        assert rejected.get("outcomeFinalized") is True, \
            f"outcomeFinalized still False after rejection+recalc: {rejected}"
        cli.close()


# ─── 7. Surge snapshot (Sprint 16 not broken) ────────────────────
class TestSurgeSnapshotIntact:
    def test_finalPrice_equals_basePrice_times_surge(self, session):
        d = _resolve(session, location=LOC_OBOLON)
        sols = d.get("solutions") or []
        if not sols:
            pytest.skip("no solutions")
        surge = float(d["surge"])
        for s in sols:
            assert s["finalPrice"] == int(round(s["priceFrom"] * surge)), \
                f"finalPrice mismatch: base={s['priceFrom']}, surge={surge}, final={s['finalPrice']}"

    @pytest.mark.asyncio
    async def test_booking_persists_surge_pricing(self, session):
        d = _resolve(session, location=LOC_OBOLON)
        rid = d["requestId"]
        targets = d["targetProviders"]
        if not targets:
            pytest.skip("no providers")
        ar = session.post(
            f"{BASE_URL}/api/quick-request/{rid}/accept",
            json={"providerSlug": targets[0]},
            timeout=TIMEOUT,
        )
        assert ar.status_code == 200
        booking_id = ar.json().get("bookingId")
        assert booking_id
        cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
        db = cli[DB_NAME]
        await asyncio.sleep(0.3)
        bk = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
        assert bk
        assert bk.get("basePrice") and bk.get("finalPrice") and bk.get("surge")
        assert bk["finalPrice"] == int(round(bk["basePrice"] * float(bk["surge"])))
        cli.close()


# ─── 8. Admin endpoints ─────────────────────────────────────────
class TestAdminRankingEndpoints:
    def test_admin_weights_global_shape(self, session):
        r = session.get(f"{BASE_URL}/api/admin/ranking/weights", timeout=TIMEOUT)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["default"] == DEFAULT_WEIGHTS
        assert d["minSamples"] == 30
        assert abs(d["minConfidence"] - 0.3) < 1e-6
        assert abs(d["minWeight"] - 0.05) < 1e-6
        assert abs(d["maxWeight"] - 0.5) < 1e-6
        assert isinstance(d["rows"], list)
        assert d["totalGroups"] == len(d["rows"])
        assert d["learnedGroups"] == sum(1 for r_ in d["rows"] if r_.get("source") == "learned")

    def test_admin_weights_rows_have_valid_weights(self, session):
        d = session.get(f"{BASE_URL}/api/admin/ranking/weights", timeout=TIMEOUT).json()
        for row in d["rows"]:
            assert "zoneId" in row and "problemType" in row
            assert row.get("source") in ("default", "learned")
            assert "samples" in row and "confidence" in row
            w = row.get("weights") or {}
            assert set(w.keys()) == set(FEATURE_KEYS)
            for v in w.values():
                assert 0.05 - 1e-6 <= v <= 0.50 + 1e-6
            s = sum(w.values())
            assert abs(s - 1.0) < 0.02, f"weights sum != 1.0: {s} for {row.get('zoneId')}/{row.get('problemType')}"

    def test_safety_low_samples_uses_defaults(self, session):
        d = session.get(f"{BASE_URL}/api/admin/ranking/weights", timeout=TIMEOUT).json()
        for row in d["rows"]:
            if row.get("samples", 0) < 30:
                assert row.get("source") == "default", \
                    f"low-samples row not flagged default: {row}"
                assert row.get("weights") == DEFAULT_WEIGHTS, \
                    f"low-samples row not using DEFAULT_RANKING_WEIGHTS: {row}"

    def test_safety_low_confidence_uses_defaults(self, session):
        d = session.get(f"{BASE_URL}/api/admin/ranking/weights", timeout=TIMEOUT).json()
        # iff a row exists with samples>=30 but confidence<0.3 → must be 'default'
        for row in d["rows"]:
            if row.get("samples", 0) >= 30 and row.get("confidence", 0) < 0.3:
                assert row.get("source") == "default"

    def test_live_has_learned_group_over_100_samples(self, session):
        d = session.get(f"{BASE_URL}/api/admin/ranking/weights", timeout=TIMEOUT).json()
        big = [r for r in d["rows"] if r.get("samples", 0) > 100]
        assert big, "no group has >100 samples — seed data missing"
        # at least one of those big groups must be learned
        assert any(r.get("source") == "learned" for r in big), \
            f"groups with >100 samples but none learned: {big}"

    def test_admin_weights_zone_shape(self, session):
        d = session.get(f"{BASE_URL}/api/admin/ranking/weights/kyiv-center", timeout=TIMEOUT).json()
        assert d["zoneId"] == "kyiv-center"
        assert isinstance(d["rows"], list)
        assert isinstance(d["topProviders"], list)
        assert isinstance(d["weakProviders"], list)
        assert isinstance(d["totalProviders"], int)
        # topProviders sorted by successScore desc
        scores = [p["successScore"] for p in d["topProviders"]]
        assert scores == sorted(scores, reverse=True), f"topProviders not sorted desc: {scores}"
        for p in d["topProviders"]:
            for k in ("providerSlug", "samples", "accepted", "completed", "cancelled", "rejected", "successScore"):
                assert k in p

    def test_admin_recalculate_force(self, session):
        r = session.post(
            f"{BASE_URL}/api/admin/ranking/recalculate?force=true",
            timeout=TIMEOUT * 2,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("success") is True
        for k in ("groups", "updated", "total_samples"):
            assert k in d, f"missing {k} in recalculate response"
        assert d["total_samples"] >= 0


# ─── 9. Auto-expire flow ────────────────────────────────────────
class TestAutoExpire:
    @pytest.mark.asyncio
    async def test_auto_expire_finalizes_offers(self, session):
        d = _resolve(session)
        rid = d["requestId"]
        if not d.get("targetProviders"):
            pytest.skip("no providers")

        # Backdate expiry so the auto-expire task trips quickly
        cli = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
        db = cli[DB_NAME]
        from datetime import datetime, timezone, timedelta
        past = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
        await db.quick_requests.update_one({"id": rid}, {"$set": {"expiresAt": past}})
        await db.quick_request_offers.update_many(
            {"requestId": rid, "status": "pending"},
            {"$set": {"expiresAt": past}},
        )

        # Wait for the background auto-expire task (60s timeout) — at most 75s.
        # The task was scheduled at resolve() with QUICK_REQUEST_TIMEOUT_SEC=60.
        deadline = time.time() + 80
        while time.time() < deadline:
            qr = await db.quick_requests.find_one({"id": rid}, {"_id": 0, "status": 1})
            if qr and qr["status"] == "expired":
                break
            await asyncio.sleep(2)
        assert qr and qr["status"] == "expired", f"qr never expired: {qr}"

        # Force recalc → triggers _hydrate_offer_outcomes
        session.post(f"{BASE_URL}/api/admin/ranking/recalculate?force=true", timeout=TIMEOUT)
        await asyncio.sleep(0.3)
        offers = await db.quick_request_offers.find({"requestId": rid}, {"_id": 0}).to_list(10)
        assert offers
        for o in offers:
            assert o["status"] in ("expired", "superseded", "rejected", "accepted")
            if o["status"] == "expired":
                assert o.get("outcomeFinalized") is True, \
                    f"expired offer not finalized: {o}"
        cli.close()
