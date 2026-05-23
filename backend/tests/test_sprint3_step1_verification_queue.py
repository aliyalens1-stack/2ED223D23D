"""Sprint 3 Step 1 — Verification Admin Queue.

Covers:
  - POST /api/admin/verification-queue/{id}/approve (auth, idempotency, snapshot, timeline)
  - POST /api/admin/verification-queue/{id}/reject (auth, validation, audit, timeline)
  - GET  /api/admin/verification-queue (filters, counts, snapshot decoration, base64 excluded)
  - GET  /api/admin/verification-queue/{id} (data included, rejection history)
  - GET  /api/inspector/verification (legacy 'verified'→'approved', rejection fields, counts)
  - POST /api/inspector/verification/upload after reject (resets reject fields, timeline resubmit)
  - Trust snapshot recompute math (required+optional weighting)
  - End-to-end happy + reject/resubmit/approve flows
  - Regression: /api/health, admin login, PATCH /api/inspector/verification/{id}
"""
from __future__ import annotations

import time
import uuid
import pytest
from conftest import auth_headers, BACKEND_URL, _sync_post  # type: ignore

REJ_REASONS = [
    "document_blurry", "document_expired", "wrong_document_type",
    "name_mismatch", "incomplete_scan", "low_quality", "suspicious", "other",
]
REQ_KINDS = ["passport", "insurance", "taxId"]
OPT_KINDS = ["businessRegistration", "toolsProof", "tuvCertificate"]


# ─────────────────────────────────────────────────────────────────────
# Helper: fresh "inspector"-ish account (inspector endpoints only check
# JWT presence — no role gate — so a provider_owner token works.).
# Each test that needs isolation gets its OWN signup so verifications
# don't collide across tests.
# ─────────────────────────────────────────────────────────────────────
def _fresh_inspector() -> dict:
    email = f"insp-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}@test.local"
    body = _sync_post(
        "/api/auth/register",
        {
            "email": email,
            "password": "test1234",
            "firstName": "Test",
            "lastName": "Inspector",
            "role": "provider_owner",  # role doesn't matter for /api/inspector/*
        },
    )
    body["_email"] = email
    return body


def _upload(client_sync, token: str, kind: str, note: str = "TEST_upload") -> str:
    r = client_sync.post(
        "/api/inspector/verification/upload",
        json={"kind": kind, "fileName": f"{kind}.pdf", "mimeType": "application/pdf",
              "dataBase64": "QkFTRTY0X0RBVEE=", "note": note},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ─────────────────────────────────────────────────────────────────────
# Auth gates
# ─────────────────────────────────────────────────────────────────────
class TestAuthGates:
    @pytest.mark.asyncio
    async def test_queue_list_requires_admin_401_no_token(self, client):
        r = await client.get("/api/admin/verification-queue")
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_queue_list_403_non_admin(self, client, provider_token):
        r = await client.get("/api/admin/verification-queue",
                             headers=auth_headers(provider_token))
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_approve_requires_admin(self, client):
        r = await client.post("/api/admin/verification-queue/anyid/approve", json={})
        assert r.status_code in (401, 403)

    @pytest.mark.asyncio
    async def test_reject_requires_admin(self, client):
        r = await client.post("/api/admin/verification-queue/anyid/reject",
                              json={"reason": "other"})
        assert r.status_code in (401, 403)


# ─────────────────────────────────────────────────────────────────────
# Queue list filters + counts + base64 exclusion
# ─────────────────────────────────────────────────────────────────────
class TestQueueList:
    @pytest.mark.asyncio
    async def test_default_returns_actionable_only(self, client, admin_token):
        insp = _fresh_inspector()
        with __import__("httpx").Client(base_url=BACKEND_URL, timeout=15.0,
                                        headers={"Authorization": f"Bearer {insp['accessToken']}"}) as s:
            _upload(s, insp["accessToken"], "passport")
        r = await client.get("/api/admin/verification-queue",
                             headers=auth_headers(admin_token))
        assert r.status_code == 200, r.text
        data = r.json()
        assert "items" in data and "counts" in data and "total" in data
        # base64 stripped from list view
        for it in data["items"]:
            assert "data" not in it, "list endpoint MUST exclude heavy base64"
        # default returns actionable bucket
        for it in data["items"]:
            assert it["status"] in ("pending_review", "uploaded", "needs_resubmission")
        # counts roll-up has all required keys
        for k in ("pending_review", "uploaded", "approved",
                  "rejected", "needs_resubmission", "expired"):
            assert k in data["counts"]

    @pytest.mark.asyncio
    async def test_kind_filter(self, client, admin_token):
        r = await client.get("/api/admin/verification-queue?kind=passport",
                             headers=auth_headers(admin_token))
        assert r.status_code == 200
        for it in r.json()["items"]:
            assert it["kind"] == "passport"

    @pytest.mark.asyncio
    async def test_invalid_kind_400(self, client, admin_token):
        r = await client.get("/api/admin/verification-queue?kind=bogus",
                             headers=auth_headers(admin_token))
        assert r.status_code == 400

    @pytest.mark.asyncio
    async def test_invalid_status_400(self, client, admin_token):
        r = await client.get("/api/admin/verification-queue?status=bogus",
                             headers=auth_headers(admin_token))
        assert r.status_code == 400

    @pytest.mark.asyncio
    async def test_status_actionable_alias(self, client, admin_token):
        r = await client.get("/api/admin/verification-queue?status=actionable",
                             headers=auth_headers(admin_token))
        assert r.status_code == 200


# ─────────────────────────────────────────────────────────────────────
# Detail endpoint
# ─────────────────────────────────────────────────────────────────────
class TestQueueDetail:
    @pytest.mark.asyncio
    async def test_detail_includes_base64_and_inspector(self, client, admin_token):
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "passport", "fileName": "p.pdf",
                             "mimeType": "application/pdf",
                             "dataBase64": "QkFTRTY0X0RBVEE="},
                       headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 200
            doc_id = r.json()["id"]
        r = await client.get(f"/api/admin/verification-queue/{doc_id}",
                             headers=auth_headers(admin_token))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["document"]["id"] == doc_id
        assert body["document"]["data"] == "QkFTRTY0X0RBVEE="  # base64 preserved
        assert body["inspector"]["id"] is not None
        assert isinstance(body["rejectionHistory"], list)

    @pytest.mark.asyncio
    async def test_detail_404_unknown(self, client, admin_token):
        r = await client.get("/api/admin/verification-queue/__nope__",
                             headers=auth_headers(admin_token))
        assert r.status_code == 404


