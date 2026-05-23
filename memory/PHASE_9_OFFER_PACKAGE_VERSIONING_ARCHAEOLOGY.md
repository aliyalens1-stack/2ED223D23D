# Phase 9 — Offer Package Versioning · Archaeology Report

**Status**: READ-ONLY audit. No code changes made. No implementation proposed beyond a semantic map.
**Date**: 2026-05-17
**Scope**: Map every place in backend + frontend that touches `version` / `supersedesId` semantics today, every invariant that supersede must NOT violate, every silent assumption Phase 9 will collide with.

> **Rule**: even if backend already partially implements supersede — only document. Don't "finish" it.

---

## 0. TL;DR

* `version: int` is **physically wired** end-to-end (DB → projection → API → UI label). Today it is hard-coded to `1` at create-time and never mutated.
* `supersedesId` is **mentioned in 3 docstrings as reserved** and **not present anywhere else** — not in DB schema, not in indices, not in projection, not in lifecycle, not in notifier, not in UI, not in tests.
* Lifecycle is locked at 5 statuses. There is **no** `superseded` status and there should **not** be one — supersede is lineage metadata, not a commercial decision.
* The system today assumes: *multiple packages per (request) are allowed*, *at most one delivered per (request, provider) by lifecycle definition* (since deliver → terminal-only transitions), and *customer can accept any delivered package*. All three remain true under the recommended versioning model.
* No partial supersede implementation exists. Phase 9 is greenfield over a clean foundation.

---

## 1. Current Facts

### 1.1 DB document shape (`car_selection_offer_packages`)

Every doc written today (see `repository.create_draft` lines 282-306):

```
_id            string  uuid4hex            primary key
requestId      string                      parent car_selection request
providerId     string                      assigned provider on the request
version        int     ALWAYS 1            <-- reserved, never mutated
status         enum    draft|delivered|accepted|declined|revoked
title          str?
summary        str?
priceCents     int?
currency       str?
artifactIds    [str]                       references thread artifacts
createdAt      iso8601
updatedAt      iso8601
deliveredAt    iso8601?                    stamped at status="delivered"
decidedAt      iso8601?                    stamped at accepted/declined/revoked
decidedBy      string?                     actor user id
decidedNote    str?                        optional text from actor
timeline       [event{type, at, actorId, actorRole, note?, data?}]
```

**What is NOT in the doc today**: `supersedesId`, `supersededById`, `chainId`, `branch`, anything lineage-shaped.

### 1.2 Field-by-field check requested by brief

| Field         | Present | Notes |
|---------------|---------|-------|
| `version`     | ✅      | hard-coded `1` at insert (`repository.py:287`), projected as `int(doc.get("version", 1))` (`repository.py:174`). No mutation path. No default in Pydantic Out — schema requires it. |
| `supersedesId`| ❌      | mentioned in docstrings only: `repository.py:230` (Step-2 count), `__init__.py:28`, `OfferPackageBlock.tsx:33` (UI comment). No code reads or writes it. |
| `status`      | ✅      | 5-enum, locked in `lifecycle.STATUSES`. CAS-guarded transition (`apply_transition` uses `{"_id": pid, "status": current}` filter). |
| `requestId`   | ✅      | indexed `(requestId, status, updatedAt -1)` |
| `providerId`  | ✅      | indexed `(providerId, status, updatedAt -1)` |
| `createdAt`/`updatedAt` | ✅ | UTC ISO with `Z` suffix |
| `deliveredAt` | ✅      | only set when target_status == "delivered" |
| `acceptedAt`  | ❌ (combined) | unified `decidedAt` + `decidedBy` covers accepted/declined/revoked |
| `declinedAt`  | ❌ (combined) | same |
| `revokedAt`   | ❌ (combined) | same |

> Brief asked specifically about separate `acceptedAt`/`declinedAt`/`revokedAt`. They do **not** exist. Truth is `decidedAt + status`. Recommended versioning **does not require splitting them**.

### 1.3 Indices today

From `OfferPackageRepository.ensure_indices` (lines 111-118):

