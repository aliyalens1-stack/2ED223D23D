"""Step 11D-α — additive publication of `canonical` envelope at
`/api/inspection/report/generate`.

This pass adds the full `ListingParseResult` Pydantic dump to the
response under the top-level `canonical` key. Surfaces will migrate
off the legacy `car.*` mirror in 11D-β; the mirror itself is removed
in 11D-γ. These tests pin the *additive* contract — they do NOT
check that legacy mirror is gone (it's still there, intentionally).

Coverage:
  1. Manual-only mode (no URL) → `canonical: None`.
  2. Hard-fail URL (not_a_listing) → canonical.ok=False, frozen 18 keys,
     degradedReason mirrors parseMeta.
  3. Soft-fail URL (HTTP 4xx) → canonical.ok=False, soft semantics.
  4. Response invariance — legacy `car.*` and `parseMeta` still present
     (back-compat pin until 11D-γ).
  5. Canonical fields surface match the shared TS contract
     (`shared/domain/parsers/canonical.ts`).

Network-touching cases are isolated to the URLs the live parser
already covers in 250-test substrate suite (willhaben category page,
otomoto fake listing). No new fixtures introduced.
"""
from __future__ import annotations
import os
import pytest
import requests


BASE_URL = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")
EP = f"{BASE_URL}/api/inspection/report/generate"

# The 18 canonical keys frozen in Step 10A. Pinned here so any future
# contract drift triggers a test failure at the integration boundary,
# not just at the Pydantic model layer.
CANONICAL_KEYS_FROZEN = {
    "ok",
    "source",
    "sourceUrl",
    "externalId",
    "title",
    "make",
    "model",
    "year",
    "priceEur",
    "mileageKm",
    "location",
    "vin",
    "fuel",
    "transmission",
    "sellerType",
    "images",
    "parseCompleteness",
    "degradedReason",
}


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


class TestCanonicalAdditivePublication:
    def test_manual_only_canonical_is_none(self, api):
        """No URL → parser was not invoked → canonical=None.

        This is the explicit signal to surfaces: "manual mode, fall
        back to user-provided fields". 11D-β surfaces gate on this.
        """
        r = api.post(EP, json={"price": 12000, "mileage": 80000, "year": 2018}, timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "canonical" in body, "11D-α requires top-level `canonical` key in every response"
        assert body["canonical"] is None
        # Legacy mirror still present (back-compat — 11D-γ removes it).
        assert "car" in body
        assert "parseMeta" in body

    def test_hard_fail_url_emits_canonical_envelope(self, api):
        """willhaben search URL → not_a_listing hard-fail.

        The canonical envelope must carry the same degradedReason
        that parseMeta carries — single source of truth, no drift.
        """
        url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?periode=59&AREA_ID=1"
        r = api.post(EP, json={"url": url}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        c = body.get("canonical")
        assert isinstance(c, dict), "canonical must be a dict on URL submission"
        assert set(c.keys()) == CANONICAL_KEYS_FROZEN, (
            f"canonical envelope must expose exactly the 18 frozen keys, "
            f"got: {sorted(c.keys())}"
        )
        assert c["ok"] is False
        assert c["degradedReason"] == "not_a_listing"
        assert c["parseCompleteness"] == "weak"
        assert c["source"] == "willhaben.at"
        assert c["sourceUrl"] == url
        # parseMeta and canonical agree on every shared field.
        meta = body["parseMeta"]
        assert meta["degradedReason"] == c["degradedReason"]
        assert meta["parseCompleteness"] == c["parseCompleteness"]
        assert meta["ok"] == c["ok"]

    def test_soft_fail_url_emits_canonical_envelope(self, api):
        """Fake otomoto listing → HTTP 4xx soft-fail.

        Soft path must produce a usable envelope with degradedReason
        starting with `http_4` (consumed by shared classifier
        `_is_http_status_error`).
        """
        url = "https://www.otomoto.pl/osobowe/oferta/this-does-not-exist-xyz999.html"
        r = api.post(EP, json={"url": url}, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        c = body.get("canonical")
        assert isinstance(c, dict)
        assert set(c.keys()) == CANONICAL_KEYS_FROZEN
        assert c["ok"] is False
        assert c["source"] == "otomoto.pl"
        # HTTP soft-fail — degradedReason matches the http_4xx / http_5xx
        # pattern. We don't pin the exact code because anti-bot CDNs
        # can rotate between 403 / 404 / 429 day to day.
        dr = c["degradedReason"]
        assert isinstance(dr, str) and dr.startswith("http_"), dr
        assert c["parseCompleteness"] == "weak"
        assert body["parseMeta"]["degradedReason"] == dr

    def test_response_shape_back_compat(self, api):
        """Step 11D-γ — top-level `car` legacy mirror REMOVED.

        Only `marketAvg` (downstream `build_report` baseline, not a
        parser substrate field) remains in `car`. All parser-extracted
        vehicle attributes live in `canonical`. `parseMeta` is retained
        per the variant-A γ plan (γ′ may remove it later).
        """
        url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?periode=59&AREA_ID=1"
        r = api.post(EP, json={"url": url}, timeout=30)
        body = r.json()
        # Additive (kept): canonical and operational frames.
        assert "canonical" in body
        assert "report" in body
        assert "pricing" in body
        # γ retains a slim `car` envelope holding ONLY `marketAvg`.
        assert "car" in body
        car = body["car"]
        # marketAvg may be None when no baseline (no make/model parsed)
        # is available — willhaben hard-fail URL extracts neither.
        assert "marketAvg" in car
        # γ — every other legacy field is gone from the wire.
        for removed in (
            "title", "make", "model", "price", "currency", "mileage",
            "year", "fuel", "image", "source", "sourceUrl", "listingId",
        ):
            assert removed not in car, (
                f"γ should have removed car.{removed} — surfaces read "
                f"this from `canonical.*` since 11D-β"
            )
        # parseMeta retained per variant A (γ′ revisit).
        assert "parseMeta" in body

    def test_canonical_fields_use_unit_suffix_names(self, api):
        """Sanity pin: canonical uses `priceEur` / `mileageKm` (units
        embedded in name) — surface migration in 11D-β depends on this.
        """
        url = "https://www.willhaben.at/iad/gebrauchtwagen/auto/gebrauchtwagenboerse?periode=59&AREA_ID=1"
        r = api.post(EP, json={"url": url}, timeout=30)
        c = r.json()["canonical"]
        # These keys MUST exist (with None values is fine — what matters
        # is that the canonical-only shape uses the right names).
        assert "priceEur" in c
        assert "mileageKm" in c
        # Negative pin — legacy unit-less names must NOT leak into canonical.
        assert "price" not in c
        assert "mileage" not in c
        assert "image" not in c  # canonical is `images: []`
        assert "images" in c and isinstance(c["images"], list)
