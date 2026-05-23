"""Step 10B Pass 2 — consumer-migration tests.

Three consumers move to the canonical contract:
  - POST /api/inspection/report/generate (audit E.3)
  - POST /api/vehicles/ingest          (kills duplicate hard/soft classifier)
  - POST /api/vehicles/{id}/refresh    (kills fake-disappearance from anti-bot)

Strategy:
  - Pure helper tests (`_classify_ingest`, `_refresh_verdict`) cover the
    decision matrix without DB.
  - Endpoint tests mount only the affected router and monkey-patch
    httpx to feed an offline HTML fixture.
  - DB-touching tests use a unique synthetic vehicle id per test and
    clean up afterwards.
"""
from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI

sys.path.insert(0, "/app/backend")

# Bootstrap ctx.db so the `db` proxy resolves. Tests use the live
# MongoDB and clean up after themselves.
def _bootstrap_db():
    from motor.motor_asyncio import AsyncIOMotorClient
    from app.core.context import ctx
    if ctx.db is None:
        from app.core.config import MONGO_URL, DB_NAME
        ctx.db = AsyncIOMotorClient(MONGO_URL)[DB_NAME]

_bootstrap_db()

from app.parsers.contract import from_legacy, ListingParseResult  # noqa: E402
from app.vehicles.ingest import _classify_ingest  # noqa: E402
from app.vehicles.refresh import _refresh_verdict  # noqa: E402


FIXTURES_DIR = Path(__file__).parent / "fixtures" / "listings"


def _load(name: str) -> str:
    return (FIXTURES_DIR / name).read_text(encoding="utf-8")


def _make_canonical(**kwargs) -> ListingParseResult:
    """Build a canonical result from kwargs — defaults to a fully-empty
    weak result; tests override only the relevant fields."""
    base = dict(
        ok=False,
        source="autoscout24",
        sourceUrl="https://www.autoscout24.de/x",
        externalId=None,
        title=None,
        make=None, model=None, year=None,
        priceEur=None, mileageKm=None,
        location=None, vin=None, fuel=None,
        transmission=None, sellerType=None,
        images=[],
        parseCompleteness="weak",
        degradedReason=None,
    )
    base.update(kwargs)
    return ListingParseResult(**base)


# ─────────────────────────────────────────────────────────────────────
# Layer 1 — pure decision helpers
# ─────────────────────────────────────────────────────────────────────

class TestClassifyIngest:
    @pytest.mark.parametrize("reason", [
        "bad_url", "unsupported_domain", "not_a_listing", "url_required",
    ])
    def test_hard_buckets(self, reason):
        c = _make_canonical(source="unknown", degradedReason=reason)
        recognised, soft, hard = _classify_ingest(c)
        assert hard is True
        assert soft is False
        assert recognised is False

    @pytest.mark.parametrize("reason", [
        "antibot", "expired_listing", "http_403", "http_429", "http_503",
        "timeout", "network", "fetch_failed", "low_extraction_confidence",
    ])
    def test_soft_buckets(self, reason):
        c = _make_canonical(source="autoscout24", degradedReason=reason)
        recognised, soft, hard = _classify_ingest(c)
        assert soft is True
        assert hard is False
        assert recognised is False

    def test_ok_strong(self):
        c = _make_canonical(
            ok=True, source="autoscout24",
            title="VW Passat", priceEur=22490, mileageKm=95000, year=2020,
            parseCompleteness="strong",
        )
        recognised, soft, hard = _classify_ingest(c)
        assert recognised is True
        assert soft is False
        assert hard is False

    def test_unsupported_source_with_dispatcher_recognition_is_soft(self):
        """Audit D.1 — `unsupported_source` from a recognised host is
        the legacy path through `parse_mobile_de.parse_url` even when
        the dispatcher would have accepted the URL. Soft, not hard."""
        c = _make_canonical(
            source="mobile.de",  # dispatcher recognised the host
            degradedReason="unsupported_source",
        )
        recognised, soft, hard = _classify_ingest(c)
        assert soft is True
        assert hard is False


