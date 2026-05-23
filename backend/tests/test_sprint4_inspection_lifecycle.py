"""Sprint 4 — Inspection Execution Layer backend tests.

Covers:
- Checklist endpoint shape (13 items + statuses + verdicts)
- Lifecycle transitions (claimed → on_route → arrived → inspecting → done)
- Strict transition gating (409 on wrong source status)
- Inspector ownership (403 on another inspector's job)
- Cancel flow (release to open, credits stay reserved, jobsClaimed decrements)
- Report submission: validation, credit consumption (reserve-1, used+1, balance-1),
  notification, duplicate prevention
- Customer read APIs (own reports + isolation)
- Admin read/approve/reject
- Legacy /complete still works & does NOT consume credit
"""
from __future__ import annotations
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_BACKEND_URL") or os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "http://localhost:8001"
BASE_URL = BASE_URL.rstrip("/")

ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
PROVIDER = {"email": "provider@test.com", "password": "Provider123!"}


def _login(session: requests.Session, creds: dict) -> dict:
    r = session.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"login failed {creds['email']}: {r.status_code} {r.text}"
    d = r.json()
    return {"token": d["accessToken"], "id": d["user"]["id"], "role": d["user"]["role"]}


def _auth(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def admin(session):
    return _login(session, ADMIN)


@pytest.fixture(scope="module")
def customer(session):
    return _login(session, CUSTOMER)


@pytest.fixture(scope="module")
def inspector(session):
    return _login(session, PROVIDER)


@pytest.fixture(scope="module")
def inspector2(session):
    """Register a second provider (needed for 'not your job' tests)."""
    email = f"TEST_insp2_{uuid.uuid4().hex[:8]}@example.com"
    r = session.post(
        f"{BASE_URL}/api/auth/register",
        json={"email": email, "password": "Insp2Pass!", "firstName": "Insp2", "role": "provider_owner"},
        timeout=15,
    )
    assert r.status_code in (200, 201), f"register insp2 failed {r.status_code}: {r.text}"
    d = r.json()
    return {"token": d.get("accessToken"), "id": d.get("user", {}).get("id"), "email": email}


def _grant_credits(session, admin, user_id: str, delta: int, note="test seed"):
    r = session.post(
        f"{BASE_URL}/api/admin/credits/adjust",
        json={"userId": user_id, "delta": delta, "note": note},
        headers=_auth(admin["token"]),
        timeout=15,
    )
    assert r.status_code == 200, f"credits adjust failed: {r.status_code} {r.text}"
    return r.json()


def _create_request(session, customer, city: str, brand="TEST_Brand", model="TEST_Model"):
    r = session.post(
        f"{BASE_URL}/api/customer/requests",
        json={"brand": brand, "model": model, "budget": 10000, "cities": [city], "links": []},
        headers=_auth(customer["token"]),
        timeout=15,
    )
    assert r.status_code == 200, f"create request failed: {r.status_code} {r.text}"
    return r.json()


def _get_jobs_for_request(session, request_id: str) -> list:
    r = session.get(f"{BASE_URL}/api/customer/requests/{request_id}/jobs", timeout=15)
    assert r.status_code == 200, f"get jobs failed: {r.status_code}"
    return r.json().get("jobs", [])


def _claim(session, inspector, job_id: str):
    r = session.post(f"{BASE_URL}/api/inspector/jobs/{job_id}/claim", headers=_auth(inspector["token"]), timeout=15)
    return r


def _balance(session, admin, uid: str) -> dict:
    r = session.get(f"{BASE_URL}/api/admin/credits/{uid}", headers=_auth(admin["token"]), timeout=15)
    assert r.status_code == 200
    return r.json()


# ──────────────────────────────────────────────────────────────────────
# Checklist endpoint
# ──────────────────────────────────────────────────────────────────────
class TestChecklist:
    def test_checklist_shape(self, session):
        r = session.get(f"{BASE_URL}/api/inspector/checklist", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "statuses" in data and "verdicts" in data
        assert len(data["items"]) == 13, f"expected 13 items, got {len(data['items'])}"
        assert set(data["statuses"]) == {"ok", "warning", "problem", "not_checked"}
        assert set(data["verdicts"]) == {"recommended", "risky", "not_recommended"}
        for it in data["items"]:
            assert "key" in it and "group" in it


# ──────────────────────────────────────────────────────────────────────
# Lifecycle + report happy path
# ──────────────────────────────────────────────────────────────────────
class TestLifecycleHappyPath:
    @pytest.fixture(scope="class")
    def ctx(self, session, admin, customer, inspector):
        _grant_credits(session, admin, customer["id"], 3, "TEST_Sprint4")
        city = f"TESTCity_{uuid.uuid4().hex[:6]}"
        req = _create_request(session, customer, city)
        jobs = _get_jobs_for_request(session, req["id"])
        assert len(jobs) == 1
        job = jobs[0]
        bal_before = _balance(session, admin, customer["id"])
        claim_r = _claim(session, inspector, job["id"])
        assert claim_r.status_code == 200, f"claim: {claim_r.text}"
        return {"req": req, "job": job, "city": city, "bal_before": bal_before}

    def test_01_on_route(self, session, inspector, ctx):
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}/on-route",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()["job"]
        assert j["status"] == "on_route"
        assert j.get("onRouteAt")

    def test_02_arrived(self, session, inspector, ctx):
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}/arrived",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()["job"]
        assert j["status"] == "arrived"
        assert j.get("arrivedAt")

    def test_03_start_inspection(self, session, inspector, ctx):
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}/start-inspection",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()["job"]
        assert j["status"] == "inspecting"
        assert j.get("inspectionStartedAt")

    def test_04_submit_report_consumes_credit(self, session, admin, customer, inspector, ctx):
        payload = {
            "score": 8.5,
            "verdict": "recommended",
            "checklist": [
                {"key": "vin", "status": "ok"},
                {"key": "engine", "status": "ok"},
                {"key": "brakes", "status": "warning", "comment": "TEST pads thin"},
                {"key": "body_panels", "status": "ok"},
                {"key": "test_drive", "status": "ok"},
            ],
            "issues": [{"severity": "medium", "title": "TEST brake pads"}],
            "summary": "TEST overall car in good condition with minor issues.",
            "repairEstimateMin": 200,
            "repairEstimateMax": 400,
        }
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}/report",
            json=payload,
            headers=_auth(inspector["token"]),
            timeout=20,
        )
        assert r.status_code == 200, r.text
        rep = r.json()["report"]
        assert rep["verdict"] == "recommended"
        assert rep["status"] == "submitted"
        assert rep["jobId"] == ctx["job"]["id"]
        assert len(rep["checklist"]) == 5
        ctx["report_id"] = rep.get("id") or rep.get("_id")
        assert ctx["report_id"], f"report id missing: {rep}"

        # Small delay for async credit consume (it's awaited but be safe)
        time.sleep(0.3)

        bal_after = _balance(session, admin, customer["id"])
        b = ctx["bal_before"]
        assert bal_after["used"] == b["used"] + 1, f"used expected {b['used']+1}, got {bal_after['used']}"
        assert bal_after["balance"] == b["balance"] - 1
        assert bal_after["reserved"] == b["reserved"] - 1

    def test_05_job_is_done(self, session, inspector, ctx):
        r = session.get(f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}",
                        headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200
        j = r.json()["job"]
        assert j["status"] == "done"
        assert j["reportId"] == ctx["report_id"]
        assert j.get("completedAt")

    def test_06_duplicate_report_409(self, session, inspector, ctx):
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{ctx['job']['id']}/report",
            json={"score": 5.0, "verdict": "risky", "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "TEST duplicate attempt here"},
            headers=_auth(inspector["token"]),
            timeout=15,
        )
        # Job is 'done' now → 409 (either job_not_in_inspecting or report_already_submitted)
        assert r.status_code == 409, f"expected 409, got {r.status_code}: {r.text}"

    def test_07_customer_sees_report(self, session, customer, ctx):
        r = session.get(f"{BASE_URL}/api/customer/reports", headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200
        ids = [x.get("id") or x.get("_id") for x in r.json()["reports"]]
        assert ctx["report_id"] in ids

        r2 = session.get(f"{BASE_URL}/api/customer/reports/{ctx['report_id']}",
                         headers=_auth(customer["token"]), timeout=15)
        assert r2.status_code == 200
        assert r2.json()["report"]["verdict"] == "recommended"

        r3 = session.get(f"{BASE_URL}/api/customer/requests/{ctx['req']['id']}/reports",
                         headers=_auth(customer["token"]), timeout=15)
        assert r3.status_code == 200
        assert r3.json()["count"] >= 1


# ──────────────────────────────────────────────────────────────────────
# Strict lifecycle transitions & ownership
# ──────────────────────────────────────────────────────────────────────
class TestLifecycleStrictness:
    @pytest.fixture(scope="class")
    def fresh_job(self, session, admin, customer, inspector):
        _grant_credits(session, admin, customer["id"], 2, "TEST_strict")
        req = _create_request(session, customer, f"TESTStrict_{uuid.uuid4().hex[:6]}")
        jobs = _get_jobs_for_request(session, req["id"])
        return jobs[0]

    def test_on_route_from_open_409(self, session, inspector, fresh_job):
        # Not claimed yet → on_route should fail (404 job_not_your_job-ish)
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{fresh_job['id']}/on-route",
                         headers=_auth(inspector["token"]), timeout=15)
        # Since inspectorId doesn't match, service returns not_your_job → 403
        # (or job exists but status=open → invalid_status → 409). Either is acceptable.
        assert r.status_code in (403, 409), r.text

    def test_arrived_before_on_route_is_409(self, session, inspector, fresh_job):
        c = _claim(session, inspector, fresh_job["id"])
        assert c.status_code == 200
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{fresh_job['id']}/arrived",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 409, f"expected 409 from claimed→arrived, got {r.status_code}: {r.text}"

    def test_start_inspection_before_arrived_is_409(self, session, inspector, fresh_job):
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{fresh_job['id']}/start-inspection",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 409, r.text

    def test_report_before_inspecting_is_409(self, session, inspector, fresh_job):
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{fresh_job['id']}/report",
            json={"score": 5.0, "verdict": "risky", "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "TEST premature report attempt"},
            headers=_auth(inspector["token"]),
            timeout=15,
        )
        assert r.status_code == 409, r.text

    def test_other_inspector_forbidden(self, session, inspector2, fresh_job):
        if not inspector2["token"]:
            pytest.skip("inspector2 not registered")
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{fresh_job['id']}/on-route",
                         headers=_auth(inspector2["token"]), timeout=15)
        assert r.status_code == 403, f"expected 403, got {r.status_code}: {r.text}"


