"""Invariant-locking HTTP tests for car_selection_thread + artifacts.

These tests cement the architectural contract laid out for
Car-Selection-4 (append-only thread + notification projection) and
Car-Selection-5 (immutable evidence / offer artifacts).

What we lock here:

  PRIVACY MODEL
    • 401 — no auth on any surface
    • 404 — foreign request seen by non-admin (existence privacy)
    • 403 — wrong role hitting another surface's URL
    • unassigned provider sees 404 even for existing requests

  ARTIFACT INTEGRITY
    • upload alone DOES NOT create a message
    • upload alone DOES NOT mutate lifecycle (timeline length unchanged)
    • happy path returns the canonical ArtifactOut shape
    • mime/kind mismatch → 415 ARTIFACT_KIND_MIME_MISMATCH
    • oversize → 413 ARTIFACT_TOO_LARGE
    • empty upload → 400 ARTIFACT_EMPTY
    • unknown kind → 400 ARTIFACT_INVALID_KIND
    • no PATCH/PUT/DELETE endpoints exist (immutability)

  THREAD × ARTIFACT JOIN
    • attachmentIds must belong to the SAME request → cross-request
      smuggling returns 400 ARTIFACT_CROSS_REQUEST
    • unknown attachmentId → 400 ARTIFACT_NOT_FOUND
    • more than 10 attachments → 400 ARTIFACT_TOO_MANY
    • message persisted with attachments has resolved ArtifactOut
      projection embedded (immutable at attach-time)

  CROSS-UPLOADER DOWNLOAD (key invariant)
    • customer can download an artifact uploaded by the provider
    • provider can download an artifact uploaded by the customer
    • admin can download any artifact
    • download permission is by request visibility + role,
      NOT by who uploaded the file

  NOTIFICATION PROJECTION
    • customer message → provider + admin sentinel inboxes receive a row
    • provider message → customer + admin sentinel inboxes receive a row
    • admin message → customer + provider inboxes receive a row
    • lifecycle.assigned → provider inbox gets a lifecycle event

  ADMIN OBSERVABILITY
    • GET /api/admin/car-selection/artifacts/stats
        — 401 unauth, 403 customer, 200 admin
        — returns totalArtifacts / totalBytes / byKind with every
          declared kind present even when zero-counted

These tests use the live seed accounts. They run against the local
uvicorn (http://localhost:8001) by default; override with BACKEND_URL.
"""
from __future__ import annotations
import io
import os
import uuid
from typing import Any, Dict, List, Optional

import pytest
import requests


BASE_URL = os.environ.get("BACKEND_URL", "http://localhost:8001").rstrip("/")

CUSTOMER = ("customer@test.com", "Customer123!")
ADMIN = ("admin@autoservice.com", "Admin123!")
PROVIDER = ("provider@test.com", "Provider123!")


# ── Auth helpers ──────────────────────────────────────────────────────


def _login(email: str, password: str) -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": password},
        timeout=20,
    )
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    tok = r.json().get("accessToken")
    assert tok, f"no token in login response: {r.text}"
    return tok