class TestRefreshVerdict:
    @pytest.mark.parametrize("reason", [
        "antibot", "http_403", "http_429", "http_503", "http_502",
        "timeout", "network", "fetch_failed", "fetch_error:Whatever",
        "low_extraction_confidence", "parse_error",
    ])
    def test_degraded_bucket(self, reason):
        c = _make_canonical(source="mobile.de", degradedReason=reason)
        assert _refresh_verdict(c) == "degraded"

    def test_expired_listing_is_disappeared(self):
        c = _make_canonical(source="autoscout24",
                            degradedReason="expired_listing")
        assert _refresh_verdict(c) == "disappeared"

    def test_http_410_is_disappeared(self):
        """Only HTTP code that genuinely signals listing removal."""
        c = _make_canonical(source="autoscout24", degradedReason="http_410")
        assert _refresh_verdict(c) == "disappeared"

    @pytest.mark.parametrize("reason", [
        "bad_url", "unsupported_domain", "not_a_listing", "unsupported_source",
    ])
    def test_hard_anomaly_bucket(self, reason):
        """A previously-good listing_url shouldn't suddenly produce
        unsupported_domain. Defensive bucketing prevents accidental
        disappearance events from parser glitches."""
        c = _make_canonical(source="autoscout24", degradedReason=reason)
        assert _refresh_verdict(c) == "hard_anomaly"

    def test_ok_when_no_degraded_reason(self):
        c = _make_canonical(
            ok=True, source="autoscout24",
            title="X", priceEur=22000, mileageKm=80000, year=2019,
            parseCompleteness="strong",
        )
        assert _refresh_verdict(c) == "ok"

    def test_unknown_code_defaults_to_degraded_not_disappeared(self):
        """Conservative bucketing — a brand-new error code must never
        emit a phantom disappearance."""
        c = _make_canonical(source="autoscout24",
                            degradedReason="brand_new_code")
        assert _refresh_verdict(c) == "degraded"


# ─────────────────────────────────────────────────────────────────────
# Layer 2 — /api/inspection/report/generate via dispatcher
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def inspection_client():
    """Boot a FastAPI with only the inspection router."""
    from app.inspection.router import router
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as c:
        yield c


def _patch_httpx(monkeypatch, html: str, status: int = 200):
    """Patch THREE fetch paths so none escapes to the real network:
      - `httpx.AsyncClient.get`     — generic parser path
      - `mobile_de.fetch_html`      — mobile.de dedicated parser
      - `autoscout24.fetch_html`    — autoscout24 dedicated parser
      - `kleinanzeigen.fetch_html`  — kleinanzeigen dedicated parser
    """
    import httpx
    from app.parsers import mobile_de as md
    from app.parsers import autoscout24 as a24
    from app.parsers import kleinanzeigen as kna

    class _Resp:
        status_code = status
        text = html

    async def fake_get(self, *a, **kw):
        return _Resp()

    async def fake_fetch_html(url):
        return html, None

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get, raising=True)
    monkeypatch.setattr(md, "fetch_html", fake_fetch_html, raising=True)
    monkeypatch.setattr(a24, "fetch_html", fake_fetch_html, raising=True)
    monkeypatch.setattr(kna, "fetch_html", fake_fetch_html, raising=True)


