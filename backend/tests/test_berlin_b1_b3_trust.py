"""Berlin Launch B1 (new fields) + B3 (Trust Layer) — backend integration tests.

Covers:
  - B1: action-oriented decision mapping (inspect / negotiate only, never buy/avoid)
  - B1: decisionLabel DE copy
  - B1: similarVehiclesCount ∈ [500, 4200]
  - B1: roiHint DE string with "€149" + "sparen" or "Gewissheit"
  - B3: /api/marketplace/providers returns trustProfile per provider
  - B3: berlin-auto-check (inspector, tuv) has tuvVerified=True & boost >= 1.20
  - B3: boost math rules (tuv×1.20, years≥10×1.10, reviews≥50×1.05)
  - B3: chips ("TÜV geprüft" when tuvVerified, "Verifiziert" when isVerified & !tuv)
  - B3: finalScore relative ordering — TÜV provider ranks above non-TÜV peer
  - Regression: /api/health, admin login, /api/parse/car-link
"""
from __future__ import annotations
import os
import sys
import pytest
import requests

sys.path.insert(0, "/app/backend")
from app.marketplace.trust import compute_trust_profile  # noqa: E402

BASE_URL = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")
EP_REPORT = f"{BASE_URL}/api/inspection/report/generate"
EP_PROVIDERS = f"{BASE_URL}/api/marketplace/providers"
ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


@pytest.fixture(scope="session")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ════════════════════════════════════════════════════════════════════
# Regression
# ════════════════════════════════════════════════════════════════════
class TestRegression:
    def test_health(self, api):
        r = api.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200

    def test_admin_login(self, api):
        r = api.post(f"{BASE_URL}/api/auth/login",
                     json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=10)
        assert r.status_code == 200
        d = r.json()
        token = d.get("accessToken") or d.get("token") or (d.get("data") or {}).get("token")
        assert token and len(token) > 20

    def test_parse_car_link(self, api):
        r = api.post(f"{BASE_URL}/api/parse/car-link",
                     json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=1"},
                     timeout=20)
        assert r.status_code in (200, 422)