# ─────────────────────────────────────────────────────────────────────
# Approve — happy path + idempotency + snapshot + timeline
# ─────────────────────────────────────────────────────────────────────
class TestApprove:
    @pytest.mark.asyncio
    async def test_approve_happy_then_idempotent(self, client, admin_token):
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "passport", "fileName": "p.pdf"},
                       headers={"Authorization": f"Bearer {tok}"})
            doc_id = r.json()["id"]

        # First approve
        r1 = await client.post(f"/api/admin/verification-queue/{doc_id}/approve",
                               json={"note": "ok"}, headers=auth_headers(admin_token))
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        assert d1["document"]["status"] == "approved"
        assert d1["document"]["reviewerId"] is not None
        assert "verification" in d1
        assert "passport" in d1["verification"]["verifiedDocuments"]
        assert "alreadyApproved" not in d1 or d1.get("alreadyApproved") is False

        # Second approve → idempotent
        r2 = await client.post(f"/api/admin/verification-queue/{doc_id}/approve",
                               json={}, headers=auth_headers(admin_token))
        assert r2.status_code == 200
        assert r2.json().get("alreadyApproved") is True

        # Inspector sees status=approved + rejection fields cleared
        r3 = await client.get("/api/inspector/verification",
                              headers=auth_headers(tok))
        assert r3.status_code == 200
        ddoc = next(d for d in r3.json()["documents"] if d["kind"] == "passport")
        assert ddoc["status"] == "approved"
        assert ddoc.get("rejectionReason") in (None, "")
        assert ddoc.get("rejectionNote") in (None, "")

        # Timeline event recorded (verification_approved kind exists)
        rt = await client.get("/api/inspector/timeline?kinds=verification_approved,verification_submitted",
                              headers=auth_headers(tok))
        assert rt.status_code == 200
        kinds = [e["kind"] for e in rt.json()["events"]]
        assert "verification_approved" in kinds
        assert "verification_submitted" in kinds