def _me_id(token: str) -> str:
    r = requests.get(
        f"{BASE_URL}/api/auth/me",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    assert r.status_code == 200, f"auth/me failed: {r.status_code} {r.text}"
    body = r.json()
    # Some payloads put the user under "user", others top-level.
    return (
        (body.get("user") or {}).get("id")
        or (body.get("user") or {}).get("_id")
        or body.get("id")
        or body.get("_id")
    )


@pytest.fixture(scope="module")
def customer_token() -> str:
    return _login(*CUSTOMER)


@pytest.fixture(scope="module")
def admin_token() -> str:
    return _login(*ADMIN)


@pytest.fixture(scope="module")
def provider_token() -> str:
    return _login(*PROVIDER)


@pytest.fixture(scope="module")
def provider_user_id(provider_token: str) -> str:
    return _me_id(provider_token)


@pytest.fixture(scope="module")
def customer_user_id(customer_token: str) -> str:
    return _me_id(customer_token)


def _auth(tok: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {tok}"}


def _err_code(resp) -> str:
    """Extract `code` from canonical envelope; supports both flat and
    legacy `detail` wrapper."""
    try:
        body = resp.json()
    except Exception:
        return ""
    if isinstance(body, dict):
        if body.get("code"):
            return body["code"]
        d = body.get("detail")
        if isinstance(d, dict) and d.get("code"):
            return d["code"]
    return ""


# ── Test data factories ──────────────────────────────────────────────


def _create_request(token: str, *, description: str = "test request") -> Dict[str, Any]:
    r = requests.post(
        f"{BASE_URL}/api/car-selection/requests",
        headers=_auth(token),
        json={
            "serviceType": "budget_search",
            "countryCode": "DE",
            "cityId": "berlin",
            "description": description,
        },
        timeout=15,
    )
    assert r.status_code == 200, f"create: {r.status_code} {r.text}"
    body = r.json()
    body["id"] = body.get("id") or body.get("_id")
    return body


def _assign_to_provider(
    admin_tok: str, request_id: str, provider_id: str,
) -> Dict[str, Any]:
    r = requests.post(
        f"{BASE_URL}/api/admin/car-selection/{request_id}/assign",
        headers=_auth(admin_tok),
        json={"providerId": provider_id},
        timeout=15,
    )
    assert r.status_code == 200, f"assign: {r.status_code} {r.text}"
    return r.json()


def _upload(
    surface_url: str,
    token: str,
    *,
    kind: str,
    filename: str,
    content: bytes,
    content_type: str,
) -> requests.Response:
    return requests.post(
        surface_url,
        headers=_auth(token),
        files={"file": (filename, io.BytesIO(content), content_type)},
        data={"kind": kind},
        timeout=20,
    )


def _png(size_bytes: int = 256) -> bytes:
    """Cheap synthetic PNG (header bytes followed by padding). We never
    decode it — the route only checks mime + size."""
    return b"\x89PNG\r\n\x1a\n" + b"x" * max(0, size_bytes - 8)


def _pdf(size_bytes: int = 256) -> bytes:
    return b"%PDF-1.4\n" + b"x" * max(0, size_bytes - 9)


def _generic(size_bytes: int = 256) -> bytes:
    return b"x" * size_bytes


# ═════════════════════════════════════════════════════════════════════
# PRIVACY MODEL (401 / 403 / 404)
# ═════════════════════════════════════════════════════════════════════


class TestPrivacyEnvelope:
    """Auth + role + ownership gates on every artifact/thread surface."""

    def test_unauth_thread_get(self, customer_token):
        req = _create_request(customer_token)
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            timeout=10,
        )
        assert r.status_code == 401, r.text

    def test_unauth_thread_post(self, customer_token):
        req = _create_request(customer_token)
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            json={"body": "anon"},
            timeout=10,
        )
        assert r.status_code == 401, r.text

    def test_unauth_artifact_upload(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            token="",
            kind="image",
            filename="x.png",
            content=_png(),
            content_type="image/png",
        )
        assert r.status_code == 401, r.text

    def test_unauth_stats(self):
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection/artifacts/stats",
            timeout=10,
        )
        assert r.status_code == 401, r.text

    def test_customer_forbidden_on_admin_surface(self, customer_token):
        # Customer hitting admin URL → 403 (role gate fires before lookup).
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection/artifacts/stats",
            headers=_auth(customer_token), timeout=10,
        )
        assert r.status_code == 403, r.text

    def test_provider_forbidden_on_customer_surface(self, customer_token, provider_token):
        # Provider hitting customer URL → 403 (require_account_kind('customer')).
        req = _create_request(customer_token)
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(provider_token), timeout=10,
        )
        assert r.status_code == 403, r.text

    def test_foreign_customer_404(self, customer_token, admin_token):
        # Admin creates an unassigned request — same customer obviously
        # can't see "another customer"'s, but we don't have a 2nd
        # customer seeded. Approach: hit a fabricated id.
        bogus = uuid.uuid4().hex
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{bogus}/thread",
            headers=_auth(customer_token), timeout=10,
        )
        assert r.status_code == 404, r.text
        assert _err_code(r) == "CAR_SELECTION_NOT_FOUND"

    def test_unassigned_provider_404(self, customer_token, provider_token):
        # Provider tries to access a request they have NOT been assigned.
        req = _create_request(customer_token)
        r = requests.get(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/thread",
            headers=_auth(provider_token), timeout=10,
        )
        assert r.status_code == 404, r.text
        assert _err_code(r) == "CAR_SELECTION_NOT_FOUND"

    def test_assigned_provider_200(self, customer_token, admin_token, provider_token, provider_user_id):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        r = requests.get(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/thread",
            headers=_auth(provider_token), timeout=10,
        )
        assert r.status_code == 200, r.text


