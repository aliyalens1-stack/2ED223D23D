"""
Sprint Customer-Notify-2 — pytest via HTTP endpoints.

Verifies the dry-run audit pipeline end-to-end through the live FastAPI
server (matches the existing test infrastructure in conftest.py — no
direct DB access in the test process):

  • POST /api/admin/customer-notify/preview  — synthesizer
  • POST /api/admin/customer-notify/project  — manual trigger
  • GET  /api/admin/customer-notify/audit    — audit listing

Invariants covered:
  • dry-run discipline (dryRun=True, sentAt=None on every row)
  • forbidden-route guard at all three entry points
  • allowlist filter (only 4 kinds produce audit rows)
  • idempotency (re-projecting same event = no new rows)
  • channel-shape rules (sms title=null, push/email title required)
  • lang resolution (unknown lang → 'de' fallback)
"""
from __future__ import annotations

import uuid

import httpx
import pytest

from tests.conftest import BACKEND_URL


# ──────────────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_headers() -> dict:
    """Reuse the cached admin login from conftest."""
    from tests.conftest import _ensure_admin_login
    body = _ensure_admin_login()
    return {"Authorization": f"Bearer {body['accessToken']}"}


# ──────────────────────────────────────────────────────────────────────
# Preview endpoint — pure synthesizer, no DB write
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "kind,lang,deep_link",
    [
        ("inspection.started",     "en", "continuity"),
        ("inspection.started",     "de", "continuity"),
        ("inspection.started",     "ru", "continuity"),
        ("report.submitted",       "en", "report-cognition"),
        ("report.submitted",       "de", "report-cognition"),
        ("item.flagged_critical",  "en", "timeline"),
        ("item.flagged_warning",   "ru", "timeline"),
    ],
)
@pytest.mark.asyncio
async def test_preview_all_three_channels(admin_headers, kind, lang, deep_link):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": kind, "lang": lang},
            headers=admin_headers,
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["allowed"] is True
    assert data["forbiddenRoute"] is False
    assert set(data["channels"].keys()) == {"push", "email", "sms"}
    for ch in ("push", "email", "sms"):
        p = data["channels"][ch]
        assert p is not None
        assert p["deepLink"] == deep_link
        assert isinstance(p["body"], str) and p["body"]
        if ch == "sms":
            assert p["title"] is None, f"sms title leak: {p}"
        else:
            assert isinstance(p["title"], str) and p["title"]


@pytest.mark.parametrize(
    "kind",
    [
        "ocr.vin_detected",
        "ocr.odometer_detected",
        "correlation.spatial_anomaly",
        "evidence.gaps_overridden",
        "internal.audit.replay",
        "suspicion.vin_mismatch",
    ],
)
@pytest.mark.asyncio
async def test_preview_forbidden_routes(admin_headers, kind):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": kind, "lang": "en"},
            headers=admin_headers,
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["forbiddenRoute"] is True
    assert data["allowed"] is False
    for ch in ("push", "email", "sms"):
        assert data["channels"][ch] is None, f"FORBIDDEN LEAK on {ch} for {kind}"


@pytest.mark.asyncio
async def test_preview_non_allowlisted(admin_headers):
    """Event-allowlisted kinds (media.uploaded.vin) that aren't on the
    notification allowlist produce no payloads on any channel."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "media.uploaded.vin", "lang": "en"},
            headers=admin_headers,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["forbiddenRoute"] is False
    assert data["allowed"] is False
    for ch in ("push", "email", "sms"):
        assert data["channels"][ch] is None


@pytest.mark.asyncio
async def test_preview_unknown_lang_fallback(admin_headers):
    """Unknown language tags (fr-FR, ja, etc.) → graceful normalisation
    to DE default. Endpoint returns 200 with the resolved language so
    admin can see what the user would actually receive."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "inspection.started", "lang": "fr-FR"},
            headers=admin_headers,
        )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["lang"] == "de", f"expected 'de' fallback, got {data['lang']!r}"
    assert data["channels"]["push"] is not None
    assert data["channels"]["email"] is not None
    assert data["channels"]["sms"] is not None


