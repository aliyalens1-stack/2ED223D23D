# Phase 9 — Offer Package Versioning · Implementation Plan

**Companion to**: `PHASE_9_OFFER_PACKAGE_VERSIONING_ARCHAEOLOGY.md`
**Status**: APPROVED — all 10 §7 decisions closed.
**Cadence**: 9A → 9B → 9C → 9D → 9E → 9F. Each stage has its own diff + smoke. One finish per stage.

---

## 0. Locked decisions (§7 answers)

| # | Decision |
|---|----------|
| 7.1 | `chainId` is STORED (3 lineage fields: `supersedesId`, `supersededById`, `chainId`) |
| 7.2 | Lineage link MATERIALIZES at deliver-time. Draft may carry `supersedesId` as **intent** (mutable like other draft fields), but predecessor's `supersededById` is written ONLY when the new package crosses `delivered`. |
| 7.3 | Provider CANNOT revoke. Admin-only governance. |
| 7.4 | Notification preview = `title + " (vN)"` when `version > 1`. v1 unchanged. |
| 7.5 | `deliveredOffersCount` stays RAW. No code change to Step-2 logic. |
| 7.6 | UI shows ONLY adjacent links (prev/next via `supersedesId`/`supersededById`). No chain modal. |
| 7.7 | Revoked predecessors remain valid lineage parents. |
| 7.8 | **MULTIPLE chains per request.** Provider declares chain membership explicitly via optional `supersedesId` on the draft. If absent at deliver-time → new chain (own `_id` becomes the `chainId`, version=1). |
| 7.9 | Concurrent v2 race → CAS on predecessor with filter `{supersededById: null}`. On `modified_count == 0` → reject delivery with 409 `OFFER_PACKAGE_SUPERSEDE_RACE`. |
| 7.10 | All existing e2e tests gain `assert pkg.version == 1` and `assert pkg.get('supersedesId') is None` where the test creates a fresh package. |

---

## 1. Derived rules (consequences of the 10 decisions)

### 1.1 Predecessor validity (at deliver-time)