# ════════════════════════════════════════════════════════════════════
# B1 — Action-oriented decision + new fields
# ════════════════════════════════════════════════════════════════════
class TestB1Decision:
    def test_high_risk_is_inspect_not_avoid(self, api):
        r = api.post(EP_REPORT, json={"price": 3500, "mileage": 230000, "year": 2010, "fuel": "diesel"}, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["decision"] in ("inspect", "negotiate")
        assert rep["decision"] != "avoid"
        assert rep["decision"] != "buy"
        lbl = rep["decisionLabel"].lower()
        assert ("prüfen" in lbl) or ("verhandeln" in lbl)
        # HIGH risk specifically per spec
        assert rep["risk"] == "high"
        assert rep["decision"] == "inspect"
        assert rep["decisionLabel"] == "Vor dem Kauf unbedingt prüfen"

    def test_low_risk_is_inspect_with_friendly_label(self, api):
        r = api.post(EP_REPORT, json={"price": 25000, "mileage": 40000, "year": 2023, "fuel": "petrol"}, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["risk"] == "low"
        assert rep["decision"] == "inspect"
        assert rep["decisionLabel"] == "Vor dem Kauf prüfen lassen"

    def test_medium_risk_is_negotiate(self, api):
        r = api.post(EP_REPORT, json={"price": 12000, "mileage": 160000, "year": 2015}, timeout=15)
        assert r.status_code == 200
        rep = r.json()["report"]
        assert rep["risk"] == "medium"
        assert rep["decision"] == "negotiate"
        assert "verhandeln" in rep["decisionLabel"].lower()

    def test_summary_never_discourages(self, api):
        for payload in [
            {"price": 3500, "mileage": 230000, "year": 2010, "fuel": "diesel"},
            {"price": 25000, "mileage": 40000, "year": 2023, "fuel": "petrol"},
            {"price": 12000, "mileage": 160000, "year": 2015},
        ]:
            r = api.post(EP_REPORT, json=payload, timeout=15)
            assert r.status_code == 200
            rep = r.json()["report"]
            s = rep["summary"].lower()
            # Must not include hard-discouragement phrases
            assert "nicht kaufen" not in s
            assert "finger weg" not in s


class TestB1NewFields:
    @pytest.mark.parametrize("payload", [
        {"price": 3500, "mileage": 230000, "year": 2010, "fuel": "diesel"},
        {"price": 25000, "mileage": 40000, "year": 2023, "fuel": "petrol"},
        {"price": 12000, "mileage": 160000, "year": 2015},
    ])
    def test_similar_vehicles_count_in_range(self, api, payload):
        r = api.post(EP_REPORT, json=payload, timeout=15)
        rep = r.json()["report"]
        n = rep["similarVehiclesCount"]
        assert isinstance(n, int)
        assert 500 <= n <= 4200, f"similarVehiclesCount={n} out of [500,4200]"

    @pytest.mark.parametrize("payload", [
        {"price": 3500, "mileage": 230000, "year": 2010, "fuel": "diesel"},
        {"price": 25000, "mileage": 40000, "year": 2023, "fuel": "petrol"},
        {"price": 12000, "mileage": 160000, "year": 2015},
    ])
    def test_roi_hint_content(self, api, payload):
        r = api.post(EP_REPORT, json=payload, timeout=15)
        rep = r.json()["report"]
        hint = rep["roiHint"]
        assert isinstance(hint, str) and len(hint) > 0
        assert "€149" in hint
        assert ("sparen" in hint.lower()) or ("gewissheit" in hint.lower())


# ════════════════════════════════════════════════════════════════════
# B3 — Trust Layer
# ════════════════════════════════════════════════════════════════════
class TestB3TrustProfile:
    @pytest.fixture(scope="class")
    def providers_list(self, api):
        r = api.get(f"{EP_PROVIDERS}?lat=52.52&lng=13.405&limit=40", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "providers" in data
        assert isinstance(data["providers"], list)
        assert len(data["providers"]) > 0, "no providers returned"
        return data["providers"]

    def test_every_provider_has_trust_profile(self, providers_list):
        for p in providers_list:
            assert "trustProfile" in p, p.get("slug")
            tp = p["trustProfile"]
            assert isinstance(tp["tuvVerified"], bool)
            assert isinstance(tp["yearsExperience"], int)
            assert isinstance(tp["vehiclesInspected"], int)
            assert isinstance(tp["reviewsCount"], int)
            assert isinstance(tp["boostFactor"], float)
            assert tp["boostFactor"] >= 1.0
            assert isinstance(tp["chips"], list)

    def test_berlin_auto_check_is_tuv_verified(self, providers_list):
        match = [p for p in providers_list if p.get("slug") == "berlin-auto-check"]
        assert match, "seeded provider 'berlin-auto-check' not found"
        tp = match[0]["trustProfile"]
        assert tp["tuvVerified"] is True
        assert tp["boostFactor"] >= 1.20
        chip_keys = [c.get("key") for c in tp["chips"]]
        assert "tuv" in chip_keys
        tuv_chip = next(c for c in tp["chips"] if c["key"] == "tuv")
        assert tuv_chip["label"] == "TÜV geprüft"

    def test_boost_math_matches_rules(self, providers_list):
        """Verify boostFactor = 1.0 * (1.2 if tuv) * (1.1 if years>=10) * (1.05 if reviews>=50)."""
        for p in providers_list:
            tp = p["trustProfile"]
            expected = 1.0
            if tp["tuvVerified"]:
                expected *= 1.20
            if tp["yearsExperience"] >= 10:
                expected *= 1.10
            if tp["reviewsCount"] >= 50:
                expected *= 1.05
            expected = round(expected, 3)
            assert abs(tp["boostFactor"] - expected) < 1e-6, \
                f"{p.get('slug')}: boost={tp['boostFactor']} expected={expected} tp={tp}"

    def test_reviews_50_multiplier_applies(self, providers_list):
        """For any provider where tuv & years≥10 are the same, reviews≥50 must add ×1.05."""
        found_50 = [p for p in providers_list if p["trustProfile"]["reviewsCount"] >= 50]
        assert found_50, "expected at least one provider with reviewsCount>=50 in seed"
        for p in found_50:
            tp = p["trustProfile"]
            without_reviews = 1.0
            if tp["tuvVerified"]:
                without_reviews *= 1.20
            if tp["yearsExperience"] >= 10:
                without_reviews *= 1.10
            # boost = without_reviews * 1.05
            assert abs(tp["boostFactor"] - round(without_reviews * 1.05, 3)) < 1e-6

    def test_chips_contain_tuv_or_verified(self, providers_list):
        for p in providers_list:
            tp = p["trustProfile"]
            chip_keys = [c.get("key") for c in tp["chips"]]
            if tp["tuvVerified"]:
                assert "tuv" in chip_keys, f"{p.get('slug')} tuv missing chip"
            elif p.get("isVerified"):
                assert "verified" in chip_keys, f"{p.get('slug')} isVerified but no 'Verifiziert' chip: chips={tp['chips']}"

    def test_final_score_applies_trust_boost(self, providers_list):
        """finalScore ≈ baseScore × boostFactor (ignoring pre-engagement/promo multipliers)."""
        # providers in response have baseScore + finalScore
        # At least verify final > base when boost > 1.0
        for p in providers_list:
            base = p.get("baseScore")
            final = p.get("finalScore")
            boost = p["trustProfile"]["boostFactor"]
            assert base is not None and final is not None
            if boost > 1.0 and not p.get("isPromoted") and not p.get("preEngageBoosted"):
                assert final > base, f"{p.get('slug')}: final={final} base={base} boost={boost}"

    def test_tuv_provider_outranks_similar_non_tuv(self, api):
        """Sanity: TÜV provider's finalScore > any non-TÜV peer with same-or-better baseScore."""
        r = api.get(f"{EP_PROVIDERS}?lat=52.52&lng=13.405&limit=50", timeout=15)
        data = r.json()
        providers = data["providers"]
        tuv_list = [p for p in providers if p["trustProfile"]["tuvVerified"]]
        non_tuv = [p for p in providers if not p["trustProfile"]["tuvVerified"]]
        if not tuv_list or not non_tuv:
            pytest.skip("not both cohorts present")
        best_tuv = max(tuv_list, key=lambda x: x["finalScore"])
        # find non-tuv with closest baseScore that's <= best_tuv baseScore
        peers = [p for p in non_tuv if p["baseScore"] <= best_tuv["baseScore"] + 0.01]
        if peers:
            best_peer = max(peers, key=lambda x: x["finalScore"])
            assert best_tuv["finalScore"] > best_peer["finalScore"], \
                f"TÜV {best_tuv['slug']} finalScore={best_tuv['finalScore']} not > non-TÜV {best_peer['slug']} finalScore={best_peer['finalScore']}"


# ════════════════════════════════════════════════════════════════════
# B3 — compute_trust_profile() unit tests
# ════════════════════════════════════════════════════════════════════
class TestB3TrustUnit:
    def test_tuv_badge_sets_verified_and_boost(self):
        tp = compute_trust_profile({"badges": ["tuv"], "yearsExperience": 3, "reviewsCount": 5})
        assert tp["tuvVerified"] is True
        assert tp["boostFactor"] == 1.2

    def test_inspector_verified_implies_tuv(self):
        tp = compute_trust_profile({"providerType": "inspector", "isVerified": True, "reviewsCount": 0})
        assert tp["tuvVerified"] is True

    def test_all_three_multipliers(self):
        tp = compute_trust_profile({"badges": ["tuv"], "yearsExperience": 12, "reviewsCount": 80})
        # 1.2 * 1.1 * 1.05 = 1.386
        assert abs(tp["boostFactor"] - 1.386) < 1e-3

    def test_years_10_multiplier(self):
        tp = compute_trust_profile({"yearsExperience": 10, "reviewsCount": 0})
        assert tp["boostFactor"] == 1.1
        assert tp["tuvVerified"] is False

    def test_reviews_50_multiplier_alone(self):
        tp = compute_trust_profile({"yearsExperience": 3, "reviewsCount": 50})
        assert tp["boostFactor"] == 1.05

    def test_no_flags_baseline(self):
        tp = compute_trust_profile({"yearsExperience": 2, "reviewsCount": 0})
        assert tp["boostFactor"] == 1.0
        assert tp["chips"] == []

    def test_verified_only_chip(self):
        tp = compute_trust_profile({"isVerified": True, "yearsExperience": 3, "reviewsCount": 0})
        keys = [c["key"] for c in tp["chips"]]
        assert "verified" in keys
        assert "tuv" not in keys

    def test_chip_tuv_label_de(self):
        tp = compute_trust_profile({"badges": ["tuv"]})
        tuv = next(c for c in tp["chips"] if c["key"] == "tuv")
        assert tuv["label"] == "TÜV geprüft"
        assert tuv["tone"] == "gold"