# ──────────────────────────────────────────────────────────────────────
# Sprint Customer-Deep-Link-1 — semantic destination kernel
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_preview_includes_deep_link_payload(admin_headers):
    """Preview now returns a transport-independent deepLink payload
    in addition to per-channel renders."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "inspection.started", "lang": "en"},
            headers=admin_headers,
        )
    assert r.status_code == 200
    dl = r.json()["deepLink"]
    assert dl is not None
    assert dl["surface"] == "continuity"
    assert dl["routes"]["mobile"] == "/customer/inspection/preview-job/continuity"
    assert dl["routes"]["web"] == "/customer/inspection/preview-job/continuity"


@pytest.mark.asyncio
async def test_preview_timeline_focus_token_for_flagged(admin_headers):
    """item.flagged_* events resolve to timeline surface; the synthetic
    itemId binds to ?focus=… in both mobile and web routes."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "item.flagged_critical", "lang": "en"},
            headers=admin_headers,
        )
    dl = r.json()["deepLink"]
    assert dl["surface"] == "timeline"
    assert "focus=preview-item" in dl["routes"]["mobile"]
    assert "focus=preview-item" in dl["routes"]["web"]


@pytest.mark.asyncio
async def test_preview_forbidden_route_has_no_deep_link(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "ocr.vin_detected", "lang": "en"},
            headers=admin_headers,
        )
    data = r.json()
    assert data["forbiddenRoute"] is True
    assert data["deepLink"] is None


@pytest.mark.asyncio
async def test_meta_exposes_deep_link_kernel(admin_headers):
    """Meta endpoint surfaces the deep-link table for the admin UI legend."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.get("/api/admin/customer-notify/meta", headers=admin_headers)
    data = r.json()
    dl = data.get("deepLink")
    assert dl is not None
    assert set(dl["surfaces"]) == {"continuity", "timeline", "report-cognition"}
    assert dl["eventToSurface"]["inspection.started"] == "continuity"
    assert dl["eventToSurface"]["report.submitted"] == "report-cognition"
    assert dl["eventToSurface"]["item.flagged_critical"] == "timeline"
    assert dl["eventToSurface"]["item.flagged_warning"] == "timeline"
    assert dl["routes"]["continuity"]["mobile"].endswith("/continuity")
    assert dl["routes"]["report-cognition"]["web"].endswith("/cognition")


@pytest.mark.asyncio
async def test_preview_requires_admin_auth():
    """Endpoint must reject unauthenticated calls."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"kind": "inspection.started", "lang": "en"},
        )
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_preview_validates_kind(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/preview",
            json={"lang": "en"},  # missing kind
            headers=admin_headers,
        )
    assert r.status_code == 400


# ──────────────────────────────────────────────────────────────────────
# Manual project endpoint — writes audit rows
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_project_unresolved_recipient(admin_headers):
    """Allowed kind but no resolvable jobId → soft fail, no rows."""
    eid = "n2pytest-" + uuid.uuid4().hex
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/project",
            json={"event": {
                "id": eid,
                "kind": "inspection.started",
                "metadata": {"jobId": "nonexistent-zzz"},
            }},
            headers=admin_headers,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["reason"] == "no_recipient"


@pytest.mark.asyncio
async def test_project_forbidden_route(admin_headers):
    """Forbidden routes are dropped at routing stage, no audit row."""
    eid = "n2pytest-" + uuid.uuid4().hex
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/project",
            json={"event": {
                "id": eid,
                "kind": "ocr.vin_detected",
                "metadata": {"jobId": "any"},
            }},
            headers=admin_headers,
        )
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is False
    assert data["reason"] == "forbidden_route"

    # Verify no audit row was created
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        list_r = await c.get(
            "/api/admin/customer-notify/audit",
            params={"limit": 10},
            headers=admin_headers,
        )
    items = list_r.json()["items"]
    leaked = [i for i in items if i.get("sourceTimelineId") == eid]
    assert not leaked, f"FORBIDDEN LEAK in audit: {leaked}"


@pytest.mark.asyncio
async def test_project_non_allowlisted(admin_headers):
    eid = "n2pytest-" + uuid.uuid4().hex
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.post(
            "/api/admin/customer-notify/project",
            json={"event": {
                "id": eid,
                "kind": "media.uploaded.vin",
                "metadata": {"jobId": "x"},
            }},
            headers=admin_headers,
        )
    assert r.status_code == 200
    assert r.json()["reason"] == "not_allowlisted"


