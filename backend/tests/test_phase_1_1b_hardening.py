"""Phase 1.1B Operational Hardening — backend verification.

Validates fixture data + serializer projections for inspector workspace:
- /api/inspector/jobs/my returns 3 seeded jobs with status mix
  (claimed/inspecting/report_ready) and brief{} projection on each.
- /api/inspector/exposures returns 1 open exposure with preview{} + status.
- Public surfaces still respond (regression).
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
INSPECTOR_EMAIL = "inspector@autoservice.com"
INSPECTOR_PWD = "Inspector123!"


@pytest.fixture(scope="module")
def inspector_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": INSPECTOR_EMAIL, "password": INSPECTOR_PWD},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed {r.status_code}: {r.text[:200]}"
    return r.json().get("accessToken")


@pytest.fixture(scope="module")
def jobs_payload(inspector_token):
    r = requests.get(
        f"{BASE_URL}/api/inspector/jobs/my",
        headers={"Authorization": f"Bearer {inspector_token}"},
        timeout=10,
    )
    assert r.status_code == 200
    return r.json()


# ── Fixtures: 3 jobs with required status mix ─────────────────────────
class TestJobsFixtures:
    def test_three_jobs_returned(self, jobs_payload):
        assert jobs_payload["count"] == 3, f"expected 3 jobs, got {jobs_payload['count']}"
        assert len(jobs_payload["jobs"]) == 3

    def test_status_mix_claimed_inspecting_report_ready(self, jobs_payload):
        statuses = sorted([j["status"] for j in jobs_payload["jobs"]])
        assert statuses == ["claimed", "inspecting", "report_ready"], (
            f"expected ['claimed','inspecting','report_ready'], got {statuses}"
        )

    def test_inspecting_job_is_vw_golf(self, jobs_payload):
        ins = [j for j in jobs_payload["jobs"] if j["status"] == "inspecting"]
        assert len(ins) == 1
        assert ins[0]["brand"] == "VW"
        assert "Golf" in ins[0]["model"]

    def test_report_ready_is_mercedes(self, jobs_payload):
        rr = [j for j in jobs_payload["jobs"] if j["status"] == "report_ready"]
        assert len(rr) == 1
        assert rr[0]["brand"] == "Mercedes"
        assert rr[0].get("hasReport") is True
        assert rr[0].get("reportId")

    def test_claimed_is_audi(self, jobs_payload):
        cl = [j for j in jobs_payload["jobs"] if j["status"] == "claimed"]
        assert len(cl) == 1
        assert cl[0]["brand"] == "Audi"

    def test_brief_field_populated_on_all_jobs(self, jobs_payload):
        """_job_to_dict must passthrough brief{}."""
        for j in jobs_payload["jobs"]:
            assert "brief" in j, f"job {j['id']} missing 'brief'"
            brief = j["brief"]
            assert isinstance(brief, dict)
            for key in ("vehicleSummary", "feeEur", "cityLabel", "customerName", "address"):
                assert key in brief, f"brief.{key} missing on job {j['id']}"
            assert isinstance(brief["feeEur"], int)
            assert brief["vehicleSummary"]
            assert brief["cityLabel"]

    def test_customer_id_and_updated_at_present(self, jobs_payload):
        """_job_to_dict adds customerId + updatedAt passthrough."""
        for j in jobs_payload["jobs"]:
            assert "customerId" in j
            assert "updatedAt" in j


# ── Exposures: 1 open with preview ────────────────────────────────────
class TestExposuresFixture:
    def test_one_exposure_returned(self, inspector_token):
        r = requests.get(
            f"{BASE_URL}/api/inspector/exposures",
            headers={"Authorization": f"Bearer {inspector_token}"},
            timeout=10,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["count"] == 1
        assert len(data["exposures"]) == 1
        exp = data["exposures"][0]
        assert exp["status"] == "open"
        assert "preview" in exp and isinstance(exp["preview"], dict)
        for key in ("serviceLabel", "cityLabel", "vehicleSummary"):
            assert key in exp["preview"]
        assert "BMW" in exp["preview"]["vehicleSummary"]
        assert "createdAt" in exp


# ── Submit endpoint: status transition projection ─────────────────────
class TestSubmitTransition:
    """Verify backend status open→done transitions are projected as
    'report_ready' by _job_to_dict. We don't actually submit (would
    consume the inspecting fixture); we just assert the projection
    works for the existing report_ready job."""
    def test_done_projected_as_report_ready(self, jobs_payload):
        rr = [j for j in jobs_payload["jobs"] if j["status"] == "report_ready"]
        assert len(rr) == 1, "report_ready projection missing"


# ── Public surface regression ─────────────────────────────────────────
class TestPublicSurfaces:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200
        body = r.json()
        # health returns ok + nestjs healthy
        assert "ok" in str(body).lower() or body.get("status") == "ok"

    def test_web_app_landing(self):
        r = requests.get(f"{BASE_URL}/api/web-app/", timeout=10)
        assert r.status_code == 200

    def test_admin_panel_landing(self):
        r = requests.get(f"{BASE_URL}/api/admin-panel/", timeout=10)
        assert r.status_code == 200
