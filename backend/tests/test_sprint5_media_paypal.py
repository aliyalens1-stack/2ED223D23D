"""Sprint 5 — Media uploads + PayPal credit-pack purchase (MOCK mode).

Covers:
- Media: multipart + JSON upload, size limits (413), mime validation (400),
  ownership (403), report-locked (409), list/delete, customer read,
  /api/media/{id} bytes serving (auth-aware).
- GET /api/customer/reports/{id} includes 'media' array.
- PayPal: create-order (mock MOCK- orderIds), unknown package 404,
  no-auth create-order allowed, capture-order grants credits + ledger,
  idempotency, order/payment mismatch 409, non-existent paymentId 404,
  STRIPE provider payment → 409, status endpoint.
"""
from __future__ import annotations
import base64
import os
import time
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_BACKEND_URL")
            or os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or "http://localhost:8001").rstrip("/")

ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}
CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
PROVIDER = {"email": "provider@test.com", "password": "Provider123!"}


# ── helpers ──────────────────────────────────────────────────────────
def _login(s, creds):
    r = s.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=15)
    assert r.status_code == 200, f"login {creds['email']}: {r.status_code} {r.text}"
    d = r.json()
    return {"token": d["accessToken"], "id": d["user"]["id"]}


def _auth(tok): return {"Authorization": f"Bearer {tok}"}
def _auth_json(tok): return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _grant(s, admin, uid, delta):
    r = s.post(f"{BASE_URL}/api/admin/credits/adjust",
               json={"userId": uid, "delta": delta, "note": "TEST sprint5"},
               headers=_auth_json(admin["token"]), timeout=15)
    assert r.status_code == 200, r.text


def _create_request(s, cust, city):
    r = s.post(f"{BASE_URL}/api/customer/requests",
               json={"brand": "TEST_B", "model": "TEST_M", "budget": 9000,
                     "cities": [city], "links": []},
               headers=_auth_json(cust["token"]), timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


def _submit_report(s, admin, cust, insp, status_after="submitted"):
    """Create request → claim → advance → submit report. Returns (req, job, report_id)."""
    _grant(s, admin, cust["id"], 2)
    city = f"TESTS5_{uuid.uuid4().hex[:6]}"
    req = _create_request(s, cust, city)
    jobs = s.get(f"{BASE_URL}/api/customer/requests/{req['id']}/jobs", timeout=15).json()["jobs"]
    job = jobs[0]
    assert s.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/claim",
                  headers=_auth(insp["token"]), timeout=15).status_code == 200
    for t in ("on-route", "arrived", "start-inspection"):
        assert s.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/{t}",
                      headers=_auth(insp["token"]), timeout=15).status_code == 200
    rep = s.post(f"{BASE_URL}/api/inspector/jobs/{job['id']}/report",
                 json={"score": 7.5, "verdict": "recommended",
                       "checklist": [{"key": "vin", "status": "ok"}],
                       "summary": "TEST sprint5 body of report text here."},
                 headers=_auth_json(insp["token"]), timeout=20)
    assert rep.status_code == 200, rep.text
    rid = rep.json()["report"]["id"]
    return req, job, rid


def _tiny_png_b64(n_bytes=200):
    # minimal valid PNG header + padding
    png_hdr = bytes.fromhex("89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489")
    raw = png_hdr + b"\x00" * max(0, n_bytes - len(png_hdr))
    return base64.b64encode(raw).decode("ascii")


# ── fixtures ─────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    return s


@pytest.fixture(scope="module")
def admin(session): return _login(session, ADMIN)

@pytest.fixture(scope="module")
def customer(session): return _login(session, CUSTOMER)

@pytest.fixture(scope="module")
def inspector(session): return _login(session, PROVIDER)

@pytest.fixture(scope="module")
def inspector2(session):
    email = f"TEST_insp2s5_{uuid.uuid4().hex[:8]}@example.com"
    r = session.post(f"{BASE_URL}/api/auth/register",
                     json={"email": email, "password": "Insp2Pass!",
                           "firstName": "I2", "role": "provider_owner"}, timeout=15)
    assert r.status_code in (200, 201), r.text
    d = r.json()
    return {"token": d.get("accessToken"), "id": d.get("user", {}).get("id")}


