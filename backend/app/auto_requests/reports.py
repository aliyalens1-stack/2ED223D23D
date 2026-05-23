"""Sprint 4 — Inspection Reports + Job Lifecycle service.

Lifecycle: claimed → on_route → arrived → inspecting → done
                                                     ↓
                                                 (report submit)

Credit consumption: ONLY on report submit (anti-fraud).
Cancel: claimed/on_route/arrived/inspecting → released back to "open".
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List, Tuple, Any

from app.core.db import get_db
from app.auto_requests.schemas import SubmitReportRequest, ReportOut
from app.auto_requests.checklist import CHECKLIST

logger = logging.getLogger(__name__)


# Lifecycle gating: who can transition into a status, from which states.
# Empty list means terminal in this direction for inspector.
_INSPECTOR_TRANSITIONS = {
    "on_route":   {"from": ["claimed"]},
    "arrived":    {"from": ["on_route"]},
    "inspecting": {"from": ["arrived"]},
}

# Statuses from which inspector can cancel and release the job back to "open".
_CANCELLABLE_BY_INSPECTOR = {"claimed", "on_route", "arrived", "inspecting"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v)


def _scrub(doc: dict) -> dict:
    """Convert a Mongo doc to a JSON-safe dict (drop _id, isoformat datetimes)."""
    if not doc:
        return {}
    out = dict(doc)
    out.pop("_id", None)
    for k, v in list(out.items()):
        if isinstance(v, datetime):
            out[k] = v.isoformat()
    return out


def _job_to_dict(doc: dict) -> dict:
    """Job projection for inspector/customer screens (lifecycle-aware).

    Forward-compatible: a `brief` and `customerId` subdocument can be set
    on the underlying Mongo doc by upstream pipelines (or seeds) and will
    pass through unchanged. Existing flat fields are preserved for legacy
    consumers that read `brand`/`model`/`city` directly.
    """
    out = {
        "id": str(doc.get("_id", "")),
        "requestId": str(doc.get("requestId", "")),
        "city": doc.get("city", ""),
        "inspectorId": doc.get("inspectorId"),
        "status": doc.get("status", "open"),
        "brand": doc.get("brand", ""),
        "model": doc.get("model", ""),
        "budget": int(doc.get("budget", 0)),
        "createdAt": _iso(doc.get("createdAt")),
        "claimedAt": _iso(doc.get("claimedAt")),
        "onRouteAt": _iso(doc.get("onRouteAt")),
        "arrivedAt": _iso(doc.get("arrivedAt")),
        "inspectionStartedAt": _iso(doc.get("inspectionStartedAt")),
        "completedAt": _iso(doc.get("completedAt")),
        "canceledAt": _iso(doc.get("canceledAt")),
        "reportId": doc.get("reportId"),
    }
    # Forward optional view-model fields used by the web inspector
    # workspace contract (`shared/domain/contracts/inspection-job.ts`).
    # Stripping silently when absent is fine — frontend treats them as
    # optional. This is plumbing, not contract redesign.
    if doc.get("brief") is not None:
        out["brief"] = doc["brief"]
    if doc.get("customerId") is not None:
        out["customerId"] = doc["customerId"]
    if doc.get("updatedAt") is not None:
        out["updatedAt"] = _iso(doc.get("updatedAt"))
    if doc.get("hasReport") is not None:
        out["hasReport"] = bool(doc["hasReport"])
    if doc.get("cancelReason") is not None:
        out["cancelReason"] = doc["cancelReason"]
    # Status projection: backend stores `done` after submit; the web
    # inspector contract calls that `report_ready`. Customer dashboards
    # can still rely on the underlying `done` via the request rollup.
    if out["status"] == "done":
        out["status"] = "report_ready"
    return out


def _report_to_out(doc: dict) -> ReportOut:
    return ReportOut(
        id=str(doc.get("_id", "")),
        jobId=str(doc.get("jobId", "")),
        requestId=str(doc.get("requestId", "")),
        inspectorId=str(doc.get("inspectorId", "")),
        city=doc.get("city", ""),
        brand=doc.get("brand", ""),
        model=doc.get("model", ""),
        score=float(doc.get("score", 0.0)),
        verdict=doc.get("verdict", ""),
        checklist=list(doc.get("checklist", []) or []),
        issues=list(doc.get("issues", []) or []),
        summary=doc.get("summary", ""),
        repairEstimateMin=doc.get("repairEstimateMin"),
        repairEstimateMax=doc.get("repairEstimateMax"),
        status=doc.get("status", "submitted"),
        rejectReason=doc.get("rejectReason"),
        createdAt=_iso(doc.get("createdAt")) or "",
        approvedAt=_iso(doc.get("approvedAt")),
    )


# ──────────────────────────────────────────────────────────────────────
# Lifecycle
# ──────────────────────────────────────────────────────────────────────

async def transition_status(
    job_id: str, inspector_id: str, target_status: str
) -> Tuple[Optional[dict], Optional[str]]:
    """Atomic inspector-driven lifecycle transition.

    Returns (job_dict, error_or_None). Error is a short reason if the
    transition is invalid (404 / 409).
    """
    rule = _INSPECTOR_TRANSITIONS.get(target_status)
    if not rule:
        return None, "unknown_target_status"
    db = get_db()
    now = _now()

    timestamp_field = {
        "on_route": "onRouteAt",
        "arrived": "arrivedAt",
        "inspecting": "inspectionStartedAt",
    }[target_status]

    res = await db.inspection_jobs.find_one_and_update(
        {
            "_id": job_id,
            "inspectorId": inspector_id,
            "status": {"$in": rule["from"]},
        },
        {"$set": {"status": target_status, timestamp_field: now}},
        return_document=True,
    )
    if not res:
        # Diagnose: 404 vs ownership vs wrong status
        existing = await db.inspection_jobs.find_one({"_id": job_id})
        if not existing:
            return None, "job_not_found"
        if existing.get("inspectorId") != inspector_id:
            return None, "not_your_job"
        return None, f"invalid_status:{existing.get('status')}"

    # Sprint 2 Step 1 — durable timeline event per transition
    try:
        from app.inspector.timeline import append_event
        kind_map = {
            "on_route":   "provider_departed",
            "arrived":    "provider_arrived",
            "inspecting": "inspection_started",
        }
        parent_req = await db.car_requests.find_one(
            {"_id": res.get("requestId")}, {"_id": 0, "userId": 1}
        )
        await append_event(
            kind=kind_map[target_status],
            job_id=job_id,
            vehicle_id=res.get("vehicleId"),
            inspector_id=inspector_id,
            customer_id=(parent_req or {}).get("userId"),
            actor_type="inspector",
            actor_id=inspector_id,
            text=f"{res.get('brand', '')} {res.get('model', '')} · {res.get('city', '')}".strip(" ·"),
            metadata={
                "city": res.get("city"),
                "brand": res.get("brand"),
                "model": res.get("model"),
                "requestId": res.get("requestId"),
                "newStatus": target_status,
            },
        )
    except Exception:
        pass

    # Sprint 2 Step 2 — contact visibility reveal (idempotent, side-effect free).
    # The contact layer no longer mutates lifecycle; the lifecycle owns it and
    # informs the contact layer of the new stage via this hook.
    try:
        from app.inspector.contact import record_reveal_for_lifecycle
        await record_reveal_for_lifecycle(
            job=res,
            new_status=target_status,
            inspector_id=inspector_id,
        )
    except Exception:
        pass

    # Phase D Pass 1B — inspection continuity wiring (Step 8A).
    # The transition into `inspecting` is the substrate moment evidence
    # accumulation begins (arrived → inspecting). Earlier transitions
    # (on_route, arrived) are travel/location motion, NOT continuity
    # topology, and intentionally do NOT emit. Coalesce on (job_id)
    # makes the ledger idempotent against duplicate start-inspection
    # calls. Best-effort: ledger failure does not roll back lifecycle.
    if target_status == "inspecting":
        try:
            from app.runtime_ledger import emit, EventType
            await emit(
                EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION,
                subject_id=job_id,
                payload={},
                emitted_by=inspector_id,
            )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                f"runtime_ledger emit (entered_accumulation) failed for job {job_id}: {exc}"
            )

    return _job_to_dict(res), None


async def cancel_by_inspector(
    job_id: str, inspector_id: str, reason: Optional[str] = None
) -> Tuple[Optional[dict], Optional[str]]:
    """Inspector cancels — job is released back to `open`. Credits stay reserved."""
    db = get_db()
    now = _now()
    job = await db.inspection_jobs.find_one(
        {"_id": job_id, "inspectorId": inspector_id}
    )
    if not job:
        return None, "job_not_found_or_not_yours"
    if job.get("status") not in _CANCELLABLE_BY_INSPECTOR:
        return None, f"not_cancellable:{job.get('status')}"

    # Release: remove inspector and reset status to "open" — credits stay reserved
    await db.inspection_jobs.update_one(
        {"_id": job_id},
        {
            "$set": {
                "status": "open",
                "inspectorId": None,
                "canceledAt": now,
                "lastCancelReason": (reason or "")[:500],
            },
            "$unset": {
                "claimedAt": "",
                "onRouteAt": "",
                "arrivedAt": "",
                "inspectionStartedAt": "",
            },
        },
    )
    # Decrement parent counters (this job is back to open)
    if job.get("status") == "claimed" or job.get("status") in {"on_route", "arrived", "inspecting"}:
        await db.car_requests.update_one(
            {"_id": job["requestId"]},
            {"$inc": {"jobsClaimed": -1}, "$set": {"updatedAt": now}},
        )
    fresh = await db.inspection_jobs.find_one({"_id": job_id})
    return _job_to_dict(fresh) if fresh else None, None


# ──────────────────────────────────────────────────────────────────────
# Report submission (CRITICAL — credit consume happens here)
# ──────────────────────────────────────────────────────────────────────

async def submit_report(
    job_id: str, inspector_id: str, payload: SubmitReportRequest
) -> Tuple[Optional[dict], Optional[str]]:
    """Submit report → close job → consume customer's credit (only here).

    Returns (report_dict, error_or_None).
    """
    from app.packages import service as credits_svc
    # Lazy import to avoid circular dep with chat router
    try:
        from app.chat.router import push_notification  # type: ignore
    except Exception:
        push_notification = None  # type: ignore

    db = get_db()
    now = _now()

    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        return None, "job_not_found"
    if job.get("inspectorId") != inspector_id:
        return None, "not_your_job"
    if job.get("status") != "inspecting":
        return None, f"job_not_in_inspecting:{job.get('status')}"
    if job.get("reportId"):
        return None, "report_already_submitted"

    # Derive customer-facing summary fields (P1 — report = decision):
    #   • riskLevel: low/medium/high derived from verdict + score
    #   • topProblems: up to 3 checklist items flagged as 'problem'
    verdict = payload.verdict
    risk_level = (
        "high"   if verdict == "not_recommended" or float(payload.score) < 5
        else "medium" if verdict == "risky" or float(payload.score) < 7.5
        else "low"
    )
    top_problems = []
    for it in payload.checklist:
        if it.status == "problem" and len(top_problems) < 3:
            top_problems.append({
                "key": it.key,
                "comment": (it.comment or "").strip()[:140] or None,
            })

    # Build report document
    report_id = str(uuid.uuid4())
    # P4.1 — propagate vehicleId from the job (denormalised at job
    # creation) so the report can be looked up directly by vehicle
    # without going through requestId. Falls back to None for legacy
    # jobs created before P4.1.
    report_doc = {
        "_id": report_id,
        "jobId": job_id,
        "requestId": job["requestId"],
        "vehicleId": job.get("vehicleId"),  # P4.1
        "inspectorId": inspector_id,
        "city": job.get("city", ""),
        "brand": job.get("brand", ""),
        "model": job.get("model", ""),
        "score": float(payload.score),
        "verdict": payload.verdict,
        "riskLevel": risk_level,
        "topProblems": top_problems,
        "checklist": [it.model_dump() for it in payload.checklist],
        "issues": [it.model_dump() for it in payload.issues],
        "summary": payload.summary,
        "repairEstimateMin": payload.repairEstimateMin,
        "repairEstimateMax": payload.repairEstimateMax,
        "status": "submitted",
        "rejectReason": None,
        "createdAt": now,
        "approvedAt": None,
    }
    await db.inspection_reports.insert_one(report_doc)

    # Close job atomically
    upd = await db.inspection_jobs.update_one(
        {"_id": job_id, "status": "inspecting", "reportId": None},
        {"$set": {"status": "done", "completedAt": now, "reportId": report_id}},
    )
    if upd.modified_count != 1:
        # Race: rollback the report we just inserted
        await db.inspection_reports.delete_one({"_id": report_id})
        return None, "race_condition_retry"

    # Bump request counters
    await db.car_requests.update_one(
        {"_id": job["requestId"]},
        {"$inc": {"jobsClaimed": -1, "jobsDone": +1}, "$set": {"updatedAt": now}},
    )

    # CRITICAL — consume customer credit ONLY now (post report submit)
    req = await db.car_requests.find_one({"_id": job["requestId"]})
    customer_id = (req or {}).get("userId")
    if customer_id:
        try:
            await credits_svc.consume_credit(customer_id, job_id=job_id, request_id=req["_id"])
        except Exception as exc:
            logger.exception("Failed to consume credit for job %s: %s", job_id, exc)

    # Mark request status based on completion progress.
    # `req` was re-fetched AFTER `$inc jobsDone:+1` above, so `jobsDone`
    # already reflects this submission — do NOT add another +1.
    #   - all jobs done  → completed
    #   - some jobs done → report_ready (at least one report available)
    request_completed = False
    request_prev_status: Optional[str] = None
    if req:
        request_prev_status = req.get("status")
        jobs_done = int(req.get("jobsDone", 0))
        jobs_total = int(req.get("jobsTotal", 0))
        if jobs_total > 0 and jobs_done >= jobs_total:
            await db.car_requests.update_one(
                {"_id": req["_id"]},
                {"$set": {"status": "completed", "updatedAt": now}},
            )
            request_completed = True
        elif jobs_done > 0 and req.get("status") not in {"completed", "cancelled", "report_ready"}:
            await db.car_requests.update_one(
                {"_id": req["_id"]},
                {"$set": {"status": "report_ready", "updatedAt": now}},
            )

    # P0.b.B+ — observe canonical lifecycle transition on `booking_timeline`
    # ONLY when the request actually reaches the terminal `completed` state.
    # `report_ready` is an inspector-domain intermediate signal; surfacing
    # it on the booking chronology would require adding a new visible-action
    # to projections (deferred — separate decision).
    if request_completed and req:
        try:
            from app.booking.attach import observe_transition
            await observe_transition(
                db,
                booking_id=str(req["_id"]),
                booking_scope="car_request",
                action="mark_completed",
                from_status=request_prev_status,
                to_status="completed",
                actor_id=inspector_id,
                actor_role="inspector",
                source="auto_requests.reports.submit",
                source_request_id=None,  # caller doesn't propagate X-Request-Id here
                accepted=True,
                meta={
                    "reportId": report_id,
                    # Domain payout signals are deliberately NOT included here —
                    # money lifecycle lives on `service_payments` / `money_audit`
                    # and is surfaced separately to avoid cross-aggregate coupling.
                },
            )
        except Exception as _e:
            logger.warning(
                f"[reports.submit] booking_timeline attach failed req={req.get('_id')}: {_e}"
            )

    # P1 — Inspector rating: recompute ratingAvg + reviewsCount on-the-fly
    # so the home dashboard reflects the new report immediately.
    # Note: inspectorId may be either a user _id (string from ObjectId) for
    # individual providers, OR an organization _id (UUID). We update BOTH
    # collections — whichever exists wins.
    try:
        agg = await db.inspection_reports.aggregate([
            {"$match": {"inspectorId": inspector_id, "status": {"$in": ["submitted", "approved"]}}},
            {"$group": {"_id": "$inspectorId", "avg": {"$avg": "$score"}, "n": {"$sum": 1}}},
        ]).to_list(1)
        if agg:
            r = agg[0]
            patch = {
                "ratingAvg": round(float(r["avg"]) / 2.0, 2),  # 0-10 score → 0-5 stars
                "reviewsCount": int(r["n"]),
                "completedJobs": int(r["n"]),
                "ratingUpdatedAt": now,
            }
            # Try organization (UUID-keyed) first
            await db.organizations.update_one({"_id": inspector_id}, {"$set": patch}, upsert=False)
            # Also update the user doc (ObjectId-keyed). Convert if it's a hex string.
            try:
                from bson import ObjectId
                user_oid = ObjectId(inspector_id) if len(inspector_id) == 24 else inspector_id
                await db.users.update_one({"_id": user_oid}, {"$set": patch}, upsert=False)
            except Exception:
                await db.users.update_one({"_id": inspector_id}, {"$set": patch}, upsert=False)
    except Exception as exc:
        logger.exception("Failed to recompute inspector rating for %s: %s", inspector_id, exc)

    # Notify customer
    if push_notification and customer_id:
        try:
            brand = job.get("brand", "")
            model = job.get("model", "")
            city = job.get("city", "")
            await push_notification(
                customer_id,
                "report_ready",
                "Inspection report ready",
                f"{brand} {model} in {city} — score {payload.score:.1f} · {payload.verdict}",
                action_url=f"/dashboard/reports/{report_id}",
            )
        except Exception as exc:
            logger.warning("push_notification failed: %s", exc)

    # Sprint 2 Step 1 — durable timeline event for report submission
    try:
        from app.inspector.timeline import append_event
        # `top_problems` already computed above with key+comment
        await append_event(
            kind="report_submitted",
            job_id=job_id,
            report_id=report_id,
            vehicle_id=job.get("vehicleId"),
            inspector_id=inspector_id,
            customer_id=customer_id,
            actor_type="inspector",
            actor_id=inspector_id,
            severity="critical" if risk_level == "high" else ("warning" if risk_level == "medium" else "success"),
            text=f"Score {float(payload.score):.1f} · verdict={payload.verdict} · {job.get('brand', '')} {job.get('model', '')}".strip(),
            metadata={
                "score": float(payload.score),
                "verdict": payload.verdict,
                "riskLevel": risk_level,
                "topProblems": top_problems,
                "requestId": job.get("requestId"),
                "city": job.get("city"),
            },
        )
        # Auto-flag critical findings as their own event so downstream
        # consumers (reputation, dispute) can react without parsing the report.
        if risk_level == "high" or any(p for p in top_problems):
            await append_event(
                kind="critical_issue_found",
                job_id=job_id,
                report_id=report_id,
                vehicle_id=job.get("vehicleId"),
                inspector_id=inspector_id,
                customer_id=customer_id,
                actor_type="inspector",
                actor_id=inspector_id,
                text=f"{len(top_problems)} критичных пункта в {job.get('brand', '')} {job.get('model', '')}".strip(),
                metadata={"topProblems": top_problems, "reportId": report_id},
                stable_key=report_id,  # one critical event per report
            )
    except Exception:
        logger.exception("timeline emit (report_submitted) failed")

    # Sprint 2 Step 4 — log AI overrides if inspector started from a draft
    if getattr(payload, "aiDraftId", None):
        try:
            from app.intelligence.draft import log_ai_overrides
            await log_ai_overrides(
                draft_id=payload.aiDraftId,
                job_id=job_id,
                report_id=report_id,
                inspector_id=inspector_id,
                submitted={
                    "verdict": payload.verdict,
                    "score": float(payload.score),
                    "summary": payload.summary,
                },
            )
        except Exception:
            logger.exception("log_ai_overrides failed (non-fatal)")

    # Phase D Pass 1C — inspection continuity established.
    # Emits ONLY on `inspecting → done` (the substrate moment the
    # inspection lifecycle reaches a completed interpretive state).
    # NOT on PDF generation, NOT on upload finalisation, NOT on
    # notification send. Topology-order invariant enforced at the
    # ledger boundary: emit() refuses this event unless a prior
    # `inspection_continuity_entered_accumulation` event exists for
    # the same job. Best-effort: ledger failure does NOT roll back
    # report submission.
    try:
        from app.runtime_ledger import emit as _rl_emit, EventType as _RLEventType
        await _rl_emit(
            _RLEventType.INSPECTION_CONTINUITY_ESTABLISHED,
            subject_id=job_id,
            payload={},
            emitted_by=inspector_id,
        )
    except Exception as exc:
        logger.warning(
            "runtime_ledger emit (inspection_established) failed for job %s: %s",
            job_id, exc,
        )

    return _scrub({**report_doc, "id": report_id}), None


# ──────────────────────────────────────────────────────────────────────
# Read APIs
# ──────────────────────────────────────────────────────────────────────

async def get_report(report_id: str) -> Optional[dict]:
    db = get_db()
    doc = await db.inspection_reports.find_one({"_id": report_id})
    if not doc:
        return None
    out = _scrub({**doc, "id": str(doc["_id"])})
    # Attach media metadata (no payload) for one-shot client consumption
    cursor = db.inspection_media.find({"reportId": report_id}, {"dataBase64": 0}).sort("createdAt", 1)
    media_docs = await cursor.to_list(200)
    out["media"] = [
        {
            "id": str(m["_id"]),
            "type": m.get("type"),
            "mimeType": m.get("mimeType"),
            "sizeBytes": int(m.get("sizeBytes", 0)),
            "url": f"/api/media/{m['_id']}",
            "createdAt": m.get("createdAt").isoformat() if isinstance(m.get("createdAt"), datetime) else m.get("createdAt"),
        }
        for m in media_docs
    ]
    return out


async def list_reports_for_request(request_id: str) -> List[dict]:
    db = get_db()
    cursor = db.inspection_reports.find({"requestId": request_id}).sort("createdAt", -1)
    docs = await cursor.to_list(50)
    return [_scrub({**d, "id": str(d["_id"])}) for d in docs]


async def list_reports_for_customer(user_id: str) -> List[dict]:
    """All reports across user's car_requests."""
    db = get_db()
    req_ids = [r["_id"] async for r in db.car_requests.find({"userId": user_id}, {"_id": 1})]
    if not req_ids:
        return []
    cursor = db.inspection_reports.find({"requestId": {"$in": req_ids}}).sort("createdAt", -1)
    docs = await cursor.to_list(200)
    return [_scrub({**d, "id": str(d["_id"])}) for d in docs]