# ═════════════════════════════════════════════════════════════════════
# ARTIFACT INTEGRITY (size caps, mime allow-list, lifecycle isolation)
# ═════════════════════════════════════════════════════════════════════


class TestArtifactValidation:

    def test_happy_path_image(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="photo.png",
            content=_png(512), content_type="image/png",
        )
        assert r.status_code == 200, r.text
        out = r.json()
        # ArtifactOut shape contract.
        for k in ("id", "requestId", "uploadedBy", "uploadedByRole",
                  "kind", "filename", "mimeType", "sizeBytes", "url", "createdAt"):
            assert k in out, f"missing {k!r} in ArtifactOut: {out}"
        assert out["kind"] == "image"
        assert out["mimeType"] == "image/png"
        assert out["uploadedByRole"] == "customer"
        assert out["requestId"] == req["id"]
        # Customer surface — url prefix predictable.
        assert "/api/car-selection/requests/" in out["url"]

    def test_happy_path_pdf(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="pdf", filename="shortlist.pdf",
            content=_pdf(1024), content_type="application/pdf",
        )
        assert r.status_code == 200, r.text
        assert r.json()["kind"] == "pdf"
        assert r.json()["mimeType"] == "application/pdf"

    def test_happy_path_file_csv(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="file", filename="export.csv",
            content=b"a,b,c\n1,2,3\n", content_type="text/csv",
        )
        assert r.status_code == 200, r.text
        assert r.json()["kind"] == "file"
        assert r.json()["mimeType"] == "text/csv"

    def test_mime_kind_mismatch_415(self, customer_token):
        """Caller lies about kind to slip under the wrong cap."""
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="forged.png",
            content=b"%PDF-fake", content_type="application/pdf",
        )
        assert r.status_code == 415, r.text
        assert _err_code(r) == "ARTIFACT_KIND_MIME_MISMATCH"

    def test_oversize_image_413(self, customer_token):
        # image cap = 8 MiB; 9 MiB blows it.
        req = _create_request(customer_token)
        big = _png(9 * 1024 * 1024)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="big.png",
            content=big, content_type="image/png",
        )
        assert r.status_code == 413, r.text
        assert _err_code(r) == "ARTIFACT_TOO_LARGE"

    def test_oversize_pdf_413(self, customer_token):
        # pdf cap = 20 MiB; 21 MiB blows it.
        req = _create_request(customer_token)
        big = _pdf(21 * 1024 * 1024)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="pdf", filename="big.pdf",
            content=big, content_type="application/pdf",
        )
        assert r.status_code == 413, r.text
        assert _err_code(r) == "ARTIFACT_TOO_LARGE"

    def test_oversize_file_413(self, customer_token):
        # file cap = 10 MiB; 11 MiB blows it.
        req = _create_request(customer_token)
        big = _generic(11 * 1024 * 1024)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="file", filename="big.bin",
            content=big, content_type="application/octet-stream",
        )
        assert r.status_code == 413, r.text
        assert _err_code(r) == "ARTIFACT_TOO_LARGE"

    def test_unknown_kind_400(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="video", filename="x.mp4",
            content=b"fake", content_type="video/mp4",
        )
        assert r.status_code == 400, r.text
        assert _err_code(r) == "ARTIFACT_INVALID_KIND"

    def test_empty_upload_400(self, customer_token):
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="file", filename="empty.bin",
            content=b"", content_type="application/octet-stream",
        )
        assert r.status_code == 400, r.text
        assert _err_code(r) == "ARTIFACT_EMPTY"

    def test_upload_does_not_create_message(self, customer_token):
        """Artifact upload alone must not append to thread."""
        req = _create_request(customer_token)
        before = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(customer_token), timeout=10,
        ).json()
        assert before.get("total") == 0
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="x.png",
            content=_png(128), content_type="image/png",
        )
        assert r.status_code == 200, r.text
        after = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(customer_token), timeout=10,
        ).json()
        assert after.get("total") == 0, after

    def test_upload_does_not_mutate_lifecycle(self, customer_token):
        """Artifact upload alone must not push a timeline event."""
        req_before = _create_request(customer_token)
        rid = req_before["id"]
        # Initial timeline has exactly one 'submitted' event.
        full_before = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{rid}",
            headers=_auth(customer_token), timeout=10,
        ).json()
        timeline_before = full_before.get("timeline") or []
        status_before = full_before.get("status")

        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{rid}/artifacts",
            customer_token,
            kind="file", filename="notes.txt",
            content=b"hello", content_type="text/plain",
        )
        assert r.status_code == 200, r.text

        full_after = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{rid}",
            headers=_auth(customer_token), timeout=10,
        ).json()
        timeline_after = full_after.get("timeline") or []
        # Length unchanged, status unchanged.
        assert len(timeline_after) == len(timeline_before), (
            f"upload appended {len(timeline_after) - len(timeline_before)} timeline "
            f"events; expected 0"
        )
        assert full_after.get("status") == status_before

    def test_no_destructive_endpoints(self, customer_token):
        """Immutability — no DELETE/PATCH/PUT on artifact rows.

        Server's 404 handler converts FastAPI's 405 into a flat 404
        envelope. Either way: the destructive verbs MUST NOT succeed
        (no 2xx response). That is the locked invariant.
        """
        req = _create_request(customer_token)
        r = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="x.png",
            content=_png(128), content_type="image/png",
        )
        art_id = r.json()["id"]
        url = f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts/{art_id}"
        rd = requests.delete(url, headers=_auth(customer_token), timeout=10)
        rp = requests.patch(url, headers=_auth(customer_token), json={}, timeout=10)
        rput = requests.put(url, headers=_auth(customer_token), json={}, timeout=10)
        # No mutation verb is allowed. 404 (custom envelope) or 405
        # are both acceptable; 2xx is NOT.
        for resp in (rd, rp, rput):
            assert resp.status_code in (404, 405), (
                f"destructive verb succeeded: {resp.status_code} {resp.text}"
            )
            assert resp.status_code < 200 or resp.status_code >= 300