# ──────────────────────────────────────────────────────────────────────
# Audit listing endpoint
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_audit_listing_shape(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.get(
            "/api/admin/customer-notify/audit",
            params={"limit": 5},
            headers=admin_headers,
        )
    assert r.status_code == 200
    data = r.json()
    assert "items" in data
    assert "total" in data
    assert "serverTime" in data
    assert isinstance(data["items"], list)
    # Every item (if any) must obey dry-run invariants
    for item in data["items"]:
        assert item.get("dryRun") is True, f"Non-dry-run row leaked: {item}"
        assert item.get("sentAt") is None, f"sentAt populated in Notify-2: {item}"
        assert item.get("channel") in {"push", "email", "sms"}
        assert item.get("kind") in {
            "inspection.started", "report.submitted",
            "item.flagged_critical", "item.flagged_warning",
        }
        if item["channel"] == "sms":
            assert item.get("title") is None


@pytest.mark.asyncio
async def test_audit_filter_by_kind(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.get(
            "/api/admin/customer-notify/audit",
            params={"kind": "inspection.started", "limit": 50},
            headers=admin_headers,
        )
    assert r.status_code == 200
    for item in r.json()["items"]:
        assert item["kind"] == "inspection.started"


@pytest.mark.asyncio
async def test_audit_filter_by_channel(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.get(
            "/api/admin/customer-notify/audit",
            params={"channel": "sms", "limit": 50},
            headers=admin_headers,
        )
    assert r.status_code == 200
    for item in r.json()["items"]:
        assert item["channel"] == "sms"
        assert item["title"] is None


@pytest.mark.asyncio
async def test_audit_rejects_bad_channel(admin_headers):
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        r = await c.get(
            "/api/admin/customer-notify/audit",
            params={"channel": "telegram"},
            headers=admin_headers,
        )
    assert r.status_code == 400


# ──────────────────────────────────────────────────────────────────────
# End-to-end pipeline via timeline writer + idempotency
# ──────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_e2e_pipeline_with_seeded_request(admin_headers):
    """Seed an auto_request with a customerId, manually trigger the
    pipeline, then verify (a) 3 audit rows were written for the right
    recipient and (b) re-running the same projection is a no-op."""
    # Create a seed auto_request via the admin debug surface if available;
    # if not, we approximate by using an existing seeded customer.
    # Step 1: find an existing auto_request with inspectionJobs[*].id
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        list_r = await c.get(
            "/api/admin/inspector-jobs",
            params={"limit": 5},
            headers=admin_headers,
        )
        if list_r.status_code != 200:
            pytest.skip(f"admin inspector-jobs not available: {list_r.status_code}")
        jobs = list_r.json().get("items") or list_r.json()
        if not jobs:
            pytest.skip("no seeded inspector jobs to drive pipeline test")
        job = jobs[0] if isinstance(jobs, list) else None
        if not job:
            pytest.skip("unexpected admin inspector-jobs shape")
        job_id = job.get("id") or job.get("jobId")
        if not job_id:
            pytest.skip("no jobId in seeded job")

    eid_base = "n2-e2e-" + uuid.uuid4().hex
    payload = {
        "event": {
            "id": eid_base,
            "kind": "report.submitted",
            "metadata": {"jobId": job_id},
        }
    }
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
        first = await c.post(
            "/api/admin/customer-notify/project",
            json=payload,
            headers=admin_headers,
        )
        first_data = first.json()
        if first_data.get("reason") == "no_recipient":
            pytest.skip("seeded job has no customer wired up — environment-dependent")
        assert first_data["ok"] is True
        assert first_data["inserted"] == 3, first_data
        assert set(first_data["channels"]) == {"push", "email", "sms"}

        # Verify audit rows visible
        list2 = await c.get(
            "/api/admin/customer-notify/audit",
            params={"limit": 50, "kind": "report.submitted"},
            headers=admin_headers,
        )
        items = list2.json()["items"]
        ours = [i for i in items if i.get("sourceTimelineId") == eid_base]
        assert len(ours) == 3
        channels = {i["channel"] for i in ours}
        assert channels == {"push", "email", "sms"}
        recipient_ids = {i["recipientUserId"] for i in ours}
        assert len(recipient_ids) == 1, "single recipient expected"
        for row in ours:
            assert row["dryRun"] is True
            assert row["sentAt"] is None

        # Idempotency: replay same event
        second = await c.post(
            "/api/admin/customer-notify/project",
            json=payload,
            headers=admin_headers,
        )
        second_data = second.json()
        assert second_data["ok"] is True
        assert second_data["inserted"] == 0, (
            f"idempotency broken: replay inserted {second_data['inserted']} rows"
        )