# ─────────────────────────────────────────────────────────────────────
# Reject — validation + audit + timeline + clear-on-resubmit
# ─────────────────────────────────────────────────────────────────────
class TestReject:
    @pytest.mark.asyncio
    async def test_reject_invalid_reason_400(self, client, admin_token):
        insp = _fresh_inspector()
        import httpx
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "insurance"},
                       headers={"Authorization": f"Bearer {insp['accessToken']}"})
            doc_id = r.json()["id"]
        r = await client.post(f"/api/admin/verification-queue/{doc_id}/reject",
                              json={"reason": "not-in-set", "note": "x"},
                              headers=auth_headers(admin_token))
        assert r.status_code == 400

    @pytest.mark.asyncio
    async def test_reject_then_resubmit_clears_fields_and_audit_persists(
        self, client, admin_token
    ):
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "insurance"},
                       headers={"Authorization": f"Bearer {tok}"})
            doc_id = r.json()["id"]

        # Reject
        r = await client.post(f"/api/admin/verification-queue/{doc_id}/reject",
                              json={"reason": "document_blurry", "note": "Не видно срок"},
                              headers=auth_headers(admin_token))
        assert r.status_code == 200, r.text
        assert r.json()["document"]["status"] == "rejected"
        assert r.json()["document"]["rejectionReason"] == "document_blurry"

        # Inspector sees reason + note
        r2 = await client.get("/api/inspector/verification",
                              headers=auth_headers(tok))
        d = next(x for x in r2.json()["documents"] if x["kind"] == "insurance")
        assert d["status"] == "rejected"
        assert d["rejectionReason"] == "document_blurry"
        assert d["rejectionNote"] == "Не видно срок"

        # Resubmit (new docId) — old reject row remains in history
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "insurance", "fileName": "ins2.pdf"},
                       headers={"Authorization": f"Bearer {tok}"})
            new_doc_id = r.json()["id"]
        assert new_doc_id != doc_id

        # New doc must be pending_review with rejection fields cleared
        r3 = await client.get("/api/inspector/verification",
                              headers=auth_headers(tok))
        d = next(x for x in r3.json()["documents"] if x["kind"] == "insurance")
        assert d["status"] == "pending_review"
        assert d.get("rejectionReason") in (None, "")
        assert d.get("rejectionNote") in (None, "")

        # Admin detail of NEW doc → falls back to user-level history (carries prev rejection)
        r4 = await client.get(f"/api/admin/verification-queue/{new_doc_id}",
                              headers=auth_headers(admin_token))
        assert r4.status_code == 200
        # User-level history fallback should expose the prior reject row
        hist = r4.json()["rejectionHistory"]
        assert any(h.get("reason") == "document_blurry" for h in hist), \
            "Prior rejection row must remain in audit collection"

        # Timeline: rejected + resubmit submitted with metadata.resubmit=true
        rt = await client.get(
            "/api/inspector/timeline?kinds=verification_rejected,verification_submitted",
            headers=auth_headers(tok),
        )
        events = rt.json()["events"]
        assert any(e["kind"] == "verification_rejected" for e in events)
        resubmit_events = [
            e for e in events
            if e["kind"] == "verification_submitted"
            and (e.get("metadata") or {}).get("resubmit") is True
        ]
        assert resubmit_events, "Resubmit timeline event with resubmit=true missing"

        # Admin re-approves the resubmit
        r5 = await client.post(f"/api/admin/verification-queue/{new_doc_id}/approve",
                               json={}, headers=auth_headers(admin_token))
        assert r5.status_code == 200
        assert r5.json()["document"]["status"] == "approved"


# ─────────────────────────────────────────────────────────────────────
# Trust snapshot recompute math
# ─────────────────────────────────────────────────────────────────────
class TestSnapshotMath:
    @pytest.mark.asyncio
    async def test_required_three_then_optional_bonus(self, client, admin_token):
        """3/3 required → verified=true, score≥70. Each optional adds ~10pts."""
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx

        # Upload + approve all 3 required + 1 optional
        approved_kinds = list(REQ_KINDS) + ["toolsProof"]
        last_snap = None
        for kind in approved_kinds:
            with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
                r = s.post("/api/inspector/verification/upload",
                           json={"kind": kind},
                           headers={"Authorization": f"Bearer {tok}"})
                doc_id = r.json()["id"]
            r = await client.post(f"/api/admin/verification-queue/{doc_id}/approve",
                                  json={}, headers=auth_headers(admin_token))
            assert r.status_code == 200
            last_snap = r.json()["verification"]

        # After all 3 required + 1 optional approved:
        # base = 3/3*70 = 70, bonus = 1/3*30 = 10 → 80
        assert last_snap["verified"] is True
        assert set(REQ_KINDS).issubset(set(last_snap["verifiedDocuments"]))
        assert last_snap["verificationScore"] == 80, (
            f"Expected 80 (70 base + 10 optional bonus), got {last_snap['verificationScore']}"
        )

        # Reject one required → verified flips to False, score drops
        # Find the passport doc and reject by approving a fresh upload of passport
        # (simpler path: reject existing approved passport by id).
        # Need passport doc_id — use queue list filtered by approved+kind.
        r = await client.get(
            "/api/admin/verification-queue?status=approved&kind=passport",
            headers=auth_headers(admin_token),
        )
        items = r.json()["items"]
        my_doc = next((i for i in items if i["inspector"]["id"] == insp["user"]["id"]), None)
        if my_doc:
            rr = await client.post(
                f"/api/admin/verification-queue/{my_doc['id']}/reject",
                json={"reason": "low_quality", "note": "TEST_flip"},
                headers=auth_headers(admin_token),
            )
            assert rr.status_code == 200
            snap = rr.json()["verification"]
            assert snap["verified"] is False
            assert "passport" not in snap["verifiedDocuments"]
            assert snap["verificationScore"] < 80