# ═════════════════════════════════════════════════════════════════════
# THREAD × ARTIFACT JOIN (cross-request smuggling, ref resolution)
# ═════════════════════════════════════════════════════════════════════


class TestAttachmentResolution:

    def test_attachment_persists_with_message(self, customer_token):
        req = _create_request(customer_token)
        rid = req["id"]
        up = _upload(
            f"{BASE_URL}/api/car-selection/requests/{rid}/artifacts",
            customer_token,
            kind="image", filename="x.png",
            content=_png(128), content_type="image/png",
        )
        art_id = up.json()["id"]

        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{rid}/thread",
            headers=_auth(customer_token),
            json={"body": "see attached", "attachmentIds": [art_id]},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        msg = r.json()
        assert len(msg["attachments"]) == 1
        assert msg["attachments"][0]["id"] == art_id
        # The artifact projection is embedded — not just the id.
        assert msg["attachments"][0]["mimeType"] == "image/png"

    def test_cross_request_smuggling_400(self, customer_token):
        """Artifact uploaded against request A cannot be attached to a
        message on request B."""
        req_a = _create_request(customer_token, description="request A")
        req_b = _create_request(customer_token, description="request B")
        up = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req_a['id']}/artifacts",
            customer_token,
            kind="image", filename="a.png",
            content=_png(128), content_type="image/png",
        )
        art_id = up.json()["id"]

        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{req_b['id']}/thread",
            headers=_auth(customer_token),
            json={"body": "smuggled", "attachmentIds": [art_id]},
            timeout=10,
        )
        assert r.status_code == 400, r.text
        assert _err_code(r) == "ARTIFACT_CROSS_REQUEST"

    def test_unknown_attachment_400(self, customer_token):
        req = _create_request(customer_token)
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(customer_token),
            json={"body": "ghost", "attachmentIds": [uuid.uuid4().hex]},
            timeout=10,
        )
        assert r.status_code == 400, r.text
        assert _err_code(r) == "ARTIFACT_NOT_FOUND"

    def test_too_many_attachments_400(self, customer_token):
        """Schema caps at 10; sending 11 must be refused. Pydantic
        rejects this at schema validation (422)."""
        req = _create_request(customer_token)
        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(customer_token),
            json={"body": "many", "attachmentIds": [uuid.uuid4().hex] * 11},
            timeout=10,
        )
        # Pydantic validation kicks in BEFORE artifacts resolver — 422.
        assert r.status_code == 422, r.text