```python
( requestId, status, updatedAt -1 )    # list-by-request + customer view + Step-2 count
( providerId, status, updatedAt -1 )   # provider "my work" view
( status, deliveredAt -1 )             # admin governance backlog
```

**Uniqueness assumptions**: NONE on `(requestId, providerId)`. The schema already allows >1 package per (request, provider). This is **intentional** — Phase 6 always supported the "deliver, customer declines, provider drafts again" path, which today produces 2 separate documents (decline_v1 + draft_v2). The current production data already contains such pairs from smoke tests.

### 1.4 Projection surfaces

Three callers, three projections, all going through the same `_project()` (lines 149-189):

| Caller (router)         | `surface=` | `statuses=`                                                | Provider scope?         |
|-------------------------|-----------|-------------------------------------------------------------|-------------------------|
| `router_provider.list_my_packages`  | `provider` | (unset → all)                                       | filter `providerId=ctx.user_id` |
| `router_customer.list_visible`      | `customer` | `["delivered","accepted","declined","revoked"]` (`CUSTOMER_VISIBLE_STATUSES`, line 76) | no provider filter |
| `router_admin.list_all`             | `admin`    | (unset → all incl. drafts)                          | no filter               |

**Where customer-draft-invisibility is enforced**: router layer only (`router_customer.py:105`). The repository accepts an unfiltered request and would happily return drafts — only the router restricts it. This is a **risk zone for Phase 9** (see §3.2).

**`surface` parameter usage**: only flows into artifact URL signing (`_project` line 168 → `self._artifacts.to_out(adoc, surface=surface)`). It does NOT filter visible fields. All three surfaces see the full content of every visible doc.

### 1.5 Sort order

Single rule everywhere: `sort("updatedAt", -1)` (`list_for_request` line 209).

Implications for versioning:
* A newer `delivered_v2` (just delivered → most recent `updatedAt`) lands at the top.
* An older `delivered_v1` (delivered earlier, never re-touched) lands lower.
* If `delivered_v1` is later marked superseded by some lineage write, its `updatedAt` would bump and it would re-surface — **this is wrong** for chronological reading. See §3.3.

### 1.6 Lifecycle (locked)

From `lifecycle.py` (5 statuses, 3 terminal):

```
draft     → delivered | revoked
delivered → accepted  | declined | revoked
accepted  → ∅
declined  → ∅
revoked   → ∅
```

`apply_transition` (line 383) is the only mutation path past draft. CAS guard `{"_id": pid, "status": current}` ensures no concurrent transition collides.

### 1.7 Notification fan-out (locked)

From `notifier.FANOUT` (lines 80-85):

```
delivered  →  customer + admin
accepted   →  provider + admin
declined   →  provider + admin
revoked    →  provider + customer    (admin actor → self-skip)
```

`EVENT_TYPE` map (lines 63-68): `delivered/accepted/declined/revoked`. Only these 4 transitions notify. **Drafts produce zero notifications** (line 134 comment: "sibling silence is the goal"). **Patch on a draft produces zero notifications** (test `test_offer_packages_inbox_e2e.py` lines 240-258 explicitly verifies this).

### 1.8 UI today (`OfferPackageBlock.tsx`)

Reads:
* `pkg.version` is rendered as a small label "v1" on every card (line 402-404, i18n key `car_selection.offer_package.card.version`).
* Sort comes from server — UI does not re-sort (`items.map(pkg => ...)`, line 310).
* `focusPackageId` is a deep-link target (Step 8). Flash animation when matched (line 384-396 of card sub-component). No "expand chain" affordance.

Decision-button gates (lines 379-382):
```
showEditBtn      = surface==='provider' && status==='draft'
showDeliverBtn   = surface==='provider' && status==='draft'
showDecisionBtns = surface==='customer' && status==='delivered'
showRevokeBtn    = surface==='admin'    && status∈{draft,delivered}
```

**Assumption**: each card decides independently from its own status. No "is this the latest version?" check. No "block accept if newer delivered exists." Both are intentional and remain correct under recommended semantics (§4).

### 1.9 Tests today

