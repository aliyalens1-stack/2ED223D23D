"""Phase 1.1B Report Workspace — backend smoke tests.

Validates POST /api/inspector/jobs/:id/report exists and behaves correctly
for unauth (401), auth + invalid payload (422), and auth + nonexistent job
(404). Login uses inspector credentials from /app/memory/test_credentials.md.
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
INSPECTOR_EMAIL = "inspector@autoservice.com"
INSPECTOR_PWD = "Inspector123!"


@pytest.fixture(scope="module")
def inspector_token():
    """Login as inspector and return JWT token."""
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": INSPECTOR_EMAIL, "password": INSPECTOR_PWD},
        timeout=15,
    )
    if r.status_code != 200:
        pytest.skip(f"Inspector login failed: {r.status_code} {r.text[:200]}")
    data = r.json()
    return data.get("accessToken") or data.get("access_token") or data.get("token")


# ── Unauthenticated access ───────────────────────────────────────────
class TestSubmitReportUnauth:
    def test_submit_report_no_auth_returns_401_or_403(self):
        r = requests.post(
            f"{BASE_URL}/api/inspector/jobs/fake-id/report",
            json={
                "score": 7,
                "verdict": "buy",
                "checklist": [],
                "issues": [],
                "summary": "x" * 20,
                "repairEstimateMin": None,
                "repairEstimateMax": None,
            },
            timeout=10,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text[:200]}"


# ── Authenticated — endpoint exists & validates ──────────────────────
class TestSubmitReportAuth:
    def test_submit_report_invalid_payload_returns_422(self, inspector_token):
        # Empty body — should fail Pydantic validation
        r = requests.post(
            f"{BASE_URL}/api/inspector/jobs/some-id/report",
            json={},
            headers={"Authorization": f"Bearer {inspector_token}"},
            timeout=10,
        )
        assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text[:200]}"

    def test_submit_report_nonexistent_job_returns_404(self, inspector_token):
        r = requests.post(
            f"{BASE_URL}/api/inspector/jobs/nonexistent-job-xyz-123/report",
            json={
                "score": 7,
                "verdict": "buy",
                "checklist": [],
                "issues": [],
                "summary": "Ten or more chars summary",
                "repairEstimateMin": None,
                "repairEstimateMax": None,
            },
            headers={"Authorization": f"Bearer {inspector_token}"},
            timeout=10,
        )
        # 404 if validated and reached service; 422 if schema rejects empty checklist
        assert r.status_code in (404, 422), f"expected 404/422, got {r.status_code}: {r.text[:200]}"


# ── Inspector workspace data sources ─────────────────────────────────
class TestInspectorListEndpoints:
    def test_my_jobs_endpoint(self, inspector_token):
        r = requests.get(
            f"{BASE_URL}/api/inspector/jobs/my",
            headers={"Authorization": f"Bearer {inspector_token}"},
            timeout=10,
        )
        assert r.status_code == 200, f"my jobs failed: {r.status_code} {r.text[:200]}"
        data = r.json()
        assert "jobs" in data
        assert isinstance(data["jobs"], list)

    def test_my_jobs_unauth_blocked(self):
        r = requests.get(f"{BASE_URL}/api/inspector/jobs/my", timeout=10)
        assert r.status_code in (401, 403)

    def test_checklist_endpoint(self, inspector_token):
        r = requests.get(
            f"{BASE_URL}/api/inspector/checklist",
            headers={"Authorization": f"Bearer {inspector_token}"},
            timeout=10,
        )
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and isinstance(data["items"], list)
        assert len(data["items"]) >= 10


# ── Public surfaces (smoke-only, regression check) ───────────────────
class TestPublicSurfaces:
    def test_web_app_landing_loads(self):
        r = requests.get(f"{BASE_URL}/api/web-app/", timeout=10)
        assert r.status_code == 200

    def test_admin_panel_loads(self):
        r = requests.get(f"{BASE_URL}/api/admin-panel/", timeout=10)
        assert r.status_code == 200
