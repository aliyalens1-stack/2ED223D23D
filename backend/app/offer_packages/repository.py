"""offer_packages — data access.

One collection:

    car_selection_offer_packages

Indices:
    (requestId, status, updatedAt -1)   — list-by-request / customer view
    (providerId, status, updatedAt -1)  — provider "my drafts" / "my delivered"
    (status, deliveredAt -1)            — admin governance backlog

Discipline:
    * Content fields (title/summary/price/currency/artifactIds) are
      ONLY mutable while status == 'draft'. The freeze is enforced
      in update_draft() — any caller bypassing it is a bug.
    * Status transitions go through apply_transition() which writes
      a timeline entry and stamps deliveredAt / decidedAt /
      decidedBy as appropriate.
    * Resolving artifactIds is delegated to the existing artifacts
      module — Offer Packages reference the same immutable evidence
      pool as the thread, so we never re-implement upload / mime
      gate / cross-request checks.
    * No `update_message`/`delete` analogues. Drafts can be edited;
      everything past `draft` is forensic-safe.
"""
from __future__ import annotations
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional, Tuple

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.car_selection.repository import CarSelectionRepository
from app.car_selection.lifecycle import TERMINAL_STATUSES as REQUEST_TERMINAL
from app.car_selection_thread.artifacts import (
    ArtifactRepository,
    resolve_attachment_ids,
)
from app.offer_packages.lifecycle import (
    ALLOWED_TRANSITIONS,
    PROVIDER_EDITABLE_STATUSES,
    is_transition_allowed,
)
from app.offer_packages.models import UpdateDraftIn


COLLECTION = "car_selection_offer_packages"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _err(http_status: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=http_status,
        detail={
            "error": True, "code": code, "message": message,
            "details": details or {},
        },
    )


def _not_found(package_id: str) -> HTTPException:
    """Existence-privacy 404. Used for both unknown ids and ids the
    caller cannot see (e.g. a draft from a different provider)."""
    return _err(
        404, "OFFER_PACKAGE_NOT_FOUND",
        f"offer package {package_id!r} not found",
        packageId=package_id,
    )


@dataclass(frozen=True)
class _RequestRef:
    """Tiny projection of the parent Car-Selection request we need
    while validating package operations. Keeps the repo decoupled
    from CarSelectionRepository's response shape."""
    id: str
    status: str
    customer_id: str
    provider_id: Optional[str]