# ─────────────────────────────────────────────────────────────────────
# Inspector /verification counts + normalisation
# ─────────────────────────────────────────────────────────────────────
class TestInspectorVerificationEndpoint:
    @pytest.mark.asyncio
    async def test_counts_and_normalisation(self, client, admin_token):
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx

        # passport → approve, taxId → reject, insurance → pending
        ids = {}
        for k in ("passport", "taxId", "insurance"):
            with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
                r = s.post("/api/inspector/verification/upload",
                           json={"kind": k},
                           headers={"Authorization": f"Bearer {tok}"})
                ids[k] = r.json()["id"]

        await client.post(f"/api/admin/verification-queue/{ids['passport']}/approve",
                          json={}, headers=auth_headers(admin_token))
        await client.post(f"/api/admin/verification-queue/{ids['taxId']}/reject",
                          json={"reason": "other"}, headers=auth_headers(admin_token))

        r = await client.get("/api/inspector/verification",
                             headers=auth_headers(tok))
        assert r.status_code == 200
        body = r.json()
        assert body["approvedCount"] == 1
        assert body["rejectedCount"] == 1
        assert body["pendingCount"] >= 1  # insurance still pending_review
        # Required: inspector role bearer — endpoint enforces JWT only;
        # ensure 401 without bearer
        r = await client.get("/api/inspector/verification")
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_legacy_verified_normalised_to_approved(self, client, admin_token):
        """Direct DB row with status='verified' must surface as 'approved'."""
        import os
        from motor.motor_asyncio import AsyncIOMotorClient

        insp = _fresh_inspector()
        tok = insp["accessToken"]
        uid = insp["user"]["id"]
        mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
        db_name = os.environ.get("DB_NAME", "test_database")
        cli = AsyncIOMotorClient(mongo_url)
        db = cli[db_name]
        legacy_id = "TEST_legacy_" + uuid.uuid4().hex
        await db.inspector_verifications.delete_many({"userId": uid, "kind": "tuvCertificate"})
        await db.inspector_verifications.insert_one({
            "_id": legacy_id, "userId": uid, "kind": "tuvCertificate",
            "status": "verified",  # legacy
            "uploadedAt": "2025-01-01T00:00:00+00:00",
        })
        r = await client.get("/api/inspector/verification",
                             headers=auth_headers(tok))
        d = next(x for x in r.json()["documents"] if x["kind"] == "tuvCertificate")
        assert d["status"] == "approved", "legacy 'verified' must normalise to 'approved'"
        await db.inspector_verifications.delete_one({"_id": legacy_id})
        cli.close()


# ─────────────────────────────────────────────────────────────────────
# Regression checks
# ─────────────────────────────────────────────────────────────────────
class TestRegression:
    @pytest.mark.asyncio
    async def test_health_ok(self, client):
        r = await client.get("/api/health")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_admin_login_works(self, client):
        r = await client.post("/api/auth/login",
                              json={"email": "admin@autoservice.com",
                                    "password": "Admin123!"})
        assert r.status_code == 200
        assert "accessToken" in r.json()

    @pytest.mark.asyncio
    async def test_legacy_patch_verification_status(self, client):
        """Existing PATCH /api/inspector/verification/{id} still works."""
        insp = _fresh_inspector()
        tok = insp["accessToken"]
        import httpx
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as s:
            r = s.post("/api/inspector/verification/upload",
                       json={"kind": "businessRegistration"},
                       headers={"Authorization": f"Bearer {tok}"})
            doc_id = r.json()["id"]
        r = await client.patch(f"/api/inspector/verification/{doc_id}",
                               json={"status": "uploaded"},
                               headers=auth_headers(tok))
        assert r.status_code == 200
        assert r.json()["status"] == "uploaded"