Two e2e files, both `urllib`-based smoke against the live backend:

* `/app/tests/offer_packages/test_offer_packages_e2e.py` (270 lines) — lifecycle invariants, draft hiding, freeze, empty-deliver guard, terminal blocks, cross-customer leak.
* `/app/tests/offer_packages/test_offer_packages_inbox_e2e.py` (280 lines) — fan-out matrix, self-notify guard, **draft silence**, mark-as-read.

**Specific assertions Phase 9 must NOT relax**:
* `step("draft hidden from customer", body["total"] == 0)` (e2e line 118)
* `step("customer GET draft → 404", code == 404)` (e2e line 123)
* `step("double-deliver → 409", code == 409)` (e2e line 161)
* `step("post-delivery patch → 409", code == 409)` (e2e line 172)
* `step("draft generated zero rows for customer", cust_d4 == {})` (inbox line 255)
* `step("draft generated zero rows for admin", admin_d4 == {})` (inbox line 257)

**Tests will need new cases** (see §6).

---

## 2. Existing Invariants (must remain true after Phase 9)

**I-1. Status enum is locked at 5 values.** Adding a 6th breaks `OfferPackageOut._status_known`, every i18n status label, every admin filter, every snapshot. Phase 9 **does not need** a new status.

**I-2. Draft is provider-private.** Customer must continue to see 404 on a draft, regardless of how many versions exist on the request.

**I-3. Delivered package content is frozen.** `update_draft` rejects with `OFFER_PACKAGE_FROZEN` (409) for any status ≠ draft. This must remain — versioning does **not** unfreeze.

**I-4. Terminal transitions are absorbing.** `accepted`/`declined`/`revoked` reach `∅`. Phase 9 must not create a "supersedeIfOlder" auto-transition that mutates a terminal status.

**I-5. Drafts are silent.** Notifier fan-out has no `draft.*` event type. Patching a draft produces zero notifications. A draft_v2 must therefore stay invisible/silent until `delivered_v2`.

**I-6. Actor self-notify is suppressed.** `notifier._resolve_recipient` skips when `recipient_id == actor_id`. Provider creating draft_v2 must not notify themselves; admin revoke must not notify admin.

**I-7. Notifications are projection-only.** A failed `db.notifications.insert_one` never rolls back a lifecycle write (`apply_transition` lines 488-497). This stays.

**I-8. Customer can accept any delivered non-terminal package by id.** Today the router does no "is this still the latest?" check (`router_customer.py:147-167`). This is **intentional truthful history** — Phase 9 must keep it.

**I-9. Existence privacy is router-enforced.** Customer router filters by `CUSTOMER_VISIBLE_STATUSES`. The repository is not privacy-aware. Phase 9 must enforce supersede-visibility at the same layer (router), not silently push it into the repo.

**I-10. Server owns sort.** UI does `items.map(...)` without re-ordering. Phase 9 must not require client-side lineage reconstruction.

**I-11. `version` is monotonically increasing per chain.** Today every doc is v1. Whatever lineage scheme Phase 9 chooses, the projected `version` integer on the wire must be ≥ 1 and unique per (chainRoot).

**I-12. Counts use status, not lineage.** The Step-2 `count_delivered_by_request_ids` counts raw `status="delivered"` documents. Whether or not Phase 9 changes that is an **explicit decision** (§7) — not silent drift.

---

## 3. Risk Zones (where supersede can quietly break things)

### 3.1 Sort order pollution (HIGH)

If supersede is implemented as "stamp `supersededAt` on v1 when v2 is delivered", v1's `updatedAt` will bump and v1 will re-surface above v2 in `list_for_request` (which sorts by `updatedAt desc`).

**Mitigation idea (no code yet)**: never touch v1's `updatedAt` when assigning lineage. Lineage metadata write must be a `$set` on a side-channel field that **does not** touch sort keys. Confirmed feasible — `updatedAt` is set explicitly in every transition path; there is no `$currentDate` magic.

### 3.2 Customer visibility filter (HIGH)

