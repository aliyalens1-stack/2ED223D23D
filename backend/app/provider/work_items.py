"""app.provider.work_items — Provider Workbench v1 projector.

Doctrine (see /app/memory/PRD.md):
    "Provider Workbench is not a workflow engine.
     It is a provider-facing operational projection over existing truths."

This module is a READ-ONLY projector:
  - reads from db.bookings, db.inspection_jobs, db.inspection_reports,
    db.quick_request_offers, db.quick_requests
  - produces ProviderWorkItem dicts (shape: shared/domain/contracts/provider-work-item.ts)
  - does NOT define a state machine
  - does NOT write to any new collection
  - does NOT introduce new lifecycle states

If a UI need surfaces a new distinction, the rule is: grow `ProviderWorkItemState`
HERE (and in the TS contract) — never grow it in the surface.

Identity contract:
  - `viewer_user_id`     = users._id (string)        — needed for inspection-jobs
  - `viewer_provider_slug` = organizations.slug      — needed for bookings/QR offers

The projector resolves both from the authenticated principal up the call stack.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from typing import Optional

from app.core.db import get_db


# ── State / verb constants (mirror shared/domain/contracts/provider-work-item.ts) ──

S_NEEDS_RESPONSE   = "needs_response"
S_SCHEDULED        = "scheduled"
S_EN_ROUTE         = "en_route"
S_ON_SITE          = "on_site"
S_IN_PROGRESS      = "in_progress"
S_REPORT_REQUIRED  = "report_required"
S_AWAITING_CUST    = "awaiting_customer"
S_AWAITING_REVIEW  = "awaiting_review"
S_AWAITING_PAYOUT  = "awaiting_payout"   # reserved for Phase 3 — projector currently never emits
S_COMPLETED        = "completed"
S_BLOCKED          = "blocked"

# Verbs the projector may attach as primaryAction.
V_ACCEPT         = "accept"
V_REJECT         = "reject"
V_DEPART         = "depart"
V_ARRIVE         = "arrive"
V_START          = "start"
V_COMPLETE       = "complete"
V_SUBMIT_REPORT  = "submit_report"


# ── Booking taxonomy → provider perception ──
# Source booking lifecycle: confirmed → on_route → arrived → in_progress → completed.
# Phase 1 keeps the mapping conservative: terminal financial states have no
# orthogonal projection yet, so `completed` lands in S_COMPLETED.
_BOOKING_STATE = {
    "confirmed":   S_SCHEDULED,
    "on_route":    S_EN_ROUTE,
    "arrived":     S_ON_SITE,
    "in_progress": S_IN_PROGRESS,
    "completed":   S_COMPLETED,
}
# Bookings in these states are excluded from the provider's perception entirely.
_BOOKING_EXCLUDED = {"cancelled", "no_show", "expired", "rejected", "timeout"}

# Action attached per booking state. Picks the next forward verb only.
_BOOKING_PRIMARY_ACTION = {
    S_SCHEDULED:    (V_DEPART,   "Я выезжаю",        False),
    S_EN_ROUTE:     (V_ARRIVE,   "Я на месте",       False),
    S_ON_SITE:      (V_START,    "Начать работу",    False),
    S_IN_PROGRESS:  (V_COMPLETE, "Завершить работу", True),
    S_COMPLETED:    None,
}


# ── Inspection taxonomy → provider perception ──
# Source job lifecycle: open → claimed → on_route → arrived → inspecting → done.
# Plus reports lifecycle: submitted → approved | rejected.
_INSPECTION_JOB_STATE = {
    "claimed":    S_SCHEDULED,
    "on_route":   S_EN_ROUTE,
    "arrived":    S_ON_SITE,
    "inspecting": S_IN_PROGRESS,
    # 'done' is special: projector decides between report_required / awaiting_review
    # / completed / blocked based on the linked inspection_reports doc.
}
_INSPECTION_EXCLUDED = {"open", "cancelled"}

_INSPECTION_PRIMARY_ACTION = {
    S_SCHEDULED:        (V_DEPART,        "Я выезжаю",          False),
    S_EN_ROUTE:         (V_ARRIVE,        "Я на месте",         False),
    S_ON_SITE:          (V_START,         "Начать осмотр",      False),
    S_IN_PROGRESS:      (V_COMPLETE,      "Завершить осмотр",   False),  # transitions to done w/o report
    S_REPORT_REQUIRED:  (V_SUBMIT_REPORT, "Загрузить отчёт",    True),
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt) -> Optional[str]:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    return str(dt)


def _entered_state_at_for_booking(b: dict, state: str) -> str:
    """Best-effort timestamp for `enteredCurrentStateAt`. Falls back gracefully."""
    field = {
        S_SCHEDULED:   "acceptedAt",
        S_EN_ROUTE:    "departedAt",
        S_ON_SITE:     "arrivedAt",
        S_IN_PROGRESS: "startedAt",
        S_COMPLETED:   "completedAt",
    }.get(state)
    return _iso(b.get(field) if field else None) or _iso(b.get("updatedAt")) or _iso(b.get("createdAt")) or _now().isoformat()


def _entered_state_at_for_job(j: dict, state: str) -> str:
    field = {
        S_SCHEDULED:   "claimedAt",
        S_EN_ROUTE:    "onRouteAt",
        S_ON_SITE:     "arrivedAt",
        S_IN_PROGRESS: "inspectionStartedAt",
    }.get(state)
    val = j.get(field) if field else None
    return _iso(val) or _iso(j.get("completedAt")) or _iso(j.get("createdAt")) or _now().isoformat()


def _action(verb_label: Optional[tuple]) -> Optional[dict]:
    if not verb_label:
        return None
    verb, label, confirm = verb_label
    return {"verb": verb, "label": label, "confirmationRequired": bool(confirm)}


# ── Per-source projectors ────────────────────────────────────────────

def project_quick_request_offer(offer: dict, qr: dict) -> Optional[dict]:
    """Active QR offer → `needs_response` work item. Returns None if not actionable."""
    if offer.get("status") != "pending":
        return None
    if qr.get("status") != "searching":
        return None

    # Time anchors
    expires_iso = qr.get("expiresAt")
    expires_at = None
    seconds_left = 0
    if expires_iso:
        try:
            expires_at = datetime.fromisoformat(expires_iso)
            seconds_left = max(0, int((expires_at - _now()).total_seconds()))
        except Exception:
            pass
    if seconds_left <= 0:
        return None

    # Price snapshot — find this provider's slot in topSolutions
    snapshot = next(
        (s for s in (qr.get("topSolutions") or []) if s.get("slug") == offer.get("providerSlug")),
        {},
    )
    price_amount = int(snapshot.get("finalPrice") or snapshot.get("priceFrom") or 0)
    surge = float(qr.get("surge") or 1.0)

    return {
        "id":   f"qr_{qr['id']}",
        "kind": "booking",   # offer materialises into a booking on accept
        "state": S_NEEDS_RESPONSE,
        "primaryAction": {
            "verb":  V_ACCEPT,
            "label": "Принять",
            "confirmationRequired": False,
        },
        # `accept` is the primary; the UI also surfaces a secondary `reject` button
        # by reading `state === 'needs_response'`. We don't model two simultaneous
        # primary verbs — UI convention is enough.
        "scheduledFor": None,
        "enteredCurrentStateAt": _iso(qr.get("createdAt")) or _now().isoformat(),
        "expectedActionBy": _iso(expires_at) if expires_at else None,
        "priceShown": {
            "amount":   price_amount,
            "currency": qr.get("currency") or "EUR",
            "surge":    surge if surge > 1.0 else None,
        },
        "customer": {
            "name":       (qr.get("addressHint") or "Customer").split(",")[0][:40],
            "address":    qr.get("addressHint"),
            "distanceKm": float(snapshot.get("distance")) if snapshot.get("distance") is not None else None,
        },
        "serviceLabel": qr.get("problemLabel") or "Quick service",
    }


def project_booking(b: dict) -> Optional[dict]:
    """`db.bookings` row → ProviderWorkItem. None for excluded statuses."""
    raw = (b.get("status") or "").strip()
    if raw in _BOOKING_EXCLUDED:
        return None
    state = _BOOKING_STATE.get(raw)
    if not state:
        # Unknown statuses are not surfaced — the projector is conservative.
        return None

    primary = _action(_BOOKING_PRIMARY_ACTION.get(state))

    return {
        "id":   f"bk_{b.get('id')}",
        "kind": "booking",
        "state": state,
        "primaryAction": primary,
        "scheduledFor": _iso(b.get("slotDate") or b.get("scheduledFor")),
        "enteredCurrentStateAt": _entered_state_at_for_booking(b, state),
        "expectedActionBy": None,
        "priceShown": {
            "amount":   int(b.get("finalPrice") or b.get("priceEstimate") or b.get("basePrice") or 0),
            "currency": b.get("currency") or "EUR",
            "surge":    float(b["surge"]) if b.get("surge") and float(b["surge"]) > 1.0 else None,
        },
        "customer": {
            "name":       (b.get("customerName") or "Customer")[:40],
            "address":    b.get("address"),
            "distanceKm": float(b["distanceKm"]) if b.get("distanceKm") is not None else None,
        },
        "serviceLabel": b.get("serviceName") or b.get("problemLabel") or "Service",
    }


def project_inspection(job: dict, report: Optional[dict]) -> Optional[dict]:
    """`db.inspection_jobs` row (+ optional linked report) → ProviderWorkItem."""
    raw = (job.get("status") or "").strip()
    if raw in _INSPECTION_EXCLUDED:
        return None

    # Default state from the simple part of the lifecycle.
    state = _INSPECTION_JOB_STATE.get(raw)

    # 'done' branches based on report status.
    blocked_reason: Optional[dict] = None
    if raw == "done":
        if not report:
            # Job marked done but report not stored yet — provider still owes the report.
            state = S_REPORT_REQUIRED
        else:
            rstatus = (report.get("status") or "").strip()
            if rstatus == "submitted":
                state = S_AWAITING_REVIEW
            elif rstatus == "approved":
                state = S_COMPLETED
            elif rstatus == "rejected":
                state = S_BLOCKED
                blocked_reason = {
                    "code":    "awaiting_admin_review",
                    "message": (report.get("rejectReason") or "Отчёт отклонён — нужны правки").strip()[:200],
                    "contactWho": "admin",
                }
            else:
                state = S_REPORT_REQUIRED

    if state is None:
        return None

    primary = None
    if state in _INSPECTION_PRIMARY_ACTION:
        primary = _action(_INSPECTION_PRIMARY_ACTION[state])

    brand = job.get("brand") or ""
    model = job.get("model") or ""
    service_label = (f"Inspection · {brand} {model}".strip()) or "Inspection"

    item = {
        "id":   f"ij_{job.get('_id') or job.get('id')}",
        "kind": "inspection",
        "state": state,
        "primaryAction": primary,
        "scheduledFor": _iso(job.get("scheduledFor")),
        "enteredCurrentStateAt": _entered_state_at_for_job(job, state),
        "expectedActionBy": None,
        "priceShown": {
            "amount":   int(job.get("budget") or 0),
            "currency": job.get("currency") or "EUR",
            "surge":    None,
        },
        "customer": {
            "name":       (job.get("customerName") or job.get("city") or "Customer")[:40],
            "address":    job.get("address") or job.get("city"),
            "distanceKm": None,
        },
        "serviceLabel": service_label,
    }
    if blocked_reason:
        item["blockedReason"] = blocked_reason
    return item


# ── Top-level projection ─────────────────────────────────────────────

# In the projection, items with these states are sorted to the top.
_STATE_PRIORITY = {
    S_NEEDS_RESPONSE:   0,
    S_BLOCKED:          1,
    S_REPORT_REQUIRED:  2,
    S_IN_PROGRESS:      3,
    S_ON_SITE:          4,
    S_EN_ROUTE:         5,
    S_AWAITING_CUST:    6,
    S_AWAITING_REVIEW:  7,
    S_SCHEDULED:        8,
    S_AWAITING_PAYOUT:  9,
    S_COMPLETED:       10,
}


async def project_all_for_provider(
    *,
    viewer_user_id: str,
    viewer_provider_slug: Optional[str],
    completed_lookback_hours: int = 24,
) -> list[dict]:
    """Build the provider's full perception, sorted by attention priority.

    Strategy:
      - Active items always included (any non-completed state).
      - Completed items included only within `completed_lookback_hours` so the
        list doesn't grow unbounded. UI shows them as a "recently done" tail.
    """
    db = get_db()
    items: list[dict] = []

    cutoff = (_now() - timedelta(hours=completed_lookback_hours)).isoformat()

    # 1. QR offers awaiting my response (needs_response).
    if viewer_provider_slug:
        offers_cur = db.quick_request_offers.find(
            {"providerSlug": viewer_provider_slug, "status": "pending"},
            {"_id": 0},
        ).sort("createdAt", -1).limit(50)
        offers = [o async for o in offers_cur]
        if offers:
            qr_ids = list({o["requestId"] for o in offers if o.get("requestId")})
            qrs = {
                qr["id"]: qr
                async for qr in db.quick_requests.find(
                    {"id": {"$in": qr_ids}},
                    {"_id": 0},
                )
            }
            for o in offers:
                qr = qrs.get(o.get("requestId"))
                if not qr:
                    continue
                wi = project_quick_request_offer(o, qr)
                if wi:
                    items.append(wi)

    # 2. Bookings owned by this provider — active + recent completed.
    if viewer_provider_slug:
        bookings_cur = db.bookings.find(
            {
                "providerSlug": viewer_provider_slug,
                "$or": [
                    {"status": {"$in": ["confirmed", "on_route", "arrived", "in_progress"]}},
                    {"status": "completed", "completedAt": {"$gte": cutoff}},
                ],
            },
            {"_id": 0},
        ).sort("acceptedAt", -1).limit(100)
        async for b in bookings_cur:
            wi = project_booking(b)
            if wi:
                items.append(wi)

    # 3. Inspection jobs assigned to this user.
    jobs_cur = db.inspection_jobs.find(
        {
            "inspectorId": viewer_user_id,
            "$or": [
                {"status": {"$in": ["claimed", "on_route", "arrived", "inspecting"]}},
                {"status": "done", "completedAt": {"$gte": cutoff}},
            ],
        },
    ).sort("createdAt", -1).limit(100)
    jobs = [j async for j in jobs_cur]

    # Bulk-fetch linked reports so projection doesn't N+1 the DB.
    report_ids = [j.get("reportId") for j in jobs if j.get("reportId")]
    reports_by_id: dict = {}
    if report_ids:
        async for r in db.inspection_reports.find({"_id": {"$in": report_ids}}):
            reports_by_id[r["_id"]] = r

    for j in jobs:
        rep = reports_by_id.get(j.get("reportId")) if j.get("reportId") else None
        wi = project_inspection(j, rep)
        if wi:
            items.append(wi)

    # Sort: state priority asc, then enteredCurrentStateAt desc (newest first within bucket).
    items.sort(key=lambda it: (
        _STATE_PRIORITY.get(it["state"], 99),
        # Negative timestamp comparator via reversed string isn't reliable; use plain key + reverse later if needed.
        it.get("enteredCurrentStateAt") or "",
    ))
    return items


# ── Action dispatch (verb → existing transition handlers) ────────────

class WorkItemActionError(Exception):
    """Translated to HTTP 400/404/409 in the router layer."""
    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(message)


async def dispatch_action(
    *,
    item_id: str,
    verb: str,
    viewer_user_id: str,
    viewer_provider_slug: Optional[str],
    idem_key: Optional[str] = None,
) -> dict:
    """Translate (item_id, verb) into the canonical underlying transition.

    Returns the freshly re-projected ProviderWorkItem (via `reproject_one`).

    Phase 1 only handles verbs that have 1:1 backend equivalents. Special
    cases:
      - `submit_report` is intentionally a no-op here. UI navigates to the
        legacy inspector report screen which already calls
        POST /api/inspector/jobs/{id}/report. The projector still LISTS this
        verb (so provider sees what's expected) but the work-items endpoint
        responds 400 — surface code routes instead of POSTing.
      - `accept`/`reject` route to existing quick-request endpoints; we keep
        their atomicity guarantees.

    `idem_key` (optional): forwarded to the booking transition core so retries
    are observationally idempotent end-to-end (Sprint: Provider Dispatch
    Hardening + Action Idempotency).
    """
    if verb == V_SUBMIT_REPORT:
        raise WorkItemActionError(
            400,
            "submit_report is handled by /api/inspector/jobs/{id}/report (UI navigates).",
        )

    db = get_db()

    # Parse opaque id prefix.
    if item_id.startswith("qr_"):
        request_id = item_id[3:]
        if verb not in (V_ACCEPT, V_REJECT):
            raise WorkItemActionError(409, f"Verb '{verb}' not valid on a QR offer")
        if not viewer_provider_slug:
            raise WorkItemActionError(403, "Provider slug not resolvable for this account")
        # Reuse the existing accept/reject handlers' core logic by calling them directly.
        from app.marketplace.quick_request import (
            quick_request_accept as qr_accept,
            quick_request_reject as qr_reject,
        )
        # The legacy handlers expect a Request object with a JSON body. We build a tiny
        # shim so we can call them in-process.
        class _Req:
            def __init__(self, body: dict):
                self._b = body
            async def json(self):
                return self._b
        req = _Req({"providerSlug": viewer_provider_slug})
        if verb == V_ACCEPT:
            await qr_accept(request_id, req)  # type: ignore[arg-type]
        else:
            await qr_reject(request_id, req)  # type: ignore[arg-type]
        # After accept, the QR offer disappears from the projector and a new
        # booking surfaces in `scheduled`. After reject, nothing is left to
        # return — UI removes by id client-side.
        if verb == V_REJECT:
            return {"removed": True, "id": item_id}
        # Find the freshly-created booking to return its projection.
        qr = await db.quick_requests.find_one({"id": request_id}, {"_id": 0, "bookingId": 1})
        booking_id = qr.get("bookingId") if qr else None
        if booking_id:
            b = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
            if b:
                wi = project_booking(b)
                if wi:
                    return {"item": wi}
        # Fallback: caller refetches list.
        return {"removed": True, "id": item_id}

    if item_id.startswith("bk_"):
        booking_id = item_id[3:]
        action_map = {
            V_DEPART:   "depart",
            V_ARRIVE:   "arrive",
            V_START:    "start",
            V_COMPLETE: "complete",
        }
        if verb not in action_map:
            raise WorkItemActionError(409, f"Verb '{verb}' not valid on a booking")

        # Call the canonical transition core directly — no HTTP shim. This
        # preserves auth (caller is already resolved), ownership check,
        # atomic guard, side-effect gating, and Idempotency-Key cache.
        # An Idempotency-Key arriving on the work-items endpoint is scoped
        # `provider_work_item_action` so it cannot collide with raw booking
        # transition keys.
        from app.provider.router import apply_booking_transition  # late: avoid cycle
        from fastapi import HTTPException as _HTTPExc

        try:
            await apply_booking_transition(
                booking_id=booking_id,
                action=action_map[verb],
                caller_user_id=viewer_user_id,
                idem_key=idem_key,
                idem_scope="provider_work_item_action",
            )
        except _HTTPExc as exc:
            # Translate HTTP semantics into the projector's error contract.
            raise WorkItemActionError(exc.status_code, str(exc.detail))

        b = await db.bookings.find_one({"id": booking_id}, {"_id": 0})
        if not b:
            raise WorkItemActionError(404, "Booking disappeared mid-action")
        wi = project_booking(b)
        if not wi:
            return {"removed": True, "id": item_id}
        return {"item": wi}

    if item_id.startswith("ij_"):
        job_id = item_id[3:]
        target_status = {
            V_DEPART:   "on_route",
            V_ARRIVE:   "arrived",
            V_START:    "inspecting",
            V_COMPLETE: None,   # complete-without-report is the deprecated path; not surfaced
        }.get(verb)
        if not target_status:
            raise WorkItemActionError(
                409,
                f"Verb '{verb}' not handled for inspections (use /api/inspector/jobs/{{id}}/report).",
            )
        from app.auto_requests.reports import transition_status as inspection_transition
        job_doc, err = await inspection_transition(job_id, viewer_user_id, target_status)
        if err == "job_not_found":
            raise WorkItemActionError(404, "Inspection job not found")
        if err == "not_your_job":
            raise WorkItemActionError(403, "Not your inspection job")
        if err and err.startswith("invalid_status"):
            raise WorkItemActionError(409, f"Invalid transition: {err}")
        if err:
            raise WorkItemActionError(409, err)
        # Re-fetch raw job + linked report to project.
        j_raw = await db.inspection_jobs.find_one({"_id": job_id})
        if not j_raw:
            raise WorkItemActionError(404, "Inspection job disappeared")
        rep = None
        if j_raw.get("reportId"):
            rep = await db.inspection_reports.find_one({"_id": j_raw["reportId"]})
        wi = project_inspection(j_raw, rep)
        if not wi:
            return {"removed": True, "id": item_id}
        return {"item": wi}

    raise WorkItemActionError(400, f"Unrecognised item id prefix: {item_id}")