async def list_all_reports(
    status: Optional[str] = None,
    city: Optional[str] = None,
    inspector_id: Optional[str] = None,
    limit: int = 200,
) -> List[dict]:
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    if city:
        q["city"] = city
    if inspector_id:
        q["inspectorId"] = inspector_id
    cursor = db.inspection_reports.find(q).sort("createdAt", -1).limit(limit)
    docs = await cursor.to_list(limit)
    return [_scrub({**d, "id": str(d["_id"])}) for d in docs]


# ──────────────────────────────────────────────────────────────────────
# Admin moderation
# ──────────────────────────────────────────────────────────────────────

# Verdict-severity mapping for vehicle.activity[] event severity field.
# This is the canonical "what does verdict mean for the timeline" map.
_VERDICT_SEVERITY = {
    "recommended":     "success",
    "risky":           "warning",
    "not_recommended": "critical",
}

_VERDICT_TITLE_RU = {
    "recommended":     "Осмотр завершён · рекомендовано к покупке",
    "risky":           "Осмотр завершён · покупка с рисками",
    "not_recommended": "Осмотр завершён · к покупке не рекомендована",
}


async def _append_vehicle_memory_on_approval(report: dict) -> None:
    """Pushes a structured `inspection_completed` event into `vehicles.activity[]`.

    Closes the ontology loop:
        inspection (operational) → vehicle memory (canonical history)

    Idempotent: keyed by `id = f"evt_inspection_{report._id}"`. Safe to call
    again on a second admin click of "Approve" (e.g. unapprove → reapprove).
    Failures are logged but do not abort the approval transaction —
    approval is the primary truth, memory append is its consequence.
    """
    db = get_db()
    vehicle_id = report.get("vehicleId")
    if not vehicle_id:
        return  # legacy report (pre P4.1) without vehicle linkage — skip

    report_id = str(report.get("_id") or report.get("id") or "")
    verdict   = report.get("verdict", "")
    score     = float(report.get("score", 0) or 0)
    summary   = (report.get("summary") or "").strip()

    event_id = f"evt_inspection_{report_id}"

    # Compose human-readable text. Score is canonical; first sentence of
    # summary gives context; we cap at 200 chars to keep timeline tidy.
    head = _VERDICT_TITLE_RU.get(verdict, "Осмотр завершён")
    first_sentence = summary.split(". ")[0] if summary else ""
    text_parts = [f"Score {score:.1f}"]
    if first_sentence:
        text_parts.append(first_sentence[:200])
    text = " · ".join(text_parts)

    event = {
        "id":       event_id,
        "type":     "inspection_completed",
        "at":       _iso(_now()),
        "title":    head,
        "text":     text,
        "severity": _VERDICT_SEVERITY.get(verdict, "info"),
        "reportId": report_id,
        "score":    score,
        "verdict":  verdict,
    }

    try:
        # Idempotent push: $pull out any prior event with the same id, then
        # $push the fresh one. Two-step (not in one update) because Mongo
        # cannot $pull and $push the same array path in a single call.
        await db.vehicles.update_one(
            {"id": vehicle_id},
            {"$pull": {"activity": {"id": event_id}}},
        )
        await db.vehicles.update_one(
            {"id": vehicle_id},
            {"$push": {"activity": event}, "$set": {"updatedAt": _now()}},
        )
    except Exception as exc:
        logger.exception(
            "Failed to append vehicle memory for report %s → vehicle %s: %s",
            report_id, vehicle_id, exc,
        )