Today the customer sees `CUSTOMER_VISIBLE_STATUSES = [delivered, accepted, declined, revoked]`. If Phase 9 adds a lineage marker but no extra filter, the customer will see:
* v1 declined
* v2 delivered

— which is **actually correct** (truthful history). The customer should see both, with a visual hint that v2 supersedes v1.

But if Phase 9 ever wants "customer sees only the latest in chain", that filter belongs in the router, NOT in the repo. Pushing it into the repo means everywhere — admin, governance, future analytics — also gets the collapse. That is **not desired**.

### 3.3 Lineage write atomicity (MEDIUM)

To write a `supersedesId` pointer on v2 we need to atomically read v1's id during draft creation. Today `create_draft` does not look at sibling packages. A naive add would race with concurrent provider drafts (rare but possible).

**Mitigation idea**: lineage pointer is set at `deliver`-time, not at `create_draft`. Provider can have an ongoing draft pointing nowhere; the chain link is established only when v2 actually crosses to `delivered`. This also keeps draft silence intact (a draft never reveals what it would supersede).

### 3.4 Notification preview confusion (MEDIUM)

Today the inbox row preview is the package title (`notifier.py:139`). When v2 supersedes v1, the customer's `offer_package.delivered` row says "BMW X5 shortlist (e2e)" — but they may have an older row from v1 with **the same preview**. That's confusing if both are unread.

**Mitigation idea**: include version in preview when version > 1: `"BMW X5 shortlist (v2)"`. This is a **wire change** to `notifier.project_offer_package_event`. Phase 9 decision needed.

### 3.5 Accept-after-supersede ambiguity (HIGH for UX, LOW for backend)

Backend invariant I-8 says customer can accept v1 even after v2 is delivered. UX must show this clearly so the customer doesn't accidentally accept stale offers.

**Mitigation idea (UI-only)**: on a delivered package whose `supersededById ≠ null`, render a banner "Newer offer available (v2)" with link via `focusPackageId=v2id`. Accept/decline buttons remain enabled — customer choice. Per the rule "superseded = newer alternative exists, not = invalid".

### 3.6 Empty-deliver guard interaction (LOW)

`apply_transition` (line 418-429) blocks deliver if title+summary+artifacts are all empty. This guard already works per-document and is lineage-agnostic. No change needed.

### 3.7 Step-2 count drift (LOW now, HIGH after versioning)

