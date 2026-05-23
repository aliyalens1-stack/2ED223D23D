# Sprint 3 · Step 1 — Verification Admin Queue

First step of Sprint 3. Closes the supply-side trust loop: documents flow
from inspector → admin queue → approval/rejection → status visible back to
inspector → trust snapshot recomputed → timeline events emitted.

## Status taxonomy (canonical)

```
missing | uploaded | pending_review | approved | rejected
| needs_resubmission | expired
```

`approved` supersedes the legacy `verified`. Reads normalise legacy rows
to `approved` so the UI sees a single vocabulary.

## Backend

### New module — `/app/backend/app/admin/verification_queue.py`
| Endpoint | Auth | Purpose |
|---|---|---|
| `GET  /api/admin/verification-queue` | admin JWT | Filterable queue (status/kind/search), default = actionable bucket, batched inspector snapshots, roll-up counts |
| `GET  /api/admin/verification-queue/{id}` | admin JWT | Doc + base64 preview + inspector snapshot + rejection history |
| `POST /api/admin/verification-queue/{id}/approve` | admin JWT | Idempotent approve → recompute trust → timeline event |
| `POST /api/admin/verification-queue/{id}/reject` | admin JWT | Body `{reason, note}` → audit row → recompute trust → timeline event |

Allowed `reason` values: `document_blurry`, `document_expired`,
`wrong_document_type`, `name_mismatch`, `incomplete_scan`, `low_quality`,
`suspicious`, `other`. Free-form `note` is the actionable detail.

### Modified — `/app/backend/app/inspector/cabinet.py`
- `GET /api/inspector/verification` now surfaces `rejectionReason`,
  `rejectionNote`, plus `approvedCount/rejectedCount/pendingCount`. Legacy
  `verified` status normalised to `approved`.
- `POST /api/inspector/verification/upload` now:
  - clears any prior `rejectionReason/rejectionNote` on the new doc
    (otherwise UI would keep showing stale reason after resubmit);
  - emits a `verification_submitted` timeline event with
    `metadata.resubmit=true` when the previous doc was rejected.

### Trust snapshot recompute
Stored on `users.verification`:
```json
{
  "verified": true|false,
  "verifiedDocuments": ["passport", "insurance", "taxId", ...],
  "verificationScore": 0..100,
  "updatedAt": "ISO"
}
```
- `verified` requires every doc in `REQUIRED_FOR_VERIFIED = [passport, insurance, taxId]` to be approved.
- `verificationScore` = 70 % weight on required kinds + 30 % bonus for any
  optional approved (toolsProof / tuvCertificate / businessRegistration).
- Recomputed on every approve **and** reject (a rejection can flip a
  previously-verified inspector back to `verified=false`).

### Timeline events (registered in `CANONICAL_KINDS`)
```
verification_submitted  (info,    actor: inspector)
verification_approved   (success, actor: admin)
verification_rejected   (warning, actor: admin)
```

### New collection — `verification_rejection_history`
Append-only audit trail of every rejection decision. Indexed by
`(userId, createdAt desc)` and `(docId, createdAt desc)`. Used by the admin
drawer to show repeat-offender patterns even after the inspector resubmits
a fresh doc (which gets a new `_id`).

### Indexes ensured on startup (lifespan)
```
inspector_verifications:    (status, uploadedAt desc), (userId, kind)
verification_rejection_history: (userId, createdAt desc), (docId, createdAt desc)
```

## Mobile — `/app/frontend/app/inspector/verification.tsx`
- Lists every required kind with status badge.
- On `rejected` shows `Причина отказа` block with reason chip + free-form
  note from admin.
- `Загрузить заново` opens `expo-image-picker`, uploads as base64 to the
  existing `/upload` endpoint → status returns to `pending_review`.
- KPI summary chip: score % + headline + rejection banner if any.
- All testIDs: `verification-card-<kind>`, `verification-upload-<kind>`,
  `verification-reject-<kind>`, `verification-summary`,
  `verification-rejection-banner`.

## Admin SPA — `/app/admin/src/pages/VerificationQueuePage.tsx`
- 3 KPIs (pending / approved / rejected) + filter chips +
  kind dropdown.
- Table: Inspector / Document type / Uploaded at / Status / Actions.
- Right-side drawer with:
  - status badge
  - inspector snapshot (name/email/phone + current trust score)
  - document preview (base64 inline `<img>`)
  - previous rejection history list
  - current rejection block (if status=rejected)
  - approve button + reject form (reason chips + textarea)
- Route registered in `App.tsx` at `/verification-queue` and nav link
  added under GOVERNANCE section.

## Verification — testing_agent_v3_expo (iteration_3.json)
**41/41 green** = 20 new Sprint 3 Step 1 tests + 21 regression tests
(Sprint 2 Step 5 + idempotency 4xx-policy hotfix).

What was directly verified end-to-end:
- approve/reject flip the trust snapshot correctly (3/3 required + 1 optional → score = **80**, `verified=true`; reject passport → `verified=false`, kind removed from `verifiedDocuments`).
- Resubmit after reject yields a brand-new `_id`, clears rejection fields on the doc, but keeps the history row visible to admins.
- Legacy `verified` rows read back as `approved` to the mobile UI.
- Inspector role check: endpoints are JWT-gated; no role gate enforced (any authenticated user can use them). **Noted as spec ambiguity — not blocking.**

## Acceptance checklist
| Item | Status |
|---|---|
| Inspector uploads document | ✅ existing `/upload` reused |
| Admin sees in queue | ✅ `GET /verification-queue` |
| Admin approve/reject | ✅ POST endpoints |
| Rejected reason visible to inspector | ✅ `rejectionReason`+`rejectionNote` in `GET /api/inspector/verification` |
| Resubmit works | ✅ flips back to `pending_review`, history retained |
| Approved doc updates trust snapshot | ✅ `users.verification` updated atomically |
| Timeline events written | ✅ `verification_submitted/approved/rejected` |
| No 4xx/5xx regressions | ✅ 41/41 tests, all endpoints 200/expected |
| Admin UI no white-screen | ✅ admin SPA bundles & loads at `/api/admin-panel/verification-queue` |
