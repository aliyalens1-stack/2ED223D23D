"""Sprint 2 · Step 5 — Offline Queue (R2) backend tests.

Coverage:
  • POST /api/inspector/offline-replay/log — auth, persistence, validation
  • Indexes on offline_replay_log present (via lifespan)
  • GET /api/admin/offline-replay/recent — admin-only, KPIs, filters
  • Idempotency middleware coverage on /api/inspector/jobs/:id/{draft,report}
  • Regression: /api/health, admin login
"""
from __future__ import annotations

import os
import uuid
import time

import pytest
import requests


BASE_URL = os.environ.get(
    "BACKEND_URL",
    "https://platform-mobile-hub.preview.emergentagent.com",
).rstrip("/")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


# ──────────────────────────────────────────────────────────────
# Fixtures
# ──────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin_token(session: requests.Session) -> str:
    r = session.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=20,
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    body = r.json()
    token = body.get("accessToken") or body.get("token")
    assert token, f"no token in response: {body}"
    return token


# ──────────────────────────────────────────────────────────────
# Regressions
# ──────────────────────────────────────────────────────────────
class TestRegressions:
    def test_health_ok(self, session):
        r = session.get(f"{BASE_URL}/api/health", timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") == "ok"
        assert body.get("db") == "connected"

    def test_admin_login_works(self, admin_token):
        assert isinstance(admin_token, str) and len(admin_token) > 20


# ──────────────────────────────────────────────────────────────
# POST /api/inspector/offline-replay/log
# ──────────────────────────────────────────────────────────────
class TestOfflineReplayLog:
    URL = f"{BASE_URL}/api/inspector/offline-replay/log"

    def _payload(self, **overrides):
        body = {
            "queueId": f"TEST_q_{uuid.uuid4().hex[:10]}",
            "kind": "media_upload",
            "jobId": f"TEST_job_{uuid.uuid4().hex[:10]}",
            "attempts": 2,
            "result": "success",
            "latencyMs": 1234,
        }
        body.update(overrides)
        return body

    def test_no_auth_returns_401(self, session):
        r = session.post(self.URL, json=self._payload(), timeout=15)
        assert r.status_code == 401, f"expected 401 without auth, got {r.status_code} {r.text[:200]}"

    def test_with_any_bearer_returns_200(self, session):
        # spec: even stale tokens land
        r = session.post(
            self.URL,
            json=self._payload(),
            headers={"Authorization": "Bearer stale-or-fake-token-xyz"},
            timeout=15,
        )
        assert r.status_code == 200, f"got {r.status_code} {r.text[:200]}"
        assert r.json().get("ok") is True

    def test_with_admin_token_writes_record(self, session, admin_token):
        job_id = f"TEST_replay_job_{uuid.uuid4().hex[:8]}"
        payload = self._payload(jobId=job_id, kind="report_submit", result="failed", attempts=3, latencyMs=5678)
        r = session.post(
            self.URL,
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        assert r.status_code == 200
        assert r.json().get("ok") is True

        # Verify persistence via admin GET filtered by jobId
        time.sleep(0.3)
        rg = session.get(
            f"{BASE_URL}/api/admin/offline-replay/recent",
            params={"jobId": job_id},
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        assert rg.status_code == 200, rg.text[:200]
        data = rg.json()
        items = data.get("items", [])
        assert len(items) >= 1, f"expected record persisted for {job_id}; got {data}"
        item = items[0]
        assert item["jobId"] == job_id
        assert item["kind"] == "report_submit"
        assert item["result"] == "failed"
        assert item["attempts"] == 3
        assert item["latencyMs"] == 5678
        assert "createdAt" in item
        assert "_id" not in item  # mongo _id excluded

    def test_invalid_kind_coerced_to_unknown(self, session, admin_token):
        job_id = f"TEST_unknownkind_{uuid.uuid4().hex[:8]}"
        r = session.post(
            self.URL,
            json=self._payload(jobId=job_id, kind="garbage_kind", result="success"),
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        # endpoint is lenient — should still succeed; "kind" gets coerced
        assert r.status_code == 200
        time.sleep(0.2)
        rg = session.get(
            f"{BASE_URL}/api/admin/offline-replay/recent",
            params={"jobId": job_id},
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        assert rg.status_code == 200
        items = rg.json().get("items", [])
        assert len(items) >= 1
        assert items[0]["kind"] == "unknown"


# ──────────────────────────────────────────────────────────────
# GET /api/admin/offline-replay/recent
# ──────────────────────────────────────────────────────────────
class TestAdminRecentReplays:
    URL = f"{BASE_URL}/api/admin/offline-replay/recent"

    def test_requires_admin_no_auth(self, session):
        r = session.get(self.URL, timeout=15)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_admin_can_list(self, session, admin_token):
        r = session.get(
            self.URL,
            headers={"Authorization": f"Bearer {admin_token}"},
            params={"limit": 20},
            timeout=15,
        )
        assert r.status_code == 200, r.text[:200]
        data = r.json()
        assert "items" in data
        assert "counts" in data
        assert {"total", "success", "failed"}.issubset(data["counts"].keys())
        assert "latencyMs" in data and {"p50", "p95"}.issubset(data["latencyMs"].keys())
        assert isinstance(data["items"], list)
        # _id never leaked
        for it in data["items"]:
            assert "_id" not in it

    def test_filter_by_kind(self, session, admin_token):
        # seed two records of different kinds
        log_url = f"{BASE_URL}/api/inspector/offline-replay/log"
        unique_job = f"TEST_filter_{uuid.uuid4().hex[:8]}"
        for kind in ("media_upload", "draft_generate"):
            r = session.post(
                log_url,
                json={
                    "queueId": f"TEST_q_{uuid.uuid4().hex[:6]}",
                    "kind": kind,
                    "jobId": unique_job,
                    "attempts": 1,
                    "result": "success",
                    "latencyMs": 100,
                },
                headers={"Authorization": f"Bearer {admin_token}"},
                timeout=15,
            )
            assert r.status_code == 200
        time.sleep(0.3)
        r = session.get(
            self.URL,
            params={"jobId": unique_job, "kind": "media_upload"},
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=15,
        )
        assert r.status_code == 200
        items = r.json()["items"]
        assert all(it["kind"] == "media_upload" for it in items)
        assert all(it["jobId"] == unique_job for it in items)


# ──────────────────────────────────────────────────────────────
# Indexes via direct Mongo check
# ──────────────────────────────────────────────────────────────
class TestOfflineReplayIndexes:
    def test_indexes_present(self):
        # Read MONGO_URL/DB_NAME from backend .env
        from dotenv import dotenv_values
        env = dotenv_values("/app/backend/.env")
        mongo_url = env.get("MONGO_URL") or os.environ.get("MONGO_URL")
        db_name = env.get("DB_NAME") or os.environ.get("DB_NAME")
        if not mongo_url or not db_name:
            pytest.skip("MONGO_URL/DB_NAME not available")
        from pymongo import MongoClient
        client = MongoClient(mongo_url, serverSelectionTimeoutMS=5000)
        try:
            db = client[db_name]
            idx = db.offline_replay_log.index_information()
            # createdAt desc index
            assert any(
                spec.get("key") == [("createdAt", -1)]
                for spec in idx.values()
            ), f"createdAt desc index missing; have {list(idx.values())}"
            # (jobId, createdAt desc)
            assert any(
                spec.get("key") == [("jobId", 1), ("createdAt", -1)]
                for spec in idx.values()
            ), "jobId+createdAt compound index missing"
            # (kind, result)
            assert any(
                spec.get("key") == [("kind", 1), ("result", 1)]
                for spec in idx.values()
            ), "kind+result compound index missing"
        finally:
            client.close()


# ──────────────────────────────────────────────────────────────
# Idempotency middleware coverage on /api/inspector/jobs/
# ──────────────────────────────────────────────────────────────
class TestIdempotencyOnInspectorJobs:
    """
    The middleware (status-class-aware policy as of Sprint 2 Step 5 hotfix):
      • On 1st POST with Idempotency-Key for a target → inserts in_progress
        placeholder then runs handler. Commit is ALWAYS called:
          - 2xx → cached for 24h
          - 4xx → cached for 90s (short window dedupes frantic re-taps but
                 does not block a legitimate retry once condition changes)
          - 5xx → placeholder is DELETED, retry is unconstrained
      • On 2nd POST with SAME key (any 2xx/4xx) →
          - returns cached response with headers:
                x-idempotent-replay: true
                x-idempotent-status-class: {2xx|4xx}
    """

    def _replay(self, session, url: str, token: str, body: dict):
        key = f"test-idem-{uuid.uuid4().hex}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": key,
            "Content-Type": "application/json",
        }
        r1 = session.post(url, json=body, headers=headers, timeout=20)
        r2 = session.post(url, json=body, headers=headers, timeout=20)
        return r1, r2

    def test_draft_endpoint_idempotent(self, session, admin_token):
        # Non-existent job — backend returns 4xx. Under the new policy the
        # middleware MUST still cache the 4xx (short TTL) and the replay
        # MUST return the cached body + replay headers (NOT a 409).
        fake_id = f"nonexistent-{uuid.uuid4().hex[:10]}"
        url = f"{BASE_URL}/api/inspector/jobs/{fake_id}/draft"
        r1, r2 = self._replay(session, url, admin_token, {"trigger": "manual"})

        # Whether r1 was 2xx or 4xx, the replay must be SAME status + replay headers.
        assert r2.status_code == r1.status_code, (
            f"replay status mismatch: r1={r1.status_code} r2={r2.status_code}"
        )
        assert r2.headers.get("x-idempotent-replay") == "true", (
            f"expected x-idempotent-replay=true; headers={dict(r2.headers)}"
        )
        cls = r2.headers.get("x-idempotent-status-class", "")
        assert cls in ("2xx", "4xx"), f"unexpected status-class header: {cls!r}"
        # Body equality (cached response replay)
        assert r2.text == r1.text or r2.json() == r1.json(), (
            f"replay body diverged from r1: r1={r1.text[:200]} r2={r2.text[:200]}"
        )

    def test_report_endpoint_idempotent(self, session, admin_token):
        fake_id = f"nonexistent-{uuid.uuid4().hex[:10]}"
        url = f"{BASE_URL}/api/inspector/jobs/{fake_id}/report"
        r1, r2 = self._replay(
            session,
            url,
            admin_token,
            {"summary": "TEST_idem_report", "findings": []},
        )
        assert r2.status_code == r1.status_code, (
            f"replay status mismatch: r1={r1.status_code} r2={r2.status_code}"
        )
        assert r2.headers.get("x-idempotent-replay") == "true"
        cls = r2.headers.get("x-idempotent-status-class", "")
        assert cls in ("2xx", "4xx"), f"unexpected status-class header: {cls!r}"

    def test_no_dedupe_without_key(self, session, admin_token):
        """Sanity: without Idempotency-Key, two identical POSTs both run
        through the handler (i.e., neither returns the in_progress 409)."""
        fake_id = f"nonexistent-{uuid.uuid4().hex[:10]}"
        url = f"{BASE_URL}/api/inspector/jobs/{fake_id}/draft"
        headers = {"Authorization": f"Bearer {admin_token}"}
        r1 = session.post(url, json={"trigger": "manual"}, headers=headers, timeout=20)
        r2 = session.post(url, json={"trigger": "manual"}, headers=headers, timeout=20)
        # neither should be a 409 IDEMPOTENCY_IN_PROGRESS
        for r in (r1, r2):
            if r.status_code == 409:
                body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
                assert body.get("code") != "IDEMPOTENCY_IN_PROGRESS"
