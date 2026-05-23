"""UX-4B — Inspection Timeline / Audit Trail.

Silent auditability layer over the existing inspection_v2 stack.

Design principles:
  • Silent — record everything, never block the inspector.
  • Provenance — every media event captures hash, geo, delay, device.
  • Heuristics — deterministic suspicion flags only (no AI).
  • Admin-first — events are exposed via `/timeline` for forensic review.

Event schema (collection `inspection_timeline_events`)::

    {
      "_id":        <uuid hex>,
      "id":         <uuid hex>,
      "jobId":      <fk inspection_jobs>,
      "reportId":   <fk inspection_reports_v2> (when known),
      "eventType":  "inspection.started" | "media.uploaded"
                  | "item.flagged_critical" | "item.flagged_warning"
                  | "report.submitted",
      "actorId":    <user_id>,
      "at":         iso8601 UTC,
      "payload":    {...},          # event-specific (mediaId / sectionId / itemId …)
      "provenance": {...},          # for media events: hash, delay, geo, device
      "suspicion":  [               # zero-or-more silent flags
        {"code": "RAPID_BURST",      "msg": "10 uploads in 8s"},
        {"code": "DUPLICATE_HASH",   "msg": "same SHA-256 already uploaded"},
        {"code": "CONTEXT_MISMATCH", "msg": "marked VIN but item expects odometer"},
        {"code": "QUALITY_FAIL",     "msg": "client-side quality heuristic failed"},
        {"code": "FAR_FROM_JOB",     "msg": "1200km from job location"}
      ]
    }
"""
from __future__ import annotations

import hashlib
import logging
import math
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, decode_and_resolve

logger = logging.getLogger(__name__)

# Suspicion thresholds (deterministic; can be tuned per env later).
RAPID_BURST_WINDOW_SEC = 10          # uploads in this window
RAPID_BURST_THRESHOLD = 6             # > this → flagged
FAR_FROM_JOB_KM = 200                 # > this → flagged
LATE_UPLOAD_DELAY_SEC = 3600          # capturedAt → uploadedAt > 1h → flagged


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(a))


def _media_hash(b64: str) -> str:
    # SHA-256 of the base64 string (cheap proxy for binary identity).
    return hashlib.sha256(b64.encode("utf-8")).hexdigest()


async def emit_event(
    db,
    *,
    job_id: str,
    event_type: str,
    actor_id: str,
    payload: dict | None = None,
    provenance: dict | None = None,
    suspicion: list[dict] | None = None,
    report_id: str | None = None,
) -> dict:
    """Insert one timeline event. Never raises — failures are logged."""
    doc = {
        "_id": uuid.uuid4().hex,
        "id": None,
        "jobId": job_id,
        "reportId": report_id,
        "eventType": event_type,
        "actorId": actor_id,
        "at": _now_iso(),
        "payload": payload or {},
        "provenance": provenance or {},
        "suspicion": suspicion or [],
    }
    doc["id"] = doc["_id"]
    try:
        await db.inspection_timeline_events.insert_one(doc)
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[timeline] insert failed: {exc}")
    doc.pop("_id", None)

    # Sprint Customer-Notify-2 — dry-run audit projection hook.
    # Customer-allowed events (4 kinds) generate audit rows for
    # push/email/sms via the shared kernel. NO real send in Notify-2;
    # admin reviews `notification_projection_audit` and flips dryRun
    # off in a later sprint. Soft-fail: timeline insert remains
    # authoritative regardless of audit outcome.
    try:
        from app.notifications.customer_pipeline import on_customer_event
        await on_customer_event({
            "id": doc.get("id"),
            "kind": event_type,
            "metadata": {
                "jobId": job_id,
                "reportId": report_id,
                **(payload or {}),
            },
        })
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"[timeline] cnotify hook failed (non-fatal): {exc}")

    return doc