@pytest.fixture(scope="module")
def customer2(session):
    email = f"TEST_cust2s5_{uuid.uuid4().hex[:8]}@example.com"
    r = session.post(f"{BASE_URL}/api/auth/register",
                     json={"email": email, "password": "Cust2Pass!",
                           "firstName": "C2", "role": "customer"}, timeout=15)
    assert r.status_code in (200, 201), r.text
    d = r.json()
    return {"token": d.get("accessToken"), "id": d.get("user", {}).get("id")}


@pytest.fixture(scope="module")
def submitted_report(session, admin, customer, inspector):
    req, job, rid = _submit_report(session, admin, customer, inspector)
    return {"req": req, "job": job, "report_id": rid}


# ── BLOCK 1: MEDIA ────────────────────────────────────────────────────
class TestMediaUploadJSON:
    def test_json_upload_photo_ok(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "photo", "mimeType": "image/png",
                               "dataBase64": _tiny_png_b64(300)},
                         headers=_auth_json(inspector["token"]), timeout=20)
        assert r.status_code == 200, r.text
        m = r.json()["media"]
        assert m["id"] and m["type"] == "photo" and m["mimeType"] == "image/png"
        assert m["url"].startswith("/api/media/")
        assert m["sizeBytes"] > 0
        submitted_report["media_id"] = m["id"]

    def test_json_upload_video_mp4_ok(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "video", "mimeType": "video/mp4",
                               "dataBase64": base64.b64encode(b"\x00" * 1024).decode()},
                         headers=_auth_json(inspector["token"]), timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["media"]["type"] == "video"

    def test_invalid_mime_ico_400(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "photo", "mimeType": "image/x-icon",
                               "dataBase64": _tiny_png_b64(100)},
                         headers=_auth_json(inspector["token"]), timeout=15)
        assert r.status_code == 400, r.text

    def test_invalid_mime_avi_400(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "video", "mimeType": "video/avi",
                               "dataBase64": base64.b64encode(b"\x00" * 500).decode()},
                         headers=_auth_json(inspector["token"]), timeout=15)
        assert r.status_code == 400, r.text

    def test_photo_too_large_413(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        big = base64.b64encode(b"\x00" * (8 * 1024 * 1024 + 100)).decode()
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "photo", "mimeType": "image/png",
                               "dataBase64": big},
                         headers=_auth_json(inspector["token"]), timeout=30)
        assert r.status_code == 413, f"expected 413, got {r.status_code}: {r.text[:200]}"

    def test_video_too_large_413(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        big = base64.b64encode(b"\x00" * (25 * 1024 * 1024 + 100)).decode()
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "video", "mimeType": "video/mp4",
                               "dataBase64": big},
                         headers=_auth_json(inspector["token"]), timeout=45)
        assert r.status_code == 413, f"expected 413, got {r.status_code}: {r.text[:200]}"

    def test_other_inspector_forbidden_403(self, session, inspector2, submitted_report):
        if not inspector2["token"]:
            pytest.skip("insp2 not registered")
        rid = submitted_report["report_id"]
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "photo", "mimeType": "image/png",
                               "dataBase64": _tiny_png_b64(100)},
                         headers=_auth_json(inspector2["token"]), timeout=15)
        assert r.status_code == 403, r.text


class TestMediaMultipart:
    def test_multipart_upload_ok(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        raw = bytes.fromhex("89504E470D0A1A0A") + b"\x00" * 300
        files = {"file": ("test.png", raw, "image/png")}
        data = {"type": "photo"}
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         files=files, data=data,
                         headers=_auth(inspector["token"]), timeout=20)
        assert r.status_code == 200, r.text
        assert r.json()["media"]["type"] == "photo"