async def admin_set_report_status(
    report_id: str, status: str, reason: Optional[str] = None
) -> Optional[dict]:
    db = get_db()
    update: dict = {"status": status}
    if status == "approved":
        update["approvedAt"] = _now()
        update["rejectReason"] = None
    elif status == "rejected":
        update["rejectReason"] = (reason or "")[:1000]
        update["approvedAt"] = None
    res = await db.inspection_reports.find_one_and_update(
        {"_id": report_id},
        {"$set": update},
        return_document=True,
    )
    if not res:
        return None

    # Ontology closing — fire memory append on first approval edge.
    # We call this for every approval (idempotent), so unapprove → reapprove
    # still leaves the timeline correctly populated.
    if status == "approved":
        await _append_vehicle_memory_on_approval(res)

    # Sprint 2 Step 1 — durable timeline event for admin moderation
    try:
        from app.inspector.timeline import append_event
        # Pull inspectorId + customerId for proper indexing
        inspector_id = res.get("inspectorId")
        customer_id = None
        try:
            parent_req = await db.car_requests.find_one(
                {"_id": res.get("requestId")}, {"_id": 0, "userId": 1}
            )
            customer_id = (parent_req or {}).get("userId")
        except Exception:
            pass
        kind = "report_approved" if status == "approved" else (
            "report_rejected" if status == "rejected" else None
        )
        if kind:
            await append_event(
                kind=kind,
                job_id=res.get("jobId"),
                report_id=report_id,
                vehicle_id=res.get("vehicleId"),
                inspector_id=inspector_id,
                customer_id=customer_id,
                actor_type="qa",
                actor_id="admin",
                actor_label="QA",
                text=(reason or "Отчёт одобрен" if status == "approved"
                      else f"Возвращён: {reason or 'на доработку'}"),
                metadata={
                    "verdict": res.get("verdict"),
                    "score": res.get("score"),
                    "reason": reason,
                    "requestId": res.get("requestId"),
                },
            )
    except Exception:
        logger.exception("timeline emit (admin_set_report_status) failed")

    return _scrub({**res, "id": str(res["_id"])})