# ──────────────────────────────────────────────────────────────────────
# Cancel flow
# ──────────────────────────────────────────────────────────────────────
class TestCancel:
    def test_cancel_releases_to_open_and_credits_stay_reserved(self, session, admin, customer, inspector):
        _grant_credits(session, admin, customer["id"], 2, "TEST_cancel")
        req = _create_request(session, customer, f"TESTCancel_{uuid.uuid4().hex[:6]}")
        jobs = _get_jobs_for_request(session, req["id"])
        job = jobs[0]
        bal_before = _balance(session, admin, customer["id"])

        c = _claim(session, inspector, job["id"])
        assert c.status_code == 200

        # Advance to arrived
        assert session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/on-route",
                            headers=_auth(inspector["token"]), timeout=15).status_code == 200
        assert session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/arrived",
                            headers=_auth(inspector["token"]), timeout=15).status_code == 200

        # Cancel
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/cancel",
                         json={"reason": "TEST can't make it"}, headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()["job"]
        assert j["status"] == "open"
        assert j["inspectorId"] in (None, "")

        # jobsClaimed on parent request should be 0
        time.sleep(0.2)
        rr = session.get(f"{BASE_URL}/api/customer/requests/{req['id']}", timeout=15)
        assert rr.status_code == 200
        assert rr.json()["jobsClaimed"] == 0

        # Credits unchanged (still reserved)
        bal_after = _balance(session, admin, customer["id"])
        assert bal_after["used"] == bal_before["used"]
        assert bal_after["balance"] == bal_before["balance"]
        assert bal_after["reserved"] == bal_before["reserved"]