class OfferPackageRepository:
    """Thin async wrapper over `car_selection_offer_packages`.

    The repo is request-aware: every mutation takes the parent
    request doc (or its projection) and uses it to enforce
    cross-context invariants:
      * artifacts must belong to the same request
      * delivering against a terminal request is rejected
      * provider ownership is matched against the request's
        assignedProviderId at create-time
    """

    def __init__(self, db: AsyncIOMotorDatabase):
        self._db = db
        self._coll = db[COLLECTION]
        self._selection = CarSelectionRepository(db)
        self._artifacts = ArtifactRepository(db)

    # ── Indices ──────────────────────────────────────────────────────

    async def ensure_indices(self) -> None:
        await self._coll.create_index([
            ("requestId", 1), ("status", 1), ("updatedAt", -1),
        ])
        await self._coll.create_index([
            ("providerId", 1), ("status", 1), ("updatedAt", -1),
        ])
        await self._coll.create_index([("status", 1), ("deliveredAt", -1)])
        # Phase 9 — Offer Package Versioning (decision 7.1 + 7.8):
        # chain walk is `requestId + chainId` ordered by version desc.
        # The composite includes requestId so admin governance queries
        # remain bounded to one request even with high chain counts.
        await self._coll.create_index([
            ("requestId", 1), ("chainId", 1), ("version", -1),
        ])

    # ── Helpers ──────────────────────────────────────────────────────

    async def _load_request_ref(self, request_id: str) -> _RequestRef:
        """Read the parent request and project to a small ref. Raises
        the standard CAR_SELECTION_NOT_FOUND envelope on miss so the
        client sees the same code regardless of surface."""
        doc = await self._selection.get_by_id(request_id)
        if doc is None:
            raise _err(
                404, "CAR_SELECTION_NOT_FOUND",
                f"request {request_id!r} not found",
                requestId=request_id,
            )
        return _RequestRef(
            id=str(doc["_id"]),
            status=doc.get("status", "submitted"),
            customer_id=doc.get("customerId", ""),
            provider_id=doc.get("assignedProviderId"),
        )

    @staticmethod
    def _assert_request_open(ref: _RequestRef) -> None:
        if ref.status in REQUEST_TERMINAL:
            raise _err(
                409, "OFFER_PACKAGE_REQUEST_TERMINAL",
                "parent request is terminal; cannot add or change packages",
                requestStatus=ref.status,
            )

    async def _project(self, doc: Mapping[str, Any], *, surface: str) -> Dict[str, Any]:
        """Expand the stored doc into the API projection, resolving
        artifact ids to the full ArtifactOut shape. We do this on read
        rather than write so an artifact url's surface (provider vs
        customer download path) is correct per caller.
        """
        artifact_ids: List[str] = list(doc.get("artifactIds") or [])
        resolved: List[Dict[str, Any]] = []
        for aid in artifact_ids:
            adoc = await self._artifacts.get(aid)
            if not adoc:
                # Artifact must not vanish — but if it ever does (manual
                # ops, future migration), keep the package usable and
                # surface the missing id rather than crashing the list.
                resolved.append({
                    "id": aid,
                    "missing": True,
                })
                continue
            resolved.append(self._artifacts.to_out(adoc, surface=surface))

        return {
            "id":             doc["_id"],
            "requestId":      doc["requestId"],
            "providerId":     doc["providerId"],
            "version":        int(doc.get("version", 1)),
            "status":         doc["status"],
            # Phase 9 — versioning fields. Legacy docs predating
            # Phase 9 won't have chainId; we fall back to the package
            # id itself, which yields a singleton chain (no revisions
            # exist for those docs, so the substitute is observably
            # equivalent).
            "chainId":        doc.get("chainId") or doc["_id"],
            "parentId":       doc.get("parentId"),
            "supersedesId":   doc.get("supersedesId"),
            "supersededById": doc.get("supersededById"),
            "lineage": {
                "previousId": doc.get("supersedesId"),
                "nextId":     doc.get("supersededById"),
            },
            "title":        doc.get("title"),
            "summary":      doc.get("summary"),
            "priceCents":   doc.get("priceCents"),
            "currency":     doc.get("currency"),
            "artifactIds":  artifact_ids,
            "artifacts":    resolved,
            "createdAt":    doc["createdAt"],
            "updatedAt":    doc["updatedAt"],
            "deliveredAt":  doc.get("deliveredAt"),
            "decidedAt":    doc.get("decidedAt"),
            "decidedBy":    doc.get("decidedBy"),
            "decidedNote":  doc.get("decidedNote"),
            "timeline":     list(doc.get("timeline") or []),
        }

    # ── Reads ────────────────────────────────────────────────────────

    async def get(self, package_id: str) -> Optional[Dict[str, Any]]:
        return await self._coll.find_one({"_id": package_id})

    async def list_for_request(
        self,
        *,
        request_id: str,
        statuses: Optional[List[str]] = None,
        provider_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        q: Dict[str, Any] = {"requestId": request_id}
        if statuses:
            q["status"] = {"$in": list(statuses)}
        if provider_id:
            q["providerId"] = provider_id
        cur = self._coll.find(q).sort("updatedAt", -1).limit(limit)
        return [d async for d in cur]

    async def count_delivered_by_request_ids(
        self,
        request_ids: List[str],
    ) -> Dict[str, int]:
        """Server-side projection for customer list-view chips.

        Returns ``{requestId: count}`` where count is the number of
        offer packages currently in the ``delivered`` lifecycle state
        for that request. By construction this is also the count of
        packages "non-terminal AND visible to customer" — terminal
        statuses (accepted/declined/revoked) and ``draft`` (provider
        private) are filtered out.

        Discipline:
          * Server-side only. Frontends MUST NOT aggregate via the
            list-by-request endpoint, because that opens the door to
            UI accidentally owning visibility semantics.
          * Only ``status == 'delivered'`` is counted. We do NOT
            collapse the count across `supersedesId` chains; that
            decision is reserved for Phase 9 versioning. Until then
            there is at most one delivered package per (request,
            provider) by lifecycle definition, so the raw count is
            already correct for the intended UX.
          * Missing requestIds yield 0 — callers can `.get(rid, 0)`
            without a KeyError dance.
        """
        if not request_ids:
            return {}
        pipeline = [
            {"$match": {"requestId": {"$in": list(request_ids)}, "status": "delivered"}},
            {"$group": {"_id": "$requestId", "n": {"$sum": 1}}},
        ]
        out: Dict[str, int] = {rid: 0 for rid in request_ids}
        async for row in self._coll.aggregate(pipeline):
            out[row["_id"]] = int(row.get("n", 0))
        return out

    # ── Create draft ─────────────────────────────────────────────────

    async def create_draft(
        self,
        *,
        request_id: str,
        provider_id: str,
        initial_content: Mapping[str, Any],
    ) -> Dict[str, Any]:
        """Insert a brand-new draft owned by `provider_id`.

        The caller is expected to have already verified:
          * the request exists and is non-terminal
          * the caller is the assigned provider (or admin acting on
            behalf — admin creation isn't surfaced in v1 routers but
            the repo does not forbid it; the router gate is the only
            policy layer for who can call this)
        """
        ref = await self._load_request_ref(request_id)
        self._assert_request_open(ref)

        # Pre-validate artifact ids if present — fail fast before we
        # ever write a document. resolve_attachment_ids handles the
        # cross-request smuggle check.
        artifact_ids = list(initial_content.get("artifactIds") or [])
        if artifact_ids:
            await resolve_attachment_ids(
                self._artifacts,
                request_id=request_id,
                ids=artifact_ids,
                surface="provider",  # surface only matters for the URL we throw away
            )

        now = _iso(_now())
        doc: Dict[str, Any] = {
            "_id": uuid.uuid4().hex,
            "requestId": request_id,
            "providerId": provider_id,
            "version": 1,
            # Phase 9 — Offer Package Versioning (decision 7.1 + 7.8):
            # every new draft mints its OWN chainId. A request may have
            # arbitrarily many independent commercial lines (BMW
            # shortlist, Audi shortlist, negotiation result, …) and we
            # never want a v2 of one line to artificially supersede a
            # v1 of another. chainId is therefore the identity of the
            # commercial line and is fixed at create-time — `revise`
            # is the only path that inherits it.
            "chainId": uuid.uuid4().hex,
            "parentId": None,
            "supersedesId": None,
            "supersededById": None,
            "status": "draft",
            "title":       initial_content.get("title"),
            "summary":     initial_content.get("summary"),
            "priceCents":  initial_content.get("priceCents"),
            "currency":    initial_content.get("currency"),
            "artifactIds": artifact_ids,
            "createdAt": now,
            "updatedAt": now,
            "deliveredAt": None,
            "decidedAt":   None,
            "decidedBy":   None,
            "decidedNote": None,
            "timeline": [{
                "type": "created",
                "at": now,
                "actorId": provider_id,
                "actorRole": "provider",
            }],
        }
        await self._coll.insert_one(doc)
        return dict(doc)

    # ── Create revision (Phase 9) ────────────────────────────────────

    async def create_revision(
        self,
        *,
        predecessor_id: str,
        provider_id: str,
    ) -> Dict[str, Any]:
        """Phase 9 — start a v(N+1) draft inside an existing chain.

        Pre-conditions (all 409 OFFER_PACKAGE_NOT_REVISABLE on miss):
          * predecessor exists and belongs to `provider_id`
          * predecessor.status == 'delivered'  (decision: only the
            committed v(N) can spawn a successor; revising a draft
            would be a duplicate draft, not a revision)
          * predecessor.supersededById is None  (the chain head is the
            only legal point to grow from; once a v3 is delivered, the
            v2 → v3 link is closed and re-revising v2 is forbidden)

        The new draft:
          * inherits `chainId` from the predecessor
          * sets `version = predecessor.version + 1`
          * stores `parentId = predecessor.id` for provenance — this
            is INDEPENDENT of `supersedesId`, which stays None until
            the new draft actually delivers (decision 7.2)
          * copies title / summary / price / currency / artifactIds
            from the predecessor as the starting content — provider
            can edit before delivering

        Note on artifacts: we copy the artifact IDs as-is. Artifacts
        are immutable cross-request-checked blobs already, so this
        is referentially safe; if the provider wants a different
        evidence set on v2, they patch artifactIds before delivering.
        """
        pred = await self.get(predecessor_id)
        if pred is None:
            raise _not_found(predecessor_id)
        if pred.get("providerId") != provider_id:
            # Existence-privacy: foreign providers' packages 404.
            raise _not_found(predecessor_id)

        if pred.get("status") != "delivered":
            raise _err(
                409, "OFFER_PACKAGE_NOT_REVISABLE",
                "only delivered packages can spawn a revision",
                packageId=predecessor_id,
                status=pred.get("status"),
            )
        if pred.get("supersededById"):
            raise _err(
                409, "OFFER_PACKAGE_NOT_REVISABLE",
                "predecessor is already superseded — revise the latest version instead",
                packageId=predecessor_id,
                supersededById=pred.get("supersededById"),
            )

        ref = await self._load_request_ref(pred["requestId"])
        self._assert_request_open(ref)

        now = _iso(_now())
        new_id = uuid.uuid4().hex
        chain_id = pred.get("chainId") or predecessor_id  # legacy fallback
        next_version = int(pred.get("version", 1)) + 1

        doc: Dict[str, Any] = {
            "_id": new_id,
            "requestId": pred["requestId"],
            "providerId": provider_id,
            "version": next_version,
            "chainId": chain_id,
            "parentId": predecessor_id,
            # supersedesId stays None until deliver (decision 7.2).
            "supersedesId": None,
            "supersededById": None,
            "status": "draft",
            "title":       pred.get("title"),
            "summary":     pred.get("summary"),
            "priceCents":  pred.get("priceCents"),
            "currency":    pred.get("currency"),
            "artifactIds": list(pred.get("artifactIds") or []),
            "createdAt": now,
            "updatedAt": now,
            "deliveredAt": None,
            "decidedAt":   None,
            "decidedBy":   None,
            "decidedNote": None,
            "timeline": [{
                "type": "created",
                "at": now,
                "actorId": provider_id,
                "actorRole": "provider",
                "data": {
                    "kind": "revision",
                    "parentId": predecessor_id,
                    "version": next_version,
                    "chainId": chain_id,
                },
            }],
        }
        await self._coll.insert_one(doc)
        return dict(doc)

    # ── Update draft ─────────────────────────────────────────────────

    async def update_draft(
        self,
        *,
        package_id: str,
        actor_id: str,
        actor_role: str,
        patch: UpdateDraftIn,
    ) -> Dict[str, Any]:
        """Mutate a DRAFT package's content.

        Freeze guard:
            anything other than status='draft' raises 409
            OFFER_PACKAGE_FROZEN. We deliberately do not return the
            doc unchanged on a no-op: empty patches still update
            `updatedAt` to reflect provider activity (helps sort).
        """
        doc = await self.get(package_id)
        if doc is None:
            raise _not_found(package_id)

        # Provider may only edit their own drafts; admin may edit any
        # draft (route layer decides who reaches here).
        if actor_role == "provider" and doc.get("providerId") != actor_id:
            raise _not_found(package_id)

        if doc["status"] not in PROVIDER_EDITABLE_STATUSES:
            raise _err(
                409, "OFFER_PACKAGE_FROZEN",
                "package is no longer editable",
                status=doc["status"],
            )

        # The parent request must still be open. Otherwise edits are
        # meaningless (admin will reject delivery anyway).
        ref = await self._load_request_ref(doc["requestId"])
        self._assert_request_open(ref)

        # Only apply fields the caller actually set. Sending null
        # explicitly clears a nullable field; missing fields are
        # left alone.
        update_doc: Dict[str, Any] = {}
        explicit = patch.model_fields_set
        for field in ("title", "summary", "priceCents", "currency", "artifactIds"):
            if field in explicit:
                value = getattr(patch, field)
                if field == "artifactIds":
                    new_ids = list(value or [])
                    if new_ids:
                        # Re-validate; the artifacts module raises
                        # ARTIFACT_NOT_FOUND / ARTIFACT_CROSS_REQUEST.
                        await resolve_attachment_ids(
                            self._artifacts,
                            request_id=doc["requestId"],
                            ids=new_ids,
                            surface="provider",
                        )
                    update_doc[field] = new_ids
                else:
                    update_doc[field] = value

        now = _iso(_now())
        update_doc["updatedAt"] = now

        await self._coll.update_one(
            {"_id": package_id, "status": "draft"},
            {"$set": update_doc},
        )
        return await self.get(package_id) or doc

    # ── Status transitions ───────────────────────────────────────────

    async def apply_transition(
        self,
        *,
        package_id: str,
        target_status: str,
        actor_id: str,
        actor_role: str,
        note: Optional[str] = None,
    ) -> Tuple[Dict[str, Any], str]:
        """Move a package from its current status to `target_status`.

        Returns `(updated_doc, prior_status)`.

        Raises:
            404 OFFER_PACKAGE_NOT_FOUND  — unknown id
            409 OFFER_PACKAGE_INVALID_TRANSITION — adjacency violation
            409 OFFER_PACKAGE_EMPTY_DELIVER — deliver() with no content
        """
        doc = await self.get(package_id)
        if doc is None:
            raise _not_found(package_id)

        current = doc["status"]
        if not is_transition_allowed(current, target_status):
            raise _err(
                409, "OFFER_PACKAGE_INVALID_TRANSITION",
                f"cannot move {current!r} → {target_status!r}",
                currentStatus=current,
                targetStatus=target_status,
                allowed=sorted(ALLOWED_TRANSITIONS.get(current, [])),
            )

        # Special-case `delivered` — refuse to publish an empty shell.
        # A deliverable with no title AND no summary AND no artifacts
        # has no commercial content and is almost certainly a misclick.
        if target_status == "delivered":
            has_content = bool(
                (doc.get("title") or "").strip()
                or (doc.get("summary") or "").strip()
                or doc.get("artifactIds")
            )
            if not has_content:
                raise _err(
                    409, "OFFER_PACKAGE_EMPTY_DELIVER",
                    "package needs a title, a summary, or at least one artifact",
                    packageId=package_id,
                )

        # Phase 9 — CAS on supersede (decision 7.9).
        # If this draft was spawned as a revision (parentId set), we
        # MUST atomically claim the predecessor's `supersededById`
        # slot BEFORE flipping our own status. Two concurrent v2
        # drafts in the same chain would each try to claim the slot;
        # exactly one update_one matches (parentId+status delivered+
        # supersededById null), the other returns matched_count=0 and
        # the losing transition fails with 409. The losing draft is
        # left untouched in `draft` status — the provider can fetch
        # the now-newer head and decide whether to revise that
        # instead.
        supersedes_id_to_stamp: Optional[str] = None
        if target_status == "delivered" and doc.get("parentId"):
            parent_id = doc["parentId"]
            cas_res = await self._coll.update_one(
                {
                    "_id": parent_id,
                    "status": "delivered",
                    "supersededById": None,
                },
                {"$set": {"supersededById": package_id}},
            )
            if cas_res.matched_count == 0:
                raise _err(
                    409, "OFFER_PACKAGE_SUPERSEDE_RACE",
                    "predecessor was already superseded or is no longer the chain head",
                    packageId=package_id,
                    parentId=parent_id,
                )
            supersedes_id_to_stamp = parent_id

        # Special-case `accepted`/`declined`/`revoked` — record actor.
        now = _iso(_now())
        update_doc: Dict[str, Any] = {
            "status": target_status,
            "updatedAt": now,
        }
        if target_status == "delivered":
            update_doc["deliveredAt"] = now
            if supersedes_id_to_stamp is not None:
                update_doc["supersedesId"] = supersedes_id_to_stamp
        if target_status in {"accepted", "declined", "revoked"}:
            update_doc["decidedAt"] = now
            update_doc["decidedBy"] = actor_id
            if note:
                update_doc["decidedNote"] = note

        event = {
            "type": f"status:{target_status}",
            "at": now,
            "actorId": actor_id,
            "actorRole": actor_role,
            "data": {"from": current, "to": target_status},
        }
        if supersedes_id_to_stamp is not None:
            event["data"]["supersedesId"] = supersedes_id_to_stamp
        if note:
            event["note"] = note

        await self._coll.update_one(
            {"_id": package_id, "status": current},  # CAS guard
            {"$set": update_doc, "$push": {"timeline": event}},
        )
        new_doc = await self.get(package_id)
        if new_doc is None:  # pragma: no cover — unreachable
            raise _not_found(package_id)

        # ── Inbox projection ────────────────────────────────────
        # We project lifecycle events into the SAME notification
        # collection used by the thread notifier. Failure here is
        # logged inside the notifier and never bubbles up — the
        # transition is the source of truth, the inbox is a
        # projection. See app.offer_packages.notifier docstring for
        # the fan-out rules and discipline boundaries.
        try:
            request_doc = await self._db["car_selection_requests"].find_one(
                {"_id": new_doc["requestId"]}
            )
            if request_doc is not None:
                # Local import keeps the notifier optional — if the
                # module ever needs surgery we don't break the repo.
                from app.offer_packages.notifier import (  # noqa: WPS433
                    project_offer_package_event,
                )
                await project_offer_package_event(
                    self._db,
                    package_doc=new_doc,
                    request_doc=request_doc,
                    transition=target_status,
                    actor_id=actor_id,
                    actor_role=actor_role,
                )
        except Exception:  # pragma: no cover — defensive
            # The notifier itself is supposed to be self-contained on
            # errors. This outer try is the final safety net to
            # guarantee that an inbox glitch never rolls back a
            # committed commercial decision.
            import logging
            logging.getLogger("offer_packages.repository").exception(
                "offer_package inbox projection failed (package=%s, transition=%s)",
                package_id, target_status,
            )

        return new_doc, current

    # ── Convenience: list + project ──────────────────────────────────

    async def list_projected(
        self,
        *,
        request_id: str,
        surface: str,
        statuses: Optional[List[str]] = None,
        provider_id: Optional[str] = None,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        docs = await self.list_for_request(
            request_id=request_id,
            statuses=statuses,
            provider_id=provider_id,
            limit=limit,
        )
        return [await self._project(d, surface=surface) for d in docs]

    async def get_projected(
        self,
        *,
        package_id: str,
        surface: str,
    ) -> Optional[Dict[str, Any]]:
        doc = await self.get(package_id)
        if doc is None:
            return None
        return await self._project(doc, surface=surface)


__all__ = [
    "COLLECTION",
    "OfferPackageRepository",
]