Current count: raw delivered. After Phase 9 with multiple delivered-in-chain, a count of 3 could mean:
* (a) 3 distinct offers from 1 provider over time (v1, v2, v3 all delivered, customer hasn't decided on any) — **rare but legal**
* (b) 3 distinct offers from 3 providers (one v1 each)
* (c) Some mix

Decision needed (§7) on whether `deliveredOffersCount` collapses by chain or stays raw. Today I'd argue **raw is correct** — every delivered version is a distinct commercial commitment the customer can act on. But this needs to be an explicit decision, not silent.

### 3.8 Snapshot test brittleness (LOW)

`test_matching_v2_snapshot.py` is the only `snapshot` test in the tree and it's unrelated to offer_packages. No snapshot tests for offer_packages exist. Phase 9 has no snapshot trap.

---

## 4. Recommended Versioning Semantics

> Stating these as **recommendations**, not as a plan. Final go/no-go is a §7 decision.

### 4.1 Lineage shape

* Add **two** new fields to every offer-package document, written at `deliver`-time only:
  * `supersedesId: string | null` — points back to the previous delivered package in the chain. Null on v1.
  * `supersededById: string | null` — points forward to the next delivered package in the chain. Null on the tip.
* `version: int` — already in the schema, currently always 1. Becomes max(prev.version, 0) + 1 at deliver-time. Stays monotonic per chain.
* `chainId: string` — **optional**. The root `_id` of the chain. Saves a recursive walk for "find all versions of this offer". If we omit it now we can derive it by walking, but adding it later requires a backfill. Recommendation: include from day one.

### 4.2 Status enum

**No change.** Supersede is lineage metadata, not a status.

### 4.3 Allowed transitions

**No change.** v1 stays in whatever terminal state the customer/admin gave it. v2 starts in `draft` and follows the existing 5-state lifecycle. The two are linked by metadata, not by transitions.

### 4.4 Acceptance semantics (the brief explicitly asked to lock this)

**Customer may accept ANY delivered non-terminal package by id, regardless of whether a newer version exists.**

Concretely:
* If v1 is `delivered` and v2 is `delivered`, customer accepting v1 stays valid → v1 becomes `accepted`.
* v2 is NOT auto-declined. v2 remains `delivered` until someone (customer, admin, provider via revoke flow if added later) decides it.
* This is "truthful history". The audit trail shows: "customer chose v1 even though v2 existed."

### 4.5 Sibling decisions

**No auto-decline of siblings.** Brief explicitly rejected `sibling auto-decline`. The provider/admin will need a "clean up stale delivered_v1" affordance, but that is **explicit admin revoke**, not automatic.

### 4.6 Notification fan-out

* `offer_package.delivered` for v2 fires the existing fan-out — customer + admin. **Same event-type string.** No new EVENT_TYPE entry. The fact that v2 supersedes v1 is metadata on the package, not a new domain event.
* Preview includes version when > 1 (§3.4 mitigation).
* `draft_v2` produces ZERO notifications. Silent.
* Whether to add a `offer_package.superseded` event for the customer? **Recommendation: NO.** The `offer_package.delivered` row of v2 already carries `offerPackageId=v2`; the UI shows the supersede banner; no need for a second row.

### 4.7 Existence privacy

**No change.** Customer sees `delivered/accepted/declined/revoked` regardless of chain. Drafts hidden. Admin sees all.

### 4.8 The word "superseded"

Use it only in **UI copy** ("This offer was superseded by a newer version") and in **lineage field names** (`supersededById`). Never as a `status` value. Never as a notification eventType.

---

## 5. Implementation Plan Preview (no code, sequence only)

**Phase 9A — Repository expansion** (smallest possible diff)
1. Add `supersedesId`, `supersededById`, `chainId` to `create_draft` initial doc (null/null/own-id when no prior). Default version=1 stays.
2. Add **read** method `find_latest_delivered_for_provider(rid, pid) → doc | None`. Used at deliver-time to identify the predecessor.
3. Modify `apply_transition` ONLY in the `delivered` branch:
   * Look up predecessor via the new read method.
   * If predecessor exists: this doc's `supersedesId = prev._id`, `chainId = prev.chainId`, `version = prev.version + 1`.
   * Atomically update the predecessor's `supersededById = self._id` — **WITHOUT touching `updatedAt`** to keep sort stable (§3.1).
   * Notifier fan-out unchanged.
4. Project the three new fields in `_project()`.
5. Index `(supersededById, version -1)` for chain walks (optional now, cheap to add).

**Phase 9B — API contract**
1. `OfferPackageOut` gains three optional fields.
2. No new endpoints. No new transitions. No new event types.

**Phase 9C — Frontend** (additive only)
1. `OfferPackage` TS type gains the three fields.
2. Card shows version label "v2" already; just trust server number.
3. NEW: small banner on a delivered card whose `supersededById ≠ null` → "A newer version is available" + button → reuses `focusPackageId` to scroll to v_n+1.
4. NEW: small banner on a delivered card whose `supersedesId ≠ null` → "Supersedes v1" (informational, not a CTA).
5. NO change to the inbox; existing rows work as-is.

**Phase 9D — Notifier**
1. `project_offer_package_event` preview: when `package_doc.version > 1`, append `" (v" + version + ")"` to preview. Single-line change.
2. Otherwise untouched.

**Phase 9E — Counts**
1. Decision per §7.5 — either keep raw (no code change) or collapse-by-chain (would add `latest_delivered_per_chain` aggregation method).

**Phase 9F — Tests** — see §6.

---

## 6. Tests to Add (must all pass before Phase 9 lands)

### 6.1 Repository unit / e2e (mirror existing style — `urllib` smoke)

* **T-v1**: provider delivers, customer declines v1, provider delivers v2 → DB shows v1.status=declined, v2.status=delivered, v1.supersededById=v2._id, v2.supersedesId=v1._id, v2.version=2, both share chainId=v1._id.
* **T-v2**: same setup but customer never decides v1; provider delivers v2 → v1 stays `delivered`, NOT auto-declined. v1.supersededById=v2._id, v2.supersedesId=v1._id.
* **T-v3**: customer accepts v1 after v2 exists → v1.status=accepted, v2.status=delivered (untouched). Audit trail intact.
* **T-v4**: sort stability — after v2 delivery, `list_for_request` returns v2 first (newer `updatedAt`), v1 second. v1's `updatedAt` is unchanged.
* **T-v5**: draft_v2 silent — no notification rows for any role.
* **T-v6**: notification preview — v2 delivery row preview contains "(v2)".
* **T-v7**: admin sees both v1 and v2 with all lineage fields populated.
* **T-v8**: customer cross-version 404 — customer GET on v_n that was never `delivered`-or-later → 404.

### 6.2 Lifecycle invariant tests (must continue to pass unchanged)

All existing tests in `test_offer_packages_e2e.py` and `test_offer_packages_inbox_e2e.py` MUST continue to pass with zero changes. If any fails, the implementation has broken an invariant.

### 6.3 Step-2 count test

Add to existing customer requests-list flow:
* T-c1: request with v1 delivered → count=1
* T-c2: request with v1 delivered + v2 delivered → count is **whatever §7.5 decides** (assertion must match the decision)
* T-c3: request with v1 declined + v2 delivered → count=1 (only v2 in `delivered`)
* T-c4: request with v1 accepted + v2 delivered → count=1 (v1 terminal-not-delivered, v2 alive)

### 6.4 UI tests (manual or playwright)

* Customer detail screen with chain shows both cards, v2 on top, banner on v1 saying "Superseded by v2", banner on v2 saying "Supersedes v1".
* Inbox row preview for `offer_package.delivered` on v2 shows "(v2)" in the preview text.
* Bell badge count unaffected by chain depth.
* Inline `deliveredOffersCount` matches §7.5 decision.

---

## 7. No-Code Decisions Needed (block implementation until answered)

These are **semantic** choices. Picking the wrong one is much more expensive than implementing the right one.

### 7.1 Should `chainId` be a stored field or derived?

* **Stored** (recommendation): saves recursive walks; one extra column. Backfill required when added later.
* **Derived**: smaller doc; every chain query becomes a recursive `$graphLookup`.

**Default if no answer**: stored.

### 7.2 When is the supersede link established — at draft creation or at deliver?

* **At deliver** (recommendation): draft remains silent and content-mutable. Atomically links only when commercial commitment is made.
* **At draft creation**: explicit "this draft will replace X". Loses silence — a draft pointer is metadata that could leak through admin tooling. Also wrong if the provider abandons the draft.

**Default if no answer**: at deliver.

### 7.3 Should provider be allowed to revoke their own v1 when delivering v2?

* **No** (recommendation): only admin revokes. Provider's clean-up tool is "deliver v2"; v1 stays as historical truth.
* **Yes (provider revoke)**: tempting but adds a new permission to the lifecycle that didn't exist before. Out of Phase 9 scope.

**Default if no answer**: no.

### 7.4 Notification preview for v2: include "(v2)" or not?

* **Yes** (recommendation): disambiguates two notification rows from the same provider on the same request.
* **No**: simpler wire contract. Risk: customer sees two identical-looking rows.

**Default if no answer**: yes, append "(vN)" when N > 1.

### 7.5 `deliveredOffersCount` semantics post-versioning

* **Raw count** (recommendation): a request with v1 declined and v2 delivered = 1 (only v2 in `delivered`). A request with v1 delivered AND v2 delivered = 2. Each is a separate commercial commitment.
* **Collapse-by-chain**: same setups would give 1 and 1. Loses the "two alive versions, both decidable" signal.

**Default if no answer**: raw count (i.e. no code change to Step-2 logic).

### 7.6 Should the UI show the FULL chain or only adjacent (prev / next) links?

* **Adjacent only** (recommendation): card on v2 mentions "Supersedes v1" with focusPackageId-link. Card on v1 mentions "Superseded by v2" with focusPackageId-link. UI never renders a 4-deep timeline.
* **Full chain expand**: heavier UI; opens the door to "package history modal" which is the next slippery slope.

**Default if no answer**: adjacent only.

### 7.7 What about `revoked` mid-chain?

If v1 delivered, then admin revokes v1, then provider delivers v2: should v2 still set `supersedesId=v1._id`?
* **Yes** (recommendation): lineage is "what came before", not "what was valid". History stays truthful.
* **No**: v2 is "fresh start". But then the chain breaks and audit becomes harder.

**Default if no answer**: yes.

### 7.8 Can provider open a NEW chain on the same request (e.g. completely different car)?

Today nothing forbids this — provider can create unlimited drafts. After Phase 9, do all of them share the same chain because they're on the same request?
* **One chain per request** (simplest): every draft on this request is a candidate v_n+1 of the same chain.
* **Multiple chains** (more truthful): each "first" delivered creates a new chain root. Allows "I withdrew car A's offer, now I'm offering car B".

**Default if no answer**: this is genuinely ambiguous. I'd lean **multiple chains** — but it must be an explicit answer because §4.1's `chainId` shape depends on it. Brief decision before implementation.

### 7.9 Concurrent v2 deliveries (theoretical)

If two provider sessions both call `/deliver` on different drafts at the same instant, both will look up the same predecessor and both will think they're v2. Result: two docs with `supersedesId=v1._id, version=2`, and predecessor's `supersededById` will end up pointing to whichever write landed second.

* **Live with it**: provider rarely has two parallel sessions; if it happens, admin can sort out via revoke.
* **Add an atomic CAS**: predecessor update must use `{_id: prev._id, supersededById: null}` filter, and if it fails, retry to find the new predecessor.

**Default if no answer**: add CAS — small cost, prevents lineage forks.

### 7.10 Should we add tests for "no supersede" path?

Yes — all existing tests already test "single v1" flows. They MUST continue passing. Adding `assert pkg.version == 1` to every existing test increases coverage of the invariant without changing behaviour. Cheap, recommended.

---

## 8. Appendix — Files touched by Phase 9 (estimate)

Read-only inventory of files that WOULD need edits at implementation time. Listed for impact estimation only — not a commit list.

**Backend (write)**:
* `app/offer_packages/repository.py` — create_draft, apply_transition, _project, ensure_indices, new find_latest_delivered_for_provider
* `app/offer_packages/models.py` — OfferPackageOut adds 3 optional fields
* `app/offer_packages/notifier.py` — preview formatting only
* `app/offer_packages/lifecycle.py` — NO CHANGE (this is the key invariant)
* `app/car_selection/router_customer.py` — NO CHANGE (count semantics decided by §7.5)

**Frontend (write)**:
* `src/components/OfferPackageBlock.tsx` — adjacent-link banners on cards
* `src/i18n/locales/{en,ru,de}.json` — banner strings + version-in-preview strings

**Tests (write)**:
* `/app/tests/offer_packages/test_offer_packages_versioning_e2e.py` — NEW, 6.1 + 6.3
* `/app/tests/offer_packages/test_offer_packages_e2e.py` — minor additions (`assert pkg.version == 1` in existing flows, per 7.10)

**Backend (read-only audit, do not modify)**:
* `app/car_selection/lifecycle.py` — request lifecycle, unrelated
* `app/car_selection_thread/repository.py` — notification storage, unrelated
* `app/offer_packages/__init__.py` — docstring update only

---

## 9. Final word

**Backend currently has NO partial supersede implementation.** The mentions of `version` and `supersedesId` are documentation-only placeholders. Phase 9 is starting from a clean foundation, not from a half-built one. This is the best possible posture for a versioning expansion.

**Implementation requires answers to §7.1–§7.9 before any code is written.** §7.8 is the most consequential — it determines the chain identity model.

End of archaeology.