# ──────────────────────────────────────────────────────────────────────
# Report payload validation
# ──────────────────────────────────────────────────────────────────────
class TestReportValidation:
    @pytest.fixture(scope="class")
    def inspecting_job(self, session, admin, customer, inspector):
        _grant_credits(session, admin, customer["id"], 2, "TEST_validation")
        req = _create_request(session, customer, f"TESTVal_{uuid.uuid4().hex[:6]}")
        job = _get_jobs_for_request(session, req["id"])[0]
        _claim(session, inspector, job["id"])
        for t in ("on-route", "arrived", "start-inspection"):
            r = session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/{t}",
                             headers=_auth(inspector["token"]), timeout=15)
            assert r.status_code == 200, f"{t}: {r.text}"
        return job

    def test_invalid_verdict_422(self, session, inspector, inspecting_job):
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{inspecting_job['id']}/report",
            json={"score": 7, "verdict": "great", "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "TEST invalid verdict here"},
            headers=_auth(inspector["token"]),
            timeout=15,
        )
        assert r.status_code == 422, r.text

    def test_unknown_checklist_key_422(self, session, inspector, inspecting_job):
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{inspecting_job['id']}/report",
            json={"score": 7, "verdict": "risky",
                  "checklist": [{"key": "tires_moon", "status": "ok"}],
                  "summary": "TEST bogus checklist key here"},
            headers=_auth(inspector["token"]),
            timeout=15,
        )
        assert r.status_code == 422, r.text

    def test_short_summary_422(self, session, inspector, inspecting_job):
        r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{inspecting_job['id']}/report",
            json={"score": 7, "verdict": "risky",
                  "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "short"},
            headers=_auth(inspector["token"]),
            timeout=15,
        )
        assert r.status_code == 422, r.text