class TestMediaListAndCustomerRead:
    def test_inspector_list(self, session, inspector, submitted_report):
        rid = submitted_report["report_id"]
        r = session.get(f"{BASE_URL}/api/inspector/reports/{rid}/media",
                        headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["count"] >= 1 and isinstance(d["items"], list)
        assert all(it["url"].startswith("/api/media/") for it in d["items"])

    def test_customer_list_own(self, session, customer, submitted_report):
        rid = submitted_report["report_id"]
        r = session.get(f"{BASE_URL}/api/customer/reports/{rid}/media",
                        headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200
        assert r.json()["count"] >= 1

    def test_customer_other_403(self, session, customer2, submitted_report):
        rid = submitted_report["report_id"]
        r = session.get(f"{BASE_URL}/api/customer/reports/{rid}/media",
                        headers=_auth(customer2["token"]), timeout=15)
        assert r.status_code == 403, r.text

    def test_customer_report_detail_has_media(self, session, customer, submitted_report):
        rid = submitted_report["report_id"]
        r = session.get(f"{BASE_URL}/api/customer/reports/{rid}",
                        headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200
        body = r.json()["report"]
        assert "media" in body and isinstance(body["media"], list)
        assert len(body["media"]) >= 1
        m0 = body["media"][0]
        assert {"id", "url", "type"}.issubset(m0.keys())


class TestMediaServe:
    def test_serve_no_auth_401(self, session, submitted_report):
        mid = submitted_report["media_id"]
        r = requests.get(f"{BASE_URL}/api/media/{mid}", timeout=15)
        assert r.status_code == 401, r.text

    def test_serve_owner_customer_200(self, session, customer, submitted_report):
        mid = submitted_report["media_id"]
        r = requests.get(f"{BASE_URL}/api/media/{mid}",
                         headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/")

    def test_serve_other_customer_403(self, session, customer2, submitted_report):
        mid = submitted_report["media_id"]
        r = requests.get(f"{BASE_URL}/api/media/{mid}",
                         headers=_auth(customer2["token"]), timeout=15)
        assert r.status_code == 403, r.text


class TestMediaDelete:
    def test_delete_own(self, session, admin, customer, inspector):
        # Fresh report so delete doesn't affect earlier tests
        _req, _job, rid = _submit_report(session, admin, customer, inspector)
        up = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                          json={"type": "photo", "mimeType": "image/png",
                                "dataBase64": _tiny_png_b64(200)},
                          headers=_auth_json(inspector["token"]), timeout=15)
        assert up.status_code == 200
        mid = up.json()["media"]["id"]

        r = session.delete(f"{BASE_URL}/api/inspector/media/{mid}",
                           headers=_auth(inspector["token"]), timeout=15)
        assert r.status_code == 200, r.text

        # Confirm gone
        lst = session.get(f"{BASE_URL}/api/inspector/reports/{rid}/media",
                          headers=_auth(inspector["token"]), timeout=15).json()
        assert mid not in [it["id"] for it in lst["items"]]


class TestReportLocked:
    def test_upload_after_approve_409(self, session, admin, customer, inspector):
        # create report and approve it → upload must 409
        _req, _job, rid = _submit_report(session, admin, customer, inspector)
        ap = session.post(f"{BASE_URL}/api/admin/reports/{rid}/approve",
                          headers=_auth(admin["token"]), timeout=15)
        assert ap.status_code == 200, ap.text
        r = session.post(f"{BASE_URL}/api/inspector/reports/{rid}/upload",
                         json={"type": "photo", "mimeType": "image/png",
                               "dataBase64": _tiny_png_b64(150)},
                         headers=_auth_json(inspector["token"]), timeout=15)
        assert r.status_code == 409, r.text


# ── BLOCK 3: PAYPAL ───────────────────────────────────────────────────
class TestPayPalCreateOrder:
    def test_create_order_mock(self, session, customer):
        r = session.post(f"{BASE_URL}/api/payments/paypal/create-order",
                         json={"packageId": "single"},
                         headers=_auth_json(customer["token"]), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["paymentId"]
        assert d["orderId"].startswith("MOCK-"), f"expected MOCK- prefix, got {d['orderId']}"
        assert d["approveUrl"]
        assert d.get("mock") is True
        assert d["amount"] == 120 and d["credits"] == 1 and d["currency"] == "EUR"

    def test_unknown_package_404(self, session, customer):
        r = session.post(f"{BASE_URL}/api/payments/paypal/create-order",
                         json={"packageId": "nope_xxx"},
                         headers=_auth_json(customer["token"]), timeout=15)
        assert r.status_code == 404, r.text

    def test_no_auth_still_works(self, session):
        r = requests.post(f"{BASE_URL}/api/payments/paypal/create-order",
                          json={"packageId": "bundle_3"}, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["orderId"].startswith("MOCK-")


class TestPayPalCaptureAndIdempotency:
    @pytest.fixture(scope="class")
    def created(self, session, customer, admin):
        # Track customer balance before
        bal_before = session.get(f"{BASE_URL}/api/admin/credits/{customer['id']}",
                                 headers=_auth(admin["token"]), timeout=15).json()
        r = session.post(f"{BASE_URL}/api/payments/paypal/create-order",
                         json={"packageId": "bundle_3"},
                         headers=_auth_json(customer["token"]), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        return {"paymentId": d["paymentId"], "orderId": d["orderId"],
                "credits": d["credits"], "bal_before": bal_before}

    def test_capture_grants_credits(self, session, customer, admin, created):
        r = session.post(f"{BASE_URL}/api/payments/paypal/capture-order",
                         json={"orderId": created["orderId"], "paymentId": created["paymentId"]},
                         headers=_auth_json(customer["token"]), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "paid"
        assert d["credits"] == created["credits"]

        time.sleep(0.2)
        bal_after = session.get(f"{BASE_URL}/api/admin/credits/{customer['id']}",
                                headers=_auth(admin["token"]), timeout=15).json()
        assert bal_after["balance"] == created["bal_before"]["balance"] + created["credits"], \
            f"balance delta wrong: {created['bal_before']['balance']} → {bal_after['balance']}"

    def test_ledger_has_purchase_entry(self, session, customer, created):
        r = session.get(f"{BASE_URL}/api/customer/credits/ledger",
                        headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200, r.text
        entries = r.json().get("entries", r.json().get("items", []))
        match = [e for e in entries
                 if e.get("paymentId") == created["paymentId"]
                 and e.get("type") == "purchase"
                 and int(e.get("delta", 0)) == created["credits"]]
        assert match, f"no purchase ledger entry for payment {created['paymentId']} found in {entries[:5]}"

    def test_capture_idempotent(self, session, customer, created):
        r = session.post(f"{BASE_URL}/api/payments/paypal/capture-order",
                         json={"orderId": created["orderId"], "paymentId": created["paymentId"]},
                         headers=_auth_json(customer["token"]), timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d.get("idempotent") is True
        assert d["status"] == "paid"

    def test_capture_mismatching_order_409(self, session, customer, created):
        r = session.post(f"{BASE_URL}/api/payments/paypal/capture-order",
                         json={"orderId": "MOCK-WRONGONE", "paymentId": created["paymentId"]},
                         headers=_auth_json(customer["token"]), timeout=15)
        assert r.status_code == 409, r.text

    def test_capture_unknown_payment_404(self, session, customer):
        r = session.post(f"{BASE_URL}/api/payments/paypal/capture-order",
                         json={"orderId": "MOCK-X", "paymentId": "does-not-exist"},
                         headers=_auth_json(customer["token"]), timeout=15)
        assert r.status_code == 404, r.text

    def test_status_endpoint(self, session, customer, created):
        r = session.get(f"{BASE_URL}/api/payments/paypal/status/{created['paymentId']}",
                        headers=_auth(customer["token"]), timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["status"] == "paid"
        assert d["orderId"] == created["orderId"]
        assert d["credits"] == created["credits"]
        assert d.get("mock") is True


class TestPayPalProviderMismatch:
    def test_stripe_payment_via_paypal_capture_409(self, session, customer):
        # Create a stripe pending payment via existing endpoint
        r = session.post(f"{BASE_URL}/api/payments/packages/checkout",
                         json={"packageId": "single", "provider": "stripe",
                               "origin": "https://example.com"},
                         headers=_auth_json(customer["token"]), timeout=20)
        if r.status_code != 200:
            pytest.skip(f"stripe checkout not creating pending payment: {r.status_code} {r.text[:200]}")
        stripe_payment_id = r.json().get("paymentId")
        if not stripe_payment_id:
            pytest.skip("stripe checkout did not return paymentId")

        cap = session.post(f"{BASE_URL}/api/payments/paypal/capture-order",
                           json={"orderId": "MOCK-ABC", "paymentId": stripe_payment_id},
                           headers=_auth_json(customer["token"]), timeout=15)
        assert cap.status_code == 409, f"expected 409, got {cap.status_code}: {cap.text}"
        assert "PayPal" in cap.text or "paypal" in cap.text.lower()