When draft has `supersedesId = X`, deliver validates:
* X exists ✓
* X.requestId == self.requestId ✓
* X.providerId == self.providerId ✓ (chains are provider-scoped — one provider cannot supersede another's offer)
* X.deliveredAt is not None ✓ (i.e. X has been delivered at some point; we don't allow superseding a draft)
* X.status ≠ `accepted` ✓ (acceptance closes the chain; further negotiation is a new chain)
* X.supersededById IS NULL ✓ (X is the current tip of its chain — CAS will re-confirm this)

Failure of any check → 409 with specific error code (see §4).

### 1.2 Chain assignment formula (at deliver-time)

```python
if not supersedesId:
    chainId  = self._id          # new chain rooted at this package
    version  = 1
else:
    chainId  = predecessor.chainId
    version  = predecessor.version + 1
```

### 1.3 Predecessor write rule

Update is a CAS:
```
filter:  {_id: prev._id, supersededById: None}
update:  {$set: {supersededById: self._id}}
NB:      do NOT touch prev.updatedAt
NB:      do NOT push a timeline event on prev (it's frozen)
```

If `modified_count == 0`: 409 `OFFER_PACKAGE_SUPERSEDE_RACE`.

### 1.4 Sort stays untouched

`list_for_request` keeps `sort("updatedAt", -1)`. New v2 is naturally at the top because its `updatedAt = now`. v1's `updatedAt` is NOT bumped (the CAS write only changes `supersededById`).

### 1.5 Draft `supersedesId` mutability

`UpdateDraftIn` gains an optional `supersedesId: str | None` field. Provider may set/clear it like any other draft field while status=`draft`. It is validated at PATCH-time for shape (string or null) but NOT for predecessor existence — that check is deferred to deliver. Why: a provider may save a draft now, switch their mind, etc. The expensive cross-validation runs once, at the commercial commit point.

### 1.6 Visibility of `supersedesId` on a draft

Drafts are provider-private. Customer never sees a draft's `supersedesId`. Admin sees it on draft views (helps governance decisions). No change to visibility rules.

### 1.7 Notification preview

In `notifier.project_offer_package_event`:
```python
title = (package_doc.get("title") or "").strip()
version = int(package_doc.get("version", 1))
if version > 1:
    base = title or f"package {package_id[:8]}"
    preview = f"{base[:130]} (v{version})"
else:
    preview = title[:140] if title else f"package {package_id[:8]}"
```

Only the `preview` string changes. `offerPackageId` already on the row → inbox click already deep-links to v_n.

### 1.8 EVENT_TYPE map: unchanged

No new event type for supersede. v2 delivery emits `offer_package.delivered` exactly like v1.

---

## 2. Stage 9A — Repository expansion

**Files**: `app/offer_packages/repository.py`, `app/offer_packages/models.py`

**Steps**:

A1. **models.py**: extend `_PackageContent` with optional `supersedesId: str | None`. Add `field_validator` only for shape (strip, length 1–64 if set). Add to `OfferPackageOut`: `supersedesId: Optional[str]`, `supersededById: Optional[str]`, `chainId: Optional[str]`, all defaulting to `None`. Why optional on Out: backfill safety for any pre-existing v1 docs whose schema doesn't yet have these fields.

A2. **repository.py · `create_draft`**: doc shape gains `supersedesId`, `supersededById=None`, `chainId=None`, `version=1`. Note: `chainId` STAYS NULL on a draft. It's populated at deliver-time when chain identity is decided. (Reason: a draft that ultimately starts a new chain will get `chainId = self._id` at deliver. A draft with intent `supersedesId` will inherit `chainId = predecessor.chainId` at deliver. Either way the chainId truth is a deliver-time fact.)

A3. **repository.py · `update_draft`**: add `supersedesId` to the list of fields applied from the patch (same set as title/summary/...). Pydantic already validates shape.

A4. **repository.py · `apply_transition`**: add a `_materialize_chain_link()` private helper. Called ONLY when `target_status == "delivered"`, BEFORE the CAS write of self.status, in this order:
   1. If self.supersedesId is None → write `{chainId: self._id, version: 1}` into the update_doc. Skip predecessor logic.
   2. If self.supersedesId is set → load predecessor, run §1.1 validations, perform §1.3 CAS on predecessor. On success: update_doc gets `{chainId: predecessor.chainId, version: predecessor.version + 1}`.
   3. On CAS miss → raise `OFFER_PACKAGE_SUPERSEDE_RACE` (409).
   4. On validation miss → raise the appropriate specific code (see §4).

A5. **repository.py · `_project`**: project the three new fields. Each is `doc.get("supersedesId")` style — works on legacy docs that don't have them.

A6. **repository.py · `ensure_indices`**: add `(chainId, version -1)` for chain walks. Keep existing 3 indices. Optional fourth: `(supersededById, 1)` for "find tip of chain" queries — but the tip is also reachable by `chainId + version desc + limit 1`. Recommendation: SKIP the optional index, add it later if profiling demands.

**Smoke after 9A**:
* POST create_draft without supersedesId → doc has supersedesId=None, version=1, chainId=null (still null at draft).
* POST create_draft with supersedesId="fake" → 201, stored on draft, NOT validated yet.
* PATCH update_draft setting supersedesId to null → cleared.
* POST deliver with invalid supersedesId → 409 with the right code.
* POST deliver chain: v1 → v2 → v3, each gets correct version + chainId + supersedesId. Verify v2.supersededById == v3._id.

**Risk**: predecessor query must run inside the same transaction as self's status flip. We don't have multi-doc Mongo transactions enabled. Mitigation: the predecessor CAS is the atomicity boundary. If it succeeds, we proceed to self's status flip. If self's status flip then somehow fails (it uses its own CAS guard), the system has a predecessor with `supersededById` pointing to a never-delivered package — that's a soft inconsistency, not a hard one. Document this in the helper's docstring. Add a recovery method `repair_dangling_supersededBy()` for future ops use. Implement repair method in 9A as a no-op shell so the entry point exists.

---

## 3. Stage 9B — API contract

**Files**: routers — none modified for new endpoints. Models already updated in 9A.

**Steps**:

B1. **router_provider.py · `update_draft`**: nothing to change at the router layer; the existing `body: UpdateDraftIn` already carries the new field thanks to 9A.

B2. **router_provider.py · `create_draft`**: same — `body: CreateDraftIn` inherits the field.

B3. **router_provider.py · `deliver`**: unchanged on the surface, but the 409 error responses now include three new codes. Document them.

B4. **router_admin.py**: NO CHANGE.

B5. **router_customer.py**: NO CHANGE. (Customer never reads or writes lineage fields directly; they only get them projected on the wire.)

**Smoke after 9B**: re-run §2 smoke through the actual HTTP API. Plus: admin GET on a draft returns the `supersedesId` field; customer GET on a delivered v2 returns `supersedesId`, `supersededById=null`, `chainId=<chain root>`, `version=2`.

---

## 4. New error codes

Add to backend (router layer) and to `frontend/src/i18n/carSelectionErrors.ts`:

| Code | HTTP | When | Localized message |
|------|------|------|-------------------|
| `OFFER_PACKAGE_SUPERSEDE_PREDECESSOR_NOT_FOUND` | 404 | deliver with `supersedesId` pointing to a non-existent / wrong-request / wrong-provider package | "Cannot supersede unknown offer." |
| `OFFER_PACKAGE_SUPERSEDE_NOT_DELIVERED` | 409 | predecessor never reached `delivered` | "Cannot supersede a draft offer." |
| `OFFER_PACKAGE_SUPERSEDE_ACCEPTED` | 409 | predecessor is `accepted` | "Cannot supersede an accepted offer — start a new chain instead." |
| `OFFER_PACKAGE_SUPERSEDE_RACE` | 409 | CAS miss on predecessor (already superseded concurrently) | "A newer version was delivered just now — refresh and try again." |

All four codes go through the existing unified error envelope (`{error, code, message, details}`). UI maps via `mapCarSelectionError(t, e)`.

---

## 5. Stage 9C — Frontend UI

**Files**: `frontend/src/components/OfferPackageBlock.tsx`, `frontend/src/i18n/locales/{en,ru,de}.json`.

**Steps**:

C1. **Types**: `OfferPackage` TS interface gains:
```typescript
supersedesId: string | null;
supersededById: string | null;
chainId: string | null;
```

C2. **Card UI — adjacent lineage banners** (§7.6, adjacent only):
* If `pkg.supersededById !== null`: small inline banner below status pill, color = neutral subtext, text = `"Superseded by v{N+1}"`, with a small chevron right. Tap → `focusPackageId={supersededById}` on the same screen.
* If `pkg.supersedesId !== null`: small inline banner, text = `"Supersedes v{N-1}"`, also tappable to focus predecessor.

Both banners are tiny — single line, 11px text, no background card, just an icon + text + arrow. Like a breadcrumb, not a panel.

C3. **Composer — chain intent selector** (provider-only):
* In the draft composer modal, add a small section labeled "Supersedes (optional)" with:
  * Display of currently chosen predecessor's title + version (if any).
  * Button "Choose offer to supersede" → opens a sub-modal listing all delivered/declined/revoked packages on this request that belong to THIS provider (excluding any that already have `supersededById ≠ null`). Each row shows title, version, status, delivered date.
  * Tap row → sets `supersedesId` on the form state.
  * Button "Clear" if currently set.
* The list comes from the existing `GET /api/provider/car-selection/{rid}/offer-packages` call (already loaded). Filter client-side: `{p.status in ["delivered","declined","revoked"] && p.supersededById === null && p.providerId === pkg.providerId}`.

C4. **Card UI — version label**: existing `v{N}` label keeps working — it already reads `pkg.version`.

C5. **Sort**: no change. UI continues to render server's order.

C6. **Decision buttons**: no change. Customer can still accept any delivered package regardless of lineage (I-8). The "newer offer available" banner is INFORMATIONAL only.

C7. **i18n keys**:

```
car_selection.offer_package.card.lineage.superseded_by: "Superseded by v{{version}}"
car_selection.offer_package.card.lineage.supersedes:    "Supersedes v{{version}}"
car_selection.offer_package.composer.supersedes_label:  "Supersedes (optional)"
car_selection.offer_package.composer.supersedes_pick:   "Choose offer to supersede"
car_selection.offer_package.composer.supersedes_clear:  "Clear"
car_selection.offer_package.composer.supersedes_none:   "No predecessor — this starts a new offer line"
```

C8. **Error mapping**: add the 4 new error codes from §4 to `carSelectionErrors.ts`.

**Smoke after 9C**:
* Create draft, deliver v1. Card shows "v1", no lineage banners.
* Create draft, set supersedesId=v1._id via composer, deliver. Card v2 shows "Supersedes v1" banner. v1 card shows "Superseded by v2" banner. Both banners are tappable and flash the target card.
* Customer accepts v1 even after v2 delivered → both cards' status update correctly. v2 retains "Supersedes v1" banner.
* Concurrent provider sessions trigger race → error toast shows localized "A newer version was delivered just now — refresh and try again."

---

## 6. Stage 9D — Notifier preview

**Files**: `app/offer_packages/notifier.py`.

**Steps**:

D1. In `project_offer_package_event`, modify the preview formula per §1.7. Lines 139-140 in current notifier become the new formula. One-line logic change.

D2. No new event type. No fan-out changes.

**Smoke after 9D**:
* Deliver v1 → customer inbox row preview = `"BMW X3 2019"` (unchanged).
* Deliver v2 of same chain → customer inbox row preview = `"BMW X3 2019 (v2)"`.

---

## 7. Stage 9E — Counts (verify, no code)

**Files**: NONE.

**Steps**:

E1. Per §7.5, `deliveredOffersCount` stays raw. No code change.

E2. Add a unit test confirming the §6.3 cases:
* T-c1 (single v1 delivered): count=1.
* T-c2 (v1 delivered + v2 delivered, both alive): count=**2**. This is the assertion that locks in the §7.5 decision.
* T-c3 (v1 declined + v2 delivered): count=1.
* T-c4 (v1 accepted + v2 delivered): count=1.

If at any point the team decides to flip §7.5 to "collapse-by-chain", they MUST update this test first (it's now the lockbox of the semantic decision).

---

## 8. Stage 9F — Tests

**Files**: `/app/tests/offer_packages/test_offer_packages_versioning_e2e.py` (NEW), light edits to `test_offer_packages_e2e.py` (existing).

**Steps**:

F1. **NEW e2e file** covering T-v1 through T-v8 from archaeology §6.1 + T-c1 through T-c4 from §6.3 above + the 4 new error codes.

F2. **Existing e2e**: add `assert pkg.version == 1`, `assert pkg["supersedesId"] is None`, `assert pkg["supersededById"] is None`, `assert pkg["chainId"] == pkg["id"]` (after deliver) at appropriate points. These additions guarantee the new fields land on legacy code paths without changing their behaviour. ~6 small inserts, no logic changes.

F3. Run BOTH existing test files unchanged otherwise. They MUST pass. If any existing assertion fails, the implementation broke an invariant.

**Smoke after 9F**: run all three test files end-to-end. Green = Phase 9 ships.

---

## 9. Sequencing and finishes

| Stage | Files | Estimated tokens | Finish |
|-------|-------|------------------|--------|
| 9A+9B | `repository.py`, `models.py`, 4 error codes wired in routers | medium | 1 |
| 9C    | `OfferPackageBlock.tsx`, 3 i18n files, `carSelectionErrors.ts` | medium | 1 |
| 9D    | `notifier.py` (1-line change) | small | bundled into 9F |
| 9E    | no code | trivial | bundled into 9F |
| 9F    | NEW versioning test file, light edits to existing | medium | 1 |

Three finishes total: 9A+9B, 9C, 9D+9E+9F. Same disciplined cadence as Phase 8.

---

## 10. Roll-back posture

Each stage leaves the system in a coherent state if rolled back to its end-of-stage:

* After 9A+9B: backend persists lineage fields, all defaulting to null/own-id; UI ignores them; no behavioural change visible to users.
* After 9C: UI can render lineage banners but never NEEDS to (defaults to v1 cards as before).
* After 9F: invariant tests guarantee no behavioural drift on legacy paths.

If any stage fails verification, revert just that stage; earlier stages remain shipped.

End of plan.