# ═════════════════════════════════════════════════════════════════════
# CROSS-UPLOADER DOWNLOAD (key invariant)
# ═════════════════════════════════════════════════════════════════════


class TestCrossUploaderDownload:
    """Download permission is by request visibility, NOT by uploader.

    Customer must be able to open a PDF uploaded by the provider, and
    vice-versa — that's the whole point of an offer-artifact substrate.
    """

    def test_customer_downloads_provider_artifact(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        # Provider uploads a PDF on the provider surface.
        up = _upload(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/artifacts",
            provider_token,
            kind="pdf", filename="offer.pdf",
            content=_pdf(2048), content_type="application/pdf",
        )
        assert up.status_code == 200, up.text
        art_id = up.json()["id"]

        # Customer fetches that artifact via the CUSTOMER surface URL.
        r = requests.get(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts/{art_id}",
            headers=_auth(customer_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("application/pdf")
        assert len(r.content) == 2048

    def test_provider_downloads_customer_artifact(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        up = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="from-customer.png",
            content=_png(256), content_type="image/png",
        )
        art_id = up.json()["id"]

        r = requests.get(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/artifacts/{art_id}",
            headers=_auth(provider_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("image/png")

    def test_admin_downloads_any_artifact(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        # Provider uploads.
        up = _upload(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/artifacts",
            provider_token,
            kind="file", filename="export.csv",
            content=b"a,b\n1,2\n", content_type="text/csv",
        )
        art_id = up.json()["id"]
        # Admin reads via admin surface.
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection/{req['id']}/artifacts/{art_id}",
            headers=_auth(admin_token), timeout=15,
        )
        assert r.status_code == 200, r.text

    def test_foreign_customer_artifact_404(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        # Provider uploads on a customer's request; a fabricated 2nd
        # customer (we proxy with bogus rid) sees 404. Using a bogus
        # rid is the cleanest deterministic check.
        req = _create_request(customer_token)
        up = _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="x.png",
            content=_png(128), content_type="image/png",
        )
        art_id = up.json()["id"]
        # Now try fetching via an unassigned provider — request 404,
        # before we even reach the artifact lookup.
        r = requests.get(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/artifacts/{art_id}",
            headers=_auth(provider_token), timeout=10,
        )
        assert r.status_code == 404, r.text
        assert _err_code(r) == "CAR_SELECTION_NOT_FOUND"


# ═════════════════════════════════════════════════════════════════════
# NOTIFICATION PROJECTION (fan-out + lifecycle.assigned)
# ═════════════════════════════════════════════════════════════════════


def _inbox(token: str) -> Dict[str, Any]:
    r = requests.get(
        f"{BASE_URL}/api/car-selection/notifications/me",
        headers=_auth(token), timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _inbox_for_request(token: str, request_id: str) -> List[Dict[str, Any]]:
    return [n for n in _inbox(token).get("items", []) if n.get("requestId") == request_id]


class TestNotificationProjection:

    def test_customer_message_fans_out(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        # Mark current inbox state — we only count NEW rows for this request.
        before_prov = len(_inbox_for_request(provider_token, req["id"]))
        before_admin = len(_inbox_for_request(admin_token, req["id"]))

        r = requests.post(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/thread",
            headers=_auth(customer_token),
            json={"body": "hello provider"},
            timeout=10,
        )
        assert r.status_code == 200, r.text

        prov_new = _inbox_for_request(provider_token, req["id"])
        adm_new = _inbox_for_request(admin_token, req["id"])
        # Provider must have received a 'message' row.
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "customer"
            for n in prov_new
        ), prov_new
        # Admin sentinel must have received it too.
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "customer"
            for n in adm_new
        ), adm_new
        # And growth >= 1 on both inboxes.
        assert len(prov_new) > before_prov
        assert len(adm_new) > before_admin

    def test_provider_message_fans_out(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        r = requests.post(
            f"{BASE_URL}/api/provider/car-selection/{req['id']}/thread",
            headers=_auth(provider_token),
            json={"body": "ack from provider"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        # Customer + admin should see a row authored by provider.
        cust_rows = _inbox_for_request(customer_token, req["id"])
        adm_rows = _inbox_for_request(admin_token, req["id"])
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "provider"
            for n in cust_rows
        )
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "provider"
            for n in adm_rows
        )

    def test_admin_message_fans_out(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        r = requests.post(
            f"{BASE_URL}/api/admin/car-selection/{req['id']}/thread",
            headers=_auth(admin_token),
            json={"body": "admin note"},
            timeout=10,
        )
        assert r.status_code == 200, r.text
        cust_rows = _inbox_for_request(customer_token, req["id"])
        prov_rows = _inbox_for_request(provider_token, req["id"])
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "admin"
            for n in cust_rows
        )
        assert any(
            n["eventType"] == "message" and n.get("actorRole") == "admin"
            for n in prov_rows
        )

    def test_lifecycle_assigned_notifies_provider(
        self, customer_token, admin_token, provider_token, provider_user_id,
    ):
        req = _create_request(customer_token)
        before = len(_inbox_for_request(provider_token, req["id"]))
        _assign_to_provider(admin_token, req["id"], provider_user_id)
        after_rows = _inbox_for_request(provider_token, req["id"])
        assert any(
            n["eventType"] == "lifecycle.assigned" for n in after_rows
        ), after_rows
        assert len(after_rows) > before


# ═════════════════════════════════════════════════════════════════════
# ADMIN OBSERVABILITY — /api/admin/car-selection/artifacts/stats
# ═════════════════════════════════════════════════════════════════════


class TestArtifactStats:

    def test_admin_stats_shape(self, customer_token, admin_token):
        # Ensure at least 1 artifact exists.
        req = _create_request(customer_token)
        _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="image", filename="x.png",
            content=_png(128), content_type="image/png",
        )
        r = requests.get(
            f"{BASE_URL}/api/admin/car-selection/artifacts/stats",
            headers=_auth(admin_token), timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert set(body.keys()) >= {"totalArtifacts", "totalBytes", "byKind"}
        assert isinstance(body["totalArtifacts"], int)
        assert isinstance(body["totalBytes"], int)
        # Every declared kind ALWAYS present — even zero buckets.
        for k in ("image", "pdf", "file"):
            assert k in body["byKind"], body
            assert "count" in body["byKind"][k]
            assert "bytes" in body["byKind"][k]
        # Sanity: total >= per-bucket sum.
        bucket_sum = sum(v["count"] for v in body["byKind"].values())
        assert body["totalArtifacts"] >= bucket_sum
        # We just uploaded at least one image — bucket must be >= 1.
        assert body["byKind"]["image"]["count"] >= 1

    def test_stats_grows_after_upload(self, customer_token, admin_token):
        before = requests.get(
            f"{BASE_URL}/api/admin/car-selection/artifacts/stats",
            headers=_auth(admin_token), timeout=10,
        ).json()
        req = _create_request(customer_token)
        payload = _pdf(4096)
        _upload(
            f"{BASE_URL}/api/car-selection/requests/{req['id']}/artifacts",
            customer_token,
            kind="pdf", filename="x.pdf",
            content=payload, content_type="application/pdf",
        )
        after = requests.get(
            f"{BASE_URL}/api/admin/car-selection/artifacts/stats",
            headers=_auth(admin_token), timeout=10,
        ).json()
        assert after["totalArtifacts"] == before["totalArtifacts"] + 1
        assert after["byKind"]["pdf"]["count"] == before["byKind"]["pdf"]["count"] + 1
        # totalBytes grew by at least the payload length.
        assert after["totalBytes"] >= before["totalBytes"] + len(payload)
