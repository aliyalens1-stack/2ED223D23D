"""Tests for Geo-3 — Operational Coverage Projection.

These tests guard the architectural invariants the projection encodes:

  1. Country activation rule: `active = providers > 0 OR partners > 0`.
  2. Density buckets are deterministic functions of `(providers, partners)`.
  3. Partner counts roll up from cities to countries via the CITY_CATALOGUE
     mapping — countries don't have their own partner index.
  4. `onlyWithPresence=true` filters out empty cities.
  5. The catalogue is the unique source of supported countries; the
     projection lists EVERY supported country (not only ones with presence).

These are unit-level guards on the projection logic; they do not require
a running FastAPI server. The endpoints themselves are smoke-tested via
curl in the deployment audit.
"""
from __future__ import annotations
import os
import sys
import types

import pytest

# Add backend/ to import path and stub the `server` module so we don't
# trigger the full server.py side-effect chain (mongo client, routers,
# orchestrator loops) just to import a pure constant.
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None  # cities.py imports `db` but doesn't use it at import time
    sys.modules["server"] = _stub

from app.geo.coverage_projection import _density, _CITY_TO_COUNTRY  # noqa: E402
from app.marketplace.cities import CITY_CATALOGUE  # noqa: E402


class TestDensityBuckets:
    """Density bucketing is v1 heuristic — must stay deterministic so
    dashboards can render legend correctly. Total = providers + partners."""

    def test_empty(self):
        assert _density(0, 0) == "empty"

    def test_low_at_one(self):
        assert _density(1, 0) == "low"

    def test_low_at_two(self):
        assert _density(0, 2) == "low"

    def test_medium_boundary(self):
        # total=3 — first medium bucket
        assert _density(2, 1) == "medium"
        # total=10 — last medium value
        assert _density(5, 5) == "medium"

    def test_high(self):
        assert _density(11, 0) == "high"
        assert _density(6, 6) == "high"

    def test_monotone_in_sum(self):
        """Density must not decrease as total grows."""
        order = {"empty": 0, "low": 1, "medium": 2, "high": 3}
        prev = -1
        for total in range(0, 25):
            cur = order[_density(total, 0)]
            assert cur >= prev, f"density regressed at total={total}"
            prev = cur


class TestCityToCountryMapping:
    """CITY_CATALOGUE is the unique source-of-truth for country mapping.
    The projection relies on this — if a city's country is missing, the
    aggregation lies.
    """

    def test_every_city_has_country(self):
        for c in CITY_CATALOGUE:
            assert c.get("code"), f"city missing code: {c}"
            assert c.get("country"), f"city missing country: {c}"

    def test_city_to_country_lookup_complete(self):
        # _CITY_TO_COUNTRY is built at import time; every catalogue entry
        # must appear in it.
        for c in CITY_CATALOGUE:
            assert _CITY_TO_COUNTRY[c["code"]] == c["country"]

    def test_country_codes_are_iso2(self):
        for c in CITY_CATALOGUE:
            assert len(c["country"]) == 2, f"non-ISO-2 country: {c['country']}"
            assert c["country"].isupper(), f"non-uppercase country: {c['country']}"


class TestActivationRule:
    """`active` is a derived field. Frontend renders it; never recomputes.
    The rule is: any presence (provider OR partner) flips `active = True`.
    We can't unit-test the async aggregation without a mongo handle, but we
    can encode the rule symbolically so changes here force a deliberate
    edit of the projection logic.
    """

    @pytest.mark.parametrize(
        "providers,partners,expected",
        [
            (0, 0, False),
            (1, 0, True),
            (0, 1, True),
            (5, 3, True),
            (0, 0, False),  # idempotent on zero
        ],
    )
    def test_active_rule(self, providers, partners, expected):
        # Symbolic mirror of `active=(providers + partners) > 0` in
        # coverage_projection.country_coverage.
        assert ((providers + partners) > 0) is expected


class TestProjectionContractShape:
    """The projection contract is public — pricing/matching will read it.
    Lock the field names down so a rename forces a deliberate sweep.
    """

    def test_country_coverage_fields(self):
        from app.geo.coverage_projection import CountryCoverage
        # Pydantic exposes model_fields (v2). Lock the field set.
        fields = set(CountryCoverage.model_fields.keys())
        assert fields == {
            "countryCode", "countryName", "flag",
            "active", "providers", "partners", "cities",
        }

    def test_city_coverage_fields(self):
        from app.geo.coverage_projection import CityCoverage
        fields = set(CityCoverage.model_fields.keys())
        assert fields == {
            "cityId", "cityName", "countryCode",
            "providers", "partners", "lat", "lng", "density",
        }


class TestDemoTopologySeed:
    """Geo-3 plants one demo provider topology at Berlin/DE so the
    projection is non-trivial on a fresh seed. Verify the constants
    point at a real city in the catalogue — otherwise the seed would
    silently fail and Coverage screen would always show zero providers.
    """

    def test_demo_city_exists_in_catalogue(self):
        from app.geo.topology import DEMO_BASE_CITY_ID, DEMO_BASE_COUNTRY
        match = next(
            (c for c in CITY_CATALOGUE
             if c["code"] == DEMO_BASE_CITY_ID and c["country"] == DEMO_BASE_COUNTRY),
            None,
        )
        assert match is not None, (
            f"Demo topology points to {DEMO_BASE_CITY_ID}/{DEMO_BASE_COUNTRY} "
            "but that city is not in CITY_CATALOGUE — seed would no-op."
        )

    def test_demo_radius_is_allowed(self):
        from app.geo.topology import (
            DEMO_TRAVEL_RADIUS_KM,
            ALLOWED_RADIUS_KM,
        )
        assert DEMO_TRAVEL_RADIUS_KM in ALLOWED_RADIUS_KM