async def build_media_provenance(
    db, *, job_id: str, media_doc: dict, item_expected_context: str | None,
) -> tuple[dict, list[dict]]:
    """Compute provenance + suspicion for a freshly uploaded media doc.

    Returns:
        (provenance_dict, suspicion_list)
    """
    cap = (media_doc.get("capture") or {})
    quality = (cap.get("quality") or {})
    captured_at = _parse_iso(cap.get("capturedAt"))
    uploaded_at = _parse_iso(media_doc.get("createdAt")) or datetime.now(timezone.utc)
    delay_sec = None
    if captured_at:
        delay_sec = max(0, int((uploaded_at - captured_at).total_seconds()))

    sha = _media_hash(media_doc.get("base64", "")) if media_doc.get("base64") else None

    # Geo distance from job (best-effort; many jobs have no lat/lng yet)
    geo_km: float | None = None
    cap_lat, cap_lng = cap.get("lat"), cap.get("lng")
    if cap_lat is not None and cap_lng is not None:
        try:
            job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 0, "lat": 1, "lng": 1, "location": 1})
            jlat = (job or {}).get("lat")
            jlng = (job or {}).get("lng")
            if (jlat is None or jlng is None) and (job or {}).get("location"):
                loc = job["location"]
                jlat = loc.get("lat")
                jlng = loc.get("lng")
            if jlat is not None and jlng is not None:
                geo_km = round(_haversine_km(float(cap_lat), float(cap_lng), float(jlat), float(jlng)), 1)
        except Exception:
            pass

    provenance = {
        "capturedAt": cap.get("capturedAt"),
        "uploadedAt": media_doc.get("createdAt"),
        "uploadDelaySec": delay_sec,
        "deviceModel": cap.get("deviceModel"),
        "geoLat": cap_lat,
        "geoLng": cap_lng,
        "geoDistanceFromJobKm": geo_km,
        "context": cap.get("context"),
        "expectedContext": item_expected_context,
        "qualityPassed": quality.get("passed"),
        "brightness": quality.get("brightness"),
        "width": quality.get("width"),
        "height": quality.get("height"),
        "sha256": sha,
    }

    # ─── Deterministic suspicion heuristics ───────────────────────────
    suspicion: list[dict] = []

    # 1. CONTEXT_MISMATCH — captured context differs from what the item expects.
    expected = item_expected_context
    captured_ctx = cap.get("context")
    if expected and captured_ctx and expected != captured_ctx and expected != "general":
        suspicion.append({
            "code": "CONTEXT_MISMATCH",
            "msg": f"item expects {expected!r} but photo tagged {captured_ctx!r}",
        })

    # 2. QUALITY_FAIL — client-side heuristic verdict.
    if quality.get("passed") is False:
        suspicion.append({
            "code": "QUALITY_FAIL",
            "msg": "client-side quality heuristic flagged this photo",
        })

    # 3. LATE_UPLOAD — captured >1h before upload.
    if delay_sec is not None and delay_sec > LATE_UPLOAD_DELAY_SEC:
        suspicion.append({
            "code": "LATE_UPLOAD",
            "msg": f"captured {delay_sec}s before upload (>{LATE_UPLOAD_DELAY_SEC}s)",
        })

    # 4. FAR_FROM_JOB — geo distance from job location > threshold.
    if geo_km is not None and geo_km > FAR_FROM_JOB_KM:
        suspicion.append({
            "code": "FAR_FROM_JOB",
            "msg": f"photo geo is {geo_km}km from job location",
        })

    # 5. DUPLICATE_HASH — same SHA-256 already attached to this job.
    if sha:
        try:
            existing = await db.inspection_media.count_documents({
                "jobId": job_id, "sha256": sha, "_id": {"$ne": media_doc.get("_id")},
            })
            if existing > 0:
                suspicion.append({
                    "code": "DUPLICATE_HASH",
                    "msg": f"identical photo already uploaded to this job ({existing}x)",
                })
        except Exception:
            pass

    # 6. RAPID_BURST — > THRESHOLD uploads in the last WINDOW seconds.
    try:
        cutoff = datetime.now(timezone.utc).timestamp() - RAPID_BURST_WINDOW_SEC
        cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
        recent = await db.inspection_media.count_documents({
            "jobId": job_id, "createdAt": {"$gte": cutoff_iso},
        })
        if recent > RAPID_BURST_THRESHOLD:
            suspicion.append({
                "code": "RAPID_BURST",
                "msg": f"{recent} uploads in last {RAPID_BURST_WINDOW_SEC}s (>{RAPID_BURST_THRESHOLD})",
            })
    except Exception:
        pass

    return provenance, suspicion


# ---------- HTTP endpoint -------------------------------------------------

router = APIRouter(prefix="/api/inspections", tags=["inspections-timeline"])