# ──────────────────────────────────────────────────────────────────────
# Customer isolation
# ──────────────────────────────────────────────────────────────────────
class TestCustomerIsolation:
    def test_other_user_cannot_access_report(self, session, admin, customer, inspector, inspector2):
        """Create a report as customer, then try to access as inspector2 (role customer-ish? no, provider).
        Use admin adjust to give inspector2 a customer request would be weird. Instead test that
        inspector2 token (non-owner) gets 403 on customer reports endpoint."""
        if not inspector2["token"]:
            pytest.skip("inspector2 not registered")
        # First create & submit a report as the main customer
        _grant_credits(session, admin, customer["id"], 2, "TEST_isolation")
        req = _create_request(session, customer, f"TESTIso_{uuid.uuid4().hex[:6]}")
        job = _get_jobs_for_request(session, req["id"])[0]
        _claim(session, inspector, job["id"])
        for t in ("on-route", "arrived", "start-inspection"):
            assert session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/{t}",
                                headers=_auth(inspector["token"]), timeout=15).status_code == 200
        rep_r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{job['id']}/report",
            json={"score": 7, "verdict": "risky",
                  "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "TEST isolation scenario report body"},
            headers=_auth(inspector["token"]), timeout=20,
        )
        assert rep_r.status_code == 200, rep_r.text
        report_id = rep_r.json()["report"]["id"]

        # inspector2 tries to fetch → 403
        r = session.get(f"{BASE_URL}/api/customer/reports/{report_id}",
                        headers=_auth(inspector2["token"]), timeout=15)
        assert r.status_code == 403, f"expected 403 for other user, got {r.status_code}: {r.text}"

        # inspector2 tries to list reports for this request → 403
        r2 = session.get(f"{BASE_URL}/api/customer/requests/{req['id']}/reports",
                         headers=_auth(inspector2["token"]), timeout=15)
        assert r2.status_code == 403, r2.text

        # Store for admin test reuse
        TestCustomerIsolation._report_id = report_id

    def test_unknown_report_404(self, session, customer):
        r = session.get(f"{BASE_URL}/api/customer/reports/does-not-exist-xyz",
                        headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────
# Admin moderation
# ──────────────────────────────────────────────────────────────────────
class TestAdminModeration:
    def test_admin_list_reports(self, session, admin):
        r = session.get(f"{BASE_URL}/api/admin/reports", headers=_auth(admin["token"]), timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert "items" in d and "count" in d
        assert d["count"] >= 1

    def test_admin_filter_by_status_submitted(self, session, admin):
        r = session.get(f"{BASE_URL}/api/admin/reports?status=submitted",
                        headers=_auth(admin["token"]), timeout=15)
        assert r.status_code == 200
        for it in r.json()["items"]:
            assert it["status"] == "submitted"

    def test_admin_approve_and_reject(self, session, admin, customer, inspector):
        # Create fresh report to approve
        _grant_credits(session, admin, customer["id"], 2, "TEST_admin")
        req = _create_request(session, customer, f"TESTAdm_{uuid.uuid4().hex[:6]}")
        job = _get_jobs_for_request(session, req["id"])[0]
        _claim(session, inspector, job["id"])
        for t in ("on-route", "arrived", "start-inspection"):
            session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/{t}",
                         headers=_auth(inspector["token"]), timeout=15)
        rep_r = session.post(
            f"{BASE_URL}/api/inspector/jobs/{job['id']}/report",
            json={"score": 9, "verdict": "recommended",
                  "checklist": [{"key": "vin", "status": "ok"}],
                  "summary": "TEST admin approve flow report"},
            headers=_auth(inspector["token"]), timeout=20,
        )
        report_id = rep_r.json()["report"]["id"]

        a = session.post(f"{BASE_URL}/api/admin/reports/{report_id}/approve",
                         headers=_auth(admin["token"]), timeout=15)
        assert a.status_code == 200
        assert a.json()["report"]["status"] == "approved"
        assert a.json()["report"]["approvedAt"]

        # Reject flow — create another
        _grant_credits(session, admin, customer["id"], 2, "TEST_admin2")
        req2 = _create_request(session, customer, f"TESTAdm2_{uuid.uuid4().hex[:6]}")
        job2 = _get_jobs_for_request(session, req2["id"])[0]
        _claim(session, inspector, job2["id"])
        for t in ("on-route", "arrived", "start-inspection"):
            session.post(f"{BASE_URL}/api/inspector/jobs/{job2['id']}/{t}",
                         headers=_auth(inspector["token"]), timeout=15)
        rr = session.post(
            f"{BASE_URL}/api/inspector/jobs/{job2['id']}/report",
            json={"score": 3, "verdict": "not_recommended",
                  "checklist": [{"key": "vin", "status": "problem"}],
                  "summary": "TEST admin reject flow report"},
            headers=_auth(inspector["token"]), timeout=20,
        )
        rep2_id = rr.json()["report"]["id"]
        rej = session.post(f"{BASE_URL}/api/admin/reports/{rep2_id}/reject",
                           json={"reason": "TEST not enough evidence"},
                           headers=_auth(admin["token"]), timeout=15)
        assert rej.status_code == 200, rej.text
        body = rej.json()["report"]
        assert body["status"] == "rejected"
        assert "TEST" in (body.get("rejectReason") or "")

    def test_admin_reject_missing_reason_422(self, session, admin):
        # needs a real report id; use any listed
        r = session.get(f"{BASE_URL}/api/admin/reports", headers=_auth(admin["token"]), timeout=15)
        items = r.json()["items"]
        if not items:
            pytest.skip("no reports available")
        rid = items[0]["id"]
        rej = session.post(f"{BASE_URL}/api/admin/reports/{rid}/reject",
                           json={},  # missing reason
                           headers=_auth(admin["token"]), timeout=15)
        assert rej.status_code == 422

    def test_admin_404_unknown_report(self, session, admin):
        r = session.get(f"{BASE_URL}/api/admin/reports/does-not-exist-xyz",
                        headers=_auth(admin["token"]), timeout=15)
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────────
# Legacy /complete still works (deprecated, no credit consumed)
# ──────────────────────────────────────────────────────────────────────
class TestLegacyComplete:
    def test_legacy_complete_no_credit_consume(self, session, admin, customer, inspector):
        bal_before = _balance(session, admin, customer["id"])
        _grant_credits(session, admin, customer["id"], 1, "TEST_legacy")
        req = _create_request(session, customer, f"TESTLeg_{uuid.uuid4().hex[:6]}")
        job = _get_jobs_for_request(session, req["id"])[0]
        _claim(session, inspector, job["id"])

        # /complete directly from 'claimed' is accepted in legacy path
        r = session.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/complete",
                         headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("deprecated") is True

        time.sleep(0.2)
        bal_after = _balance(session, admin, customer["id"])
        # Used should NOT increase via legacy complete
        assert bal_after["used"] == bal_before["used"], \
            f"legacy /complete must not consume credit, used before={bal_before['used']} after={bal_after['used']}"
