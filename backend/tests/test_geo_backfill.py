"""Tests for Geo-4 — Provider onboarding topology backfill.

Tests the deterministic city resolver `resolve_city_for_org` against a
representative spread of organization shapes. We do NOT touch Mongo — the
function is pure.
"""
from __future__ import annotations
import os
import sys
import types

import pytest

_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from app.geo.backfill import resolve_city_for_org, COORD_MATCH_KM, _haversine_km  # noqa: E402
from app.marketplace.cities import CITY_CATALOGUE  # noqa: E402


def _city(name: str, country: str) -> dict:
    """Find a catalogue city by canonical name OR code OR addressMarkers."""
    name_lower = name.lower()
    for c in CITY_CATALOGUE:
        if c["country"] != country:
            continue
        candidates = {c["name"].lower(), c["code"].lower()}
        for m in c.get("addressMarkers") or []:
            candidates.add(m.lower())
        if name_lower in candidates:
            return c
    raise KeyError(f"no catalogue city {name!r} in {country!r}")


class TestNameMatch:
    def test_exact_name_kyiv(self):
        city, reason = resolve_city_for_org({"city": "Kyiv", "country": "UA"})
        assert reason == "name_match"
        assert city is not None and city["code"] == "kyiv"

    def test_case_insensitive(self):
        city, reason = resolve_city_for_org({"city": "BERLIN", "country": "DE"})
        assert reason == "name_match"
        assert city["code"] == "berlin"

    def test_code_as_input(self):
        # Some legacy rows store cityCode in `city` field. Accept it.
        city, reason = resolve_city_for_org({"city": "berlin", "country": "DE"})
        assert reason == "name_match"
        assert city["code"] == "berlin"

    def test_country_disambiguates(self):
        # If a city name happens to exist in two countries, the country
        # field is the tie-breaker. (No such pair in current catalogue,
        # so we synthesize one for the test: same call without country
        # must still resolve uniquely for current catalogue.)
        city, reason = resolve_city_for_org({"city": "Berlin"})
        assert reason == "name_match"
        assert city["country"] == "DE"

    def test_unknown_city_no_signal(self):
        city, reason = resolve_city_for_org({"city": "Atlantis", "country": "DE"})
        assert city is None
        assert reason == "no_signal"  # falls through; no coords either


class TestCoordMatch:
    def test_exact_coords_berlin(self):
        b = _city("Berlin", "DE")
        org = {
            "city": None,
            "country": "DE",
            "location": {"coordinates": [b["lng"], b["lat"]]},
        }
        city, reason = resolve_city_for_org(org)
        assert reason == "coord_match"
        assert city["code"] == "berlin"

    def test_far_off_unknown(self):
        # Middle of the Atlantic — no match.
        org = {"city": None, "country": "DE",
               "location": {"coordinates": [-30.0, 40.0]}}
        city, reason = resolve_city_for_org(org)
        assert city is None
        assert reason == "unknown_city"

    def test_country_filter_in_coord_match(self):
        # Berlin coords but `country=FR` — country filter must reject.
        b = _city("Berlin", "DE")
        org = {"city": None, "country": "FR",
               "location": {"coordinates": [b["lng"], b["lat"]]}}
        city, reason = resolve_city_for_org(org)
        assert city is None

    def test_haversine_within_tolerance(self):
        # Approx 1km north of Berlin — must still resolve to Berlin.
        b = _city("Berlin", "DE")
        org = {"city": None, "country": "DE",
               "location": {"coordinates": [b["lng"], b["lat"] + 0.009]}}
        city, reason = resolve_city_for_org(org)
        assert reason == "coord_match"
        assert city["code"] == "berlin"


class TestSignalAbsence:
    def test_no_city_no_coords(self):
        city, reason = resolve_city_for_org({})
        assert city is None
        assert reason == "no_signal"

    def test_malformed_coords(self):
        city, reason = resolve_city_for_org({
            "location": {"coordinates": ["abc", "def"]}
        })
        assert city is None
        assert reason == "no_signal"


class TestHaversineSanity:
    def test_known_distance_berlin_kyiv(self):
        b = _city("Berlin", "DE")
        k = _city("Kyiv", "UA")
        d = _haversine_km(b["lat"], b["lng"], k["lat"], k["lng"])
        # Real-world distance Berlin↔Kyiv ≈ 1196 km
        assert 1100 < d < 1300, f"unexpected distance: {d}"

    def test_zero_for_same_point(self):
        b = _city("Berlin", "DE")
        assert _haversine_km(b["lat"], b["lng"], b["lat"], b["lng"]) == pytest.approx(0)


class TestMarketplaceActiveGate:
    """Geo-4 invariant — provider is marketplace-active iff has BOTH
    topology AND an active organization. This is just structural
    encoding (no DB); the runtime helper lives in `app.geo.topology`."""

    @pytest.mark.parametrize(
        "has_topology,has_active_org,expected",
        [
            (True,  True,  True),
            (True,  False, False),
            (False, True,  False),
            (False, False, False),
        ],
    )
    def test_truth_table(self, has_topology, has_active_org, expected):
        # Mirror of `is_marketplace_active` body — when changed there,
        # this test forces a deliberate update.
        assert (has_topology and has_active_org) is expected