@router.get("/{job_id}/timeline")
async def get_timeline(
    job_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Return ordered timeline events for a job.

    Auth:
      • admin → see everything
      • inspector who owns the job → see everything
      • customer of the originating request → see events *without* suspicion flags
        (silent auditability — we don't expose internal fraud signals to the buyer)
    """
    db = get_db()
    job = await db.inspection_jobs.find_one(
        {"_id": job_id}, {"_id": 0, "inspectorId": 1, "customerId": 1, "requestId": 1},
    )
    if not job:
        raise HTTPException(404, "job not found")

    is_inspector = job.get("inspectorId") == ctx.user_id
    customer_id = job.get("customerId")
    if not customer_id and job.get("requestId"):
        req = await db.car_requests.find_one({"_id": job["requestId"]}, {"customerId": 1, "userId": 1})
        if req:
            customer_id = req.get("customerId") or req.get("userId")
    is_customer = customer_id == ctx.user_id
    # Admin check via IdentityContext.legacy_role (canonical) with AccountView fallback.
    is_admin = (
        (ctx.legacy_role or "").lower() == "admin"
        or (ctx.account and (getattr(ctx.account, "legacyRole", "") or "").lower() == "admin")
        or (ctx.account and (getattr(ctx.account, "kind", "") or "").lower() == "admin")
    )

    if not (is_inspector or is_customer or is_admin):
        raise HTTPException(403, "not allowed")

    cursor = db.inspection_timeline_events.find({"jobId": job_id}, {"_id": 0}).sort("at", 1)
    events: list[dict] = []
    async for ev in cursor:
        if is_customer and not is_admin and not is_inspector:
            # Strip silent fraud signals from buyer-side view.
            ev = {k: v for k, v in ev.items() if k != "suspicion"}
            # Also strip raw provenance hash (avoid surface for tamper attempts)
            if ev.get("provenance"):
                ev["provenance"] = {
                    k: v for k, v in ev["provenance"].items()
                    if k in {"capturedAt", "uploadedAt", "context", "expectedContext"}
                }
        events.append(ev)

    # Aggregate stats so admin UI can show a "trust score" badge later.
    total = len(events)
    suspicious = 0
    flag_counts: dict[str, int] = {}
    if is_admin or is_inspector:
        for ev in events:
            for s in ev.get("suspicion", []):
                suspicious += 1
                flag_counts[s["code"]] = flag_counts.get(s["code"], 0) + 1

    return {
        "jobId": job_id,
        "totalEvents": total,
        # Aggregates are admin/inspector-only — customer must not see suspicion or
        # flag counts at all. The keys are omitted entirely (not `null`) so the
        # customer payload contains zero fraud-signal surface.
        **(
            {"suspicionCount": suspicious, "flagCounts": flag_counts}
            if (is_admin or is_inspector)
            else {}
        ),
        "events": events,
    }



@router.get("/admin/jobs")
async def admin_list_jobs_with_timeline(
    limit: int = 50,
    status: str | None = None,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Admin-only — list recent inspection jobs with their timeline summary
    (event count, suspicion count, top flags). For the Forensics workspace.
    """
    is_admin = (
        (ctx.legacy_role or "").lower() == "admin"
        or (ctx.account and (getattr(ctx.account, "legacyRole", "") or "").lower() == "admin")
        or (ctx.account and (getattr(ctx.account, "kind", "") or "").lower() == "admin")
    )
    if not is_admin:
        raise HTTPException(403, "admin only")

    db = get_db()
    q: dict[str, Any] = {}
    if status:
        q["status"] = status

    jobs_cursor = db.inspection_jobs.find(
        q,
        {"_id": 1, "status": 1, "inspectorId": 1, "customerId": 1,
         "vehicle": 1, "city": 1, "createdAt": 1, "updatedAt": 1, "reportId": 1},
    ).sort("updatedAt", -1).limit(limit)

    jobs: list[dict] = []
    async for j in jobs_cursor:
        job_id = j.pop("_id")
        # Aggregate timeline stats for this job
        agg_cursor = db.inspection_timeline_events.aggregate([
            {"$match": {"jobId": job_id}},
            {"$project": {"_id": 0, "suspicion": 1, "eventType": 1}},
        ])
        total_events = 0
        suspicion_total = 0
        flag_counts: dict[str, int] = {}
        async for ev in agg_cursor:
            total_events += 1
            for s in ev.get("suspicion") or []:
                suspicion_total += 1
                code = s.get("code")
                if code:
                    flag_counts[code] = flag_counts.get(code, 0) + 1

        # Trust level (deterministic, not punitive):
        #   low risk     — 0 suspicion or only QUALITY_FAIL
        #   review       — 1-3 hard flags (DUPLICATE_HASH / FAR_FROM_JOB / CONTEXT_MISMATCH)
        #   high concern — 4+ hard flags
        hard_flags = sum(flag_counts.get(c, 0) for c in
                         ("DUPLICATE_HASH", "FAR_FROM_JOB", "CONTEXT_MISMATCH", "LATE_UPLOAD", "RAPID_BURST"))
        if hard_flags == 0:
            trust_level = "low_risk"
        elif hard_flags <= 3:
            trust_level = "review_recommended"
        else:
            trust_level = "high_concern"

        jobs.append({
            "jobId": job_id,
            "status": j.get("status"),
            "inspectorId": j.get("inspectorId"),
            "customerId": j.get("customerId"),
            "vehicle": j.get("vehicle"),
            "city": j.get("city"),
            "createdAt": j.get("createdAt"),
            "updatedAt": j.get("updatedAt"),
            "reportId": j.get("reportId"),
            "timelineSummary": {
                "totalEvents": total_events,
                "suspicionCount": suspicion_total,
                "flagCounts": flag_counts,
                "trustLevel": trust_level,
            },
        })

    return {"jobs": jobs, "total": len(jobs)}