# ──────────────────────────────────────────────────────────────────────
# Customer acceptance — quality confirmation (non-financial)
# ──────────────────────────────────────────────────────────────────────
# The credit was already consumed at report submission (anti-fraud); this
# step is *quality signal*, not billing. It powers:
#   - inspector quality score
#   - QA accountability
#   - future dispute system
#   - "report received" UX state in the customer dashboard

async def customer_accept_report(
    report_id: str, customer_id: str
) -> Tuple[Optional[dict], Optional[str]]:
    """Customer marks an approved report as received.

    Returns (report_dict, error_or_None). Errors:
        not_found            — report does not exist
        not_yours            — report belongs to another customer
        not_approved         — only `approved` reports can be accepted
        already_accepted     — idempotency guard (returns existing doc)
    """
    db = get_db()
    now = _now()

    rep = await db.inspection_reports.find_one({"_id": report_id})
    if not rep:
        return None, "not_found"

    # Ownership via parent car_request.userId (denormalised lookup).
    req_id = rep.get("requestId")
    req = await db.car_requests.find_one({"_id": req_id}) if req_id else None
    if not req or req.get("userId") != customer_id:
        return None, "not_yours"

    if rep.get("status") != "approved":
        return None, "not_approved"

    if rep.get("customerAcceptedAt"):
        # Idempotent — returning current state is correct UX
        return _scrub({**rep, "id": str(rep["_id"])}), None

    upd = await db.inspection_reports.find_one_and_update(
        {"_id": report_id, "status": "approved", "customerAcceptedAt": None},
        {"$set": {
            "customerAcceptedAt":       now,
            "customerAcceptanceStatus": "accepted",
        }},
        return_document=True,
    )
    if not upd:
        # Race: re-fetch and return whatever's there.
        fresh = await db.inspection_reports.find_one({"_id": report_id})
        return _scrub({**fresh, "id": str(fresh["_id"])}) if fresh else None, None

    # Sprint 2 Step 1 — durable timeline event
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="customer_accepted",
            job_id=upd.get("jobId"),
            report_id=report_id,
            vehicle_id=upd.get("vehicleId"),
            inspector_id=upd.get("inspectorId"),
            customer_id=customer_id,
            actor_type="customer",
            actor_id=customer_id,
            actor_label="Customer",
            text=f"Клиент принял отчёт · score {upd.get('score')} · verdict={upd.get('verdict')}",
            metadata={
                "verdict": upd.get("verdict"),
                "score": upd.get("score"),
                "requestId": upd.get("requestId"),
            },
        )
    except Exception:
        logger.exception("timeline emit (customer_accepted) failed")

    return _scrub({**upd, "id": str(upd["_id"])}), None


# ──────────────────────────────────────────────────────────────────────
# Inspector queries (lifecycle-aware listings)
# ──────────────────────────────────────────────────────────────────────

async def list_my_jobs_full(inspector_id: str) -> List[dict]:
    """Full lifecycle data for inspector's My Jobs screen."""
    db = get_db()
    cursor = db.inspection_jobs.find({"inspectorId": inspector_id}).sort("createdAt", -1)
    docs = await cursor.to_list(200)
    return [_job_to_dict(d) for d in docs]


async def get_job_full(job_id: str, inspector_id: str) -> Tuple[Optional[dict], Optional[str]]:
    db = get_db()
    doc = await db.inspection_jobs.find_one({"_id": job_id})
    if not doc:
        return None, "job_not_found"
    if doc.get("inspectorId") and doc["inspectorId"] != inspector_id:
        # An inspector can also view an open job (no owner yet) before claim
        if doc.get("status") != "open":
            return None, "not_your_job"
    return _job_to_dict(doc), None