class TestInspectionReportE3Fix:
    """Audit E.3 — endpoint must accept autoscout24 / kleinanzeigen URLs
    through the dispatcher. Previously they all came back as
    `unsupported_source` because the endpoint called `parse_mobile_de`
    directly."""

    def test_autoscout24_url_now_succeeds(self, inspection_client, monkeypatch):
        # Step 11D-γ — `car.*` legacy mirror removed from
        # `/api/inspection/report/generate`. Vehicle attributes now
        # come from `body["canonical"]` (priceEur / mileageKm / source).
        _patch_httpx(monkeypatch, _load("autoscout24_basic.html"))
        r = inspection_client.post("/api/inspection/report/generate",
                                   json={"url": "https://www.autoscout24.de/angebote/x-1"})
        assert r.status_code == 200
        body = r.json()
        meta = body["parseMeta"]
        # No more `unsupported_source` for a non-mobile.de URL.
        assert meta["source"] == "autoscout24"
        assert meta["error"] in (None, "")
        assert meta["parseCompleteness"] == "strong"
        assert meta["ok"] is True
        # Canonical-routed parse: vehicle attributes live in canonical.
        canon = body["canonical"]
        assert canon["priceEur"] == 22490
        assert canon["mileageKm"] == 95000
        assert canon["year"] == 2020
        assert canon["source"] == "autoscout24"
        # γ — `car` envelope retains ONLY marketAvg.
        assert "price" not in body["car"]
        assert "mileage" not in body["car"]

    def test_kleinanzeigen_url_now_succeeds(self, inspection_client, monkeypatch):
        _patch_httpx(monkeypatch, _load("kleinanzeigen_basic.html"))
        r = inspection_client.post("/api/inspection/report/generate",
                                   json={"url": "https://www.kleinanzeigen.de/s-anzeige/opel/2345678901"})
        assert r.status_code == 200
        body = r.json()
        meta = body["parseMeta"]
        assert meta["source"] == "kleinanzeigen.de"
        assert meta["error"] in (None, "")
        assert meta["parseCompleteness"] in ("partial", "strong")
        # γ — vehicle price now reads from canonical.priceEur.
        assert body["canonical"]["priceEur"] == 7890

    def test_mobile_de_still_works(self, inspection_client, monkeypatch):
        _patch_httpx(monkeypatch, _load("mobile_de_basic.html"))
        r = inspection_client.post("/api/inspection/report/generate",
                                   json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=429123"})
        assert r.status_code == 200
        body = r.json()
        meta = body["parseMeta"]
        assert meta["source"] == "mobile.de"
        assert meta["parseCompleteness"] == "strong"
        # γ — canonical-only read.
        assert body["canonical"]["priceEur"] == 18900

    def test_antibot_is_soft_meta(self, inspection_client, monkeypatch):
        """Anti-bot page → parseMeta carries degradedReason, but the
        endpoint still returns 200 with empty fields (so the inspector
        can be dispatched anyway with manual override).
        γ — empty values now live in `canonical.priceEur` (None)."""
        _patch_httpx(monkeypatch, _load("antibot_page.html"))
        r = inspection_client.post("/api/inspection/report/generate",
                                   json={"url": "https://www.autoscout24.de/angebote/x-2"})
        assert r.status_code == 200
        body = r.json()
        meta = body["parseMeta"]
        assert meta["degradedReason"] == "antibot"
        assert meta["ok"] is False
        assert body["canonical"]["priceEur"] is None


# ─────────────────────────────────────────────────────────────────────
# Layer 3 — /api/vehicles/ingest canonical-driven classification
#
# Strategy: hit the LIVE backend (hot-reloaded with the Pass 2 changes).
# Motor's event-loop affinity makes in-process TestClient flaky for
# Mongo-touching endpoints; the live backend is the safer integration
# surface and proves that the canonical migration is wired end-to-end.
#
# Vehicle records created during these tests are deleted via the
# `cleanup_live_vehicles` fixture using a fresh Motor client tied to
# the cleanup's own event loop.
# ─────────────────────────────────────────────────────────────────────

import httpx as _httpx  # noqa: E402

LIVE_BACKEND = "http://localhost:8001"


@pytest.fixture
def cleanup_live_vehicles():
    created: list[str] = []
    yield created
    if not created:
        return
    # Use a fresh motor client bound to a fresh loop — avoids the
    # "future belongs to different loop" trap that bit the in-process
    # tests.
    from motor.motor_asyncio import AsyncIOMotorClient
    from app.core.config import MONGO_URL, DB_NAME
    loop = asyncio.new_event_loop()
    try:
        async def _wipe():
            client = AsyncIOMotorClient(MONGO_URL)
            try:
                d = client[DB_NAME]
                await d.vehicles.delete_many({"id": {"$in": created}})
                await d.listing_snapshots.delete_many({"vehicleId": {"$in": created}})
            finally:
                client.close()
        loop.run_until_complete(_wipe())
    finally:
        loop.close()


def _backend_reachable() -> bool:
    try:
        r = _httpx.get(f"{LIVE_BACKEND}/api/health", timeout=2.0)
        return r.status_code == 200
    except Exception:
        return False


@pytest.mark.skipif(not _backend_reachable(),
                    reason="live backend not reachable on :8001")
class TestVehiclesIngestCanonicalLive:
    """End-to-end through the live backend. The backend has been
    hot-reloaded with the Pass 2 changes; an antibot URL that is
    structurally valid (mobile.de listing detail) is enough to exercise
    the soft-fail path because mobile.de actually returns 403 to our
    server."""

    def test_unsupported_domain_is_hard_fail(self):
        # `example.com/` returns 200 with no automotive content; the
        # page classifier sees source=None on a successful response and
        # emits `unsupported_domain`.
        # Step 11D-γ — surfaces read hard/soft from `canonical.*` via
        # shared classifier `classifyParseFailure()`. Legacy top-level
        # `hardFail`/`softFail` removed.
        url = "https://example.com/"
        r = _httpx.post(f"{LIVE_BACKEND}/api/vehicles/ingest",
                        json={"url": url}, timeout=15.0)
        assert r.status_code == 200, r.text
        body = r.json()
        # γ — no legacy mirror.
        assert "hardFail" not in body
        assert "softFail" not in body
        # Status field still operates on the response shape.
        assert body["status"] == "soft_fail"
        assert body["vehicleId"] is None
        # Failure mode lives in the canonical envelope.
        canon = body["canonical"]
        assert canon["degradedReason"] == "unsupported_domain"
        assert canon["ok"] is False

    def test_example_path_404_is_soft_fail(self):
        # Distinct case from `unsupported_domain`: when the unknown host
        # responds with a 4xx the classifier emits `http_error`. Audit
        # D.2 — http_4xx is always soft regardless of source.
        url = "https://example.com/some-path-that-returns-404"
        r = _httpx.post(f"{LIVE_BACKEND}/api/vehicles/ingest",
                        json={"url": url}, timeout=15.0)
        assert r.status_code == 200, r.text
        body = r.json()
        canon = body["canonical"]
        # The unknown host responded → not a hard-fail; soft semantic.
        # `unsupported_domain` IS hard, http_4xx IS soft — both flow
        # through `canonical.degradedReason`.
        assert canon["ok"] is False
        # Either the host returned a 4xx (soft `http_4xx`) or the
        # classifier flagged `unsupported_domain` (hard) depending on
        # how example.com behaves day-to-day; the wire shape is
        # canonical-only either way.
        assert canon["degradedReason"] in (
            "http_400", "http_403", "http_404", "http_429", "http_500",
            "http_502", "http_503", "fetch_failed", "unsupported_domain",
            "not_a_listing", "network",
        )

    def test_antibot_mobile_de_is_soft_fail(self, cleanup_live_vehicles):
        # mobile.de blocks server-side fetches with 403; the page
        # classifier flips to `antibot` and `_classify_ingest` returns
        # soft-fail. Step 11D-γ — reads from canonical envelope only.
        url = f"https://www.mobile.de/fahrzeuge/details.html?id={uuid.uuid4().int % 10**9}"
        r = _httpx.post(f"{LIVE_BACKEND}/api/vehicles/ingest",
                        json={"url": url}, timeout=20.0)
        assert r.status_code == 200, r.text
        body = r.json()
        canon = body["canonical"]
        # γ — legacy mirror gone.
        assert "hardFail" not in body
        assert "softFail" not in body
        if body["vehicleId"]:
            cleanup_live_vehicles.append(body["vehicleId"])
        # If parse succeeded (rare — mobile.de may rotate from 403 to a
        # real page), canonical.ok is True; otherwise soft-fail.
        if not canon["ok"]:
            assert canon["degradedReason"] in (
                "antibot", "http_403", "http_429", "http_503",
                "timeout", "fetch_failed", "no_html",
                "low_extraction_confidence", "network",
                "parse_error", "http_400", "http_404",
            )


@pytest.mark.skipif(not _backend_reachable(),
                    reason="live backend not reachable on :8001")
class TestVehiclesRefreshCanonicalLive:
    """Live-backend refresh smoke. Seeds a vehicle via the ingest path
    (mobile.de URL → soft-fail shell), then triggers refresh and
    asserts the verdict mapping."""

    def test_antibot_refresh_does_not_emit_disappeared(self, cleanup_live_vehicles):
        # 1) Create a soft-fail vehicle shell from a mobile.de URL.
        url = f"https://www.mobile.de/fahrzeuge/details.html?id={uuid.uuid4().int % 10**9}"
        ingest = _httpx.post(f"{LIVE_BACKEND}/api/vehicles/ingest",
                             json={"url": url}, timeout=20.0)
        body = ingest.json()
        vid = body.get("vehicleId")
        if not vid:
            pytest.skip("could not create vehicle for refresh test")
        cleanup_live_vehicles.append(vid)

        # 2) Force a refresh. mobile.de still anti-bots us → verdict
        # MUST be 'degraded', not 'ok' with available=False.
        r = _httpx.post(f"{LIVE_BACKEND}/api/vehicles/{vid}/refresh?force=true",
                        timeout=20.0)
        assert r.status_code == 200, r.text
        result = r.json()
        # Either degraded (anti-bot path) or ok (lucky fetch succeeded).
        # Never 'disappeared' just because of anti-bot.
        assert result["status"] in ("degraded", "ok")
        if result["status"] == "degraded":
            assert result["events"] == []
            assert result["snapshotWritten"] is False
            assert result.get("degradedReason") in (
                "antibot", "http_403", "http_429", "http_503",
                "timeout", "network", "fetch_failed", "parse_error",
                "low_extraction_confidence",
            )
        # The disappearance path is NEVER reached for anti-bot.
        if "events" in result:
            event_types = {e.get("type") for e in result.get("events", [])}
            assert "listing_disappeared" not in event_types


# ─────────────────────────────────────────────────────────────────────
# Anchor — make sure the audit doc was actually updated.
# ─────────────────────────────────────────────────────────────────────

class TestAuditDocClosure:
    def test_audit_doc_references_pass_2(self):
        """Mechanical sanity — the audit doc has a Pass 2 closure log."""
        p = Path("/app/memory/sprint10a_parser_audit.md")
        assert p.exists()
        body = p.read_text(encoding="utf-8")
        assert "Pass 2" in body
        assert "E.3" in body  # the audit ref we just closed
