"""UX-3A — Section-based Inspection Report v2.

A new, structured parallel to the legacy flat `inspection_reports`
collection. Designed so media belongs to individual checklist items
(not to the report blob) — which is what makes:

  • PDF generation possible
  • Dispute targeting possible (a customer can dispute a single item, not the whole report)
  • Severity scoring deterministic
  • Future AI overlays additive instead of structural

Collection: `inspection_reports_v2`
Document shape::

    {
      _id: <reportId>,             # uuid4 hex
      jobId,                        # FK → inspection_jobs._id
      bookingId,                    # FK → car_requests._id (legacy alias)
      vehicleId, inspectorId,
      status: 'draft'|'submitted'|'disputed',
      startedAt, completedAt,
      overallScore, recommendation, # computed on submit
      criticalIssues: [str],
      sections: [
        {
          id: 'exterior',
          title: 'Exterior',
          items: [
            {
              id: 'paint_thickness',
              label: 'Paint thickness uniform',
              status: 'ok'|'warning'|'critical'|'na'|'pending',
              note: str|null,
              media: [mediaId],     # uuid hex pointers into inspection_media
              requiredMedia: bool,
            },
            …
          ]
        },
        …
      ]
    }

Media: stored in a side collection `inspection_media` (base64 payloads
keep the surface contained and avoid an S3 dependency for v2). Each
media doc has `reportId`, `sectionId`, `itemId` back-pointers for fast
look-ups + a tiny `mime` + `caption`.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, List, Optional
import uuid
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.identity_runtime import (
    IdentityContext,
    require_capability_v2,
    decode_and_resolve,
)

logger = logging.getLogger("server")
router = APIRouter(prefix="/api/inspections", tags=["inspections:v2"])

# ---------- Canonical schema (UX-3A template) -----------------------------

# Each item defines: id, label (i18n key suffix), requiredMedia flag.
# 7 sections × ~9 items ≈ ~60 points. Inspector can mark `na` when an item
# doesn't apply (e.g. EV has no engine oil leak); `na` is not counted in the score.
SECTIONS_TEMPLATE: list[dict[str, Any]] = [
    {
        "id": "exterior", "title": "Exterior",
        "items": [
            {"id": "body_panels",      "label": "Body panel alignment & gaps", "requiredMedia": True,  "captureContext": "damage"},
            {"id": "paint_thickness",  "label": "Paint thickness uniform",     "requiredMedia": True,  "captureContext": "exterior"},
            {"id": "rust",             "label": "No rust / corrosion",          "requiredMedia": False, "captureContext": "damage"},
            {"id": "windshield",       "label": "Windshield & windows",         "requiredMedia": False, "captureContext": "exterior"},
            {"id": "lights",           "label": "Headlights / taillights work", "requiredMedia": False, "captureContext": "exterior"},
            {"id": "mirrors",          "label": "Mirrors intact",               "requiredMedia": False, "captureContext": "exterior"},
            {"id": "wheels_visual",    "label": "Wheels / rims visual",         "requiredMedia": True,  "captureContext": "exterior"},
            {"id": "accident_traces",  "label": "No accident traces",           "requiredMedia": True,  "captureContext": "damage"},
        ],
    },
    {
        "id": "interior", "title": "Interior",
        "items": [
            {"id": "seats",        "label": "Seats wear & function",  "requiredMedia": True,  "captureContext": "interior"},
            {"id": "upholstery",   "label": "Upholstery condition",   "requiredMedia": False, "captureContext": "interior"},
            {"id": "dashboard",    "label": "Dashboard intact",       "requiredMedia": True,  "captureContext": "interior"},
            {"id": "electronics",  "label": "Electronics (windows, locks, AC, infotainment)", "requiredMedia": False, "captureContext": "interior"},
            {"id": "smell",        "label": "No abnormal smell (mould / smoke)", "requiredMedia": False, "captureContext": "interior"},
            {"id": "warning_lights","label": "No dashboard warning lights",  "requiredMedia": True,  "captureContext": "interior"},
        ],
    },
    {
        "id": "engine", "title": "Engine",
        "items": [
            {"id": "engine_bay",      "label": "Engine bay clean & dry",     "requiredMedia": True,  "captureContext": "engine"},
            {"id": "oil_leak",        "label": "No oil leaks",               "requiredMedia": True,  "captureContext": "engine"},
            {"id": "coolant_leak",    "label": "No coolant leaks",           "requiredMedia": True,  "captureContext": "engine"},
            {"id": "fluids_level",    "label": "Fluids at proper level",     "requiredMedia": False, "captureContext": "engine"},
            {"id": "cold_start",      "label": "Cold start clean (no smoke)","requiredMedia": True,  "captureContext": "engine"},
            {"id": "noises",          "label": "No abnormal noises",         "requiredMedia": False, "captureContext": "engine"},
            {"id": "belt_hoses",      "label": "Belts & hoses condition",    "requiredMedia": False, "captureContext": "engine"},
        ],
    },
    {
        "id": "suspension", "title": "Suspension & Brakes",
        "items": [
            {"id": "shocks",       "label": "Shock absorbers OK",      "requiredMedia": False, "captureContext": "general"},
            {"id": "steering",     "label": "Steering response",       "requiredMedia": False, "captureContext": "general"},
            {"id": "brake_discs",  "label": "Brake discs condition",   "requiredMedia": True,  "captureContext": "general"},
            {"id": "brake_pads",   "label": "Brake pads thickness",    "requiredMedia": True,  "captureContext": "general"},
            {"id": "tires_tread",  "label": "Tires tread depth",       "requiredMedia": True,  "captureContext": "tire"},
            {"id": "tires_age",    "label": "Tires age & wear pattern","requiredMedia": True,  "captureContext": "tire"},
        ],
    },
    {
        "id": "diagnostics", "title": "Diagnostics",
        "items": [
            {"id": "obd_codes",         "label": "OBD-II fault codes",         "requiredMedia": True,  "captureContext": "obd"},
            {"id": "battery",           "label": "Battery health / voltage",   "requiredMedia": True,  "captureContext": "general"},
            {"id": "mileage_consistent","label": "Mileage consistent (no rollback)", "requiredMedia": False, "captureContext": "odometer"},
            {"id": "ecu_resets",        "label": "No suspicious ECU resets",   "requiredMedia": False, "captureContext": "obd"},
        ],
    },
    {
        "id": "test_drive", "title": "Test Drive",
        "items": [
            {"id": "gearbox",       "label": "Gearbox smooth (all gears)", "requiredMedia": False, "captureContext": "general"},
            {"id": "acceleration",  "label": "Acceleration normal",         "requiredMedia": False, "captureContext": "general"},
            {"id": "braking",       "label": "Braking even & predictable",  "requiredMedia": False, "captureContext": "general"},
            {"id": "vibrations",    "label": "No vibrations at speed",      "requiredMedia": False, "captureContext": "general"},
            {"id": "steering_pull", "label": "No steering pull",            "requiredMedia": False, "captureContext": "general"},
        ],
    },
    {
        "id": "documents", "title": "Documents",
        "items": [
            {"id": "vin_match",        "label": "VIN matches registration",  "requiredMedia": True,  "captureContext": "vin"},
            {"id": "odometer_photo",   "label": "Odometer photo",            "requiredMedia": True,  "captureContext": "odometer"},
            {"id": "registration_doc", "label": "Registration document",     "requiredMedia": True,  "captureContext": "document"},
            {"id": "service_history",  "label": "Service history present",   "requiredMedia": False, "captureContext": "document"},
            {"id": "ownership_count",  "label": "Reasonable ownership count","requiredMedia": False, "captureContext": "document"},
        ],
    },
]


def _new_template() -> list[dict[str, Any]]:
    """Deep-copy a fresh sections array with status='pending' on every item.
    UX-4C — persist `captureContext` in item state so that the
    required-context enforcement layer (soft/hard) can validate against the
    actual evidence context at submit time without re-reading the template.
    """
    sections = []
    for s in SECTIONS_TEMPLATE:
        items = []
        for it in s["items"]:
            items.append({
                "id": it["id"],
                "label": it["label"],
                "status": "pending",
                "note": None,
                "media": [],
                "requiredMedia": bool(it.get("requiredMedia", False)),
                "captureContext": it.get("captureContext"),
            })
        sections.append({"id": s["id"], "title": s["title"], "items": items})
    return sections


# ---------- UX-4C Required-context enforcement ----------------------------
#
# Items whose evidence is *identity-critical* and can be hard-enforced. These
# are objective and verifiable (VIN string, odometer reading, registration
# paper). Damage / interior / engine are intentionally NOT here because they
# are subjective field judgments that should not block submission.
HARD_ENFORCEMENT_ITEM_IDS: set[str] = {
    "vin_match",
    "odometer_photo",
    "registration_doc",
}


async def _compute_evidence_gaps(
    db, job_id: str, sections: list[dict[str, Any]],
) -> dict[str, Any]:
    """Per-item gap analysis. Returns:
      {
        "items": [{sectionId, itemId, label, expected, uploaded, severity,
                   reason}],
        "softCount": int,
        "hardCount": int,
      }

    Severity:
      • "ok"             — required media present AND at least one matches
                            expected context (or no captureContext required)
      • "soft_missing"   — requiredMedia=True but nothing uploaded (any ctx)
      • "soft_mismatch"  — uploaded media exists but none matches expected
      • "hard_missing"   — identity-critical item with no matching ctx upload
    """
    # Bulk-load media docs for this job
    media_ids: list[str] = []
    for s in sections:
        for it in s["items"]:
            media_ids.extend(it.get("media") or [])
    media_by_id: dict[str, dict] = {}
    if media_ids:
        async for m in db.inspection_media.find(
            {"_id": {"$in": media_ids}},
            {"_id": 1, "capture": 1, "context": 1, "expectedContext": 1, "jobId": 1},
        ):
            media_by_id[m["_id"]] = m

    def _media_ctx(m: dict) -> str | None:
        """Return the captured context for a media doc, regardless of where it
        was persisted. UX-4A persists it under `capture.context`, but legacy
        rows may use a top-level `context` field — accept both."""
        if not m:
            return None
        cap = m.get("capture") or {}
        return cap.get("context") or m.get("context")

    items_report: list[dict[str, Any]] = []
    soft_count = 0
    hard_count = 0
    for s in sections:
        for it in s["items"]:
            expected = it.get("captureContext")
            required = bool(it.get("requiredMedia"))
            is_hard = it["id"] in HARD_ENFORCEMENT_ITEM_IDS
            uploaded_ctxs: list[str] = []
            for mid in (it.get("media") or []):
                m = media_by_id.get(mid)
                ctx = _media_ctx(m)
                if ctx:
                    uploaded_ctxs.append(ctx)
            ctx_match = bool(expected) and (expected in uploaded_ctxs)
            # Soft case 1: nothing uploaded but requiredMedia=True
            if required and not uploaded_ctxs:
                sev = "hard_missing" if is_hard else "soft_missing"
                if is_hard:
                    hard_count += 1
                else:
                    soft_count += 1
                items_report.append({
                    "sectionId": s["id"], "itemId": it["id"], "label": it["label"],
                    "expected": expected, "uploaded": [],
                    "severity": sev,
                    "reason": "expected_evidence_missing",
                    "hardEnforced": is_hard,
                })
                continue
            # Soft case 2: uploaded something but no ctx matches expected
            if expected and uploaded_ctxs and not ctx_match:
                sev = "hard_missing" if is_hard else "soft_mismatch"
                if is_hard:
                    hard_count += 1
                else:
                    soft_count += 1
                items_report.append({
                    "sectionId": s["id"], "itemId": it["id"], "label": it["label"],
                    "expected": expected, "uploaded": uploaded_ctxs,
                    "severity": sev,
                    "reason": "context_mismatch",
                    "hardEnforced": is_hard,
                })
                continue
            # Otherwise ok — include only items with requirements for UI clarity
            if required or expected:
                items_report.append({
                    "sectionId": s["id"], "itemId": it["id"], "label": it["label"],
                    "expected": expected, "uploaded": uploaded_ctxs,
                    "severity": "ok",
                    "reason": None,
                    "hardEnforced": is_hard,
                })
    return {"items": items_report, "softCount": soft_count, "hardCount": hard_count}


# ---------- Scoring -------------------------------------------------------

def _compute_summary(sections: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate item statuses → overallScore (0-10), recommendation, criticals.

    Rules:
      • critical → -2.0 from a base of 10
      • warning  → -0.4
      • ok       → 0
      • na/pending → ignored
      • clamp to [0, 10]
      • recommendation:
          score >= 8   → "buy"
          score >= 5   → "buy_with_caution"
          else         → "avoid"
        Critical items also force "avoid" regardless of score.
    """
    score = 10.0
    criticals: list[dict[str, str]] = []
    good_points: list[str] = []
    warnings: list[dict[str, str]] = []

    for s in sections:
        for it in s["items"]:
            st = it.get("status")
            if st == "critical":
                score -= 2.0
                criticals.append({"section": s["id"], "itemId": it["id"], "label": it["label"], "note": it.get("note") or ""})
            elif st == "warning":
                score -= 0.4
                warnings.append({"section": s["id"], "itemId": it["id"], "label": it["label"], "note": it.get("note") or ""})
            elif st == "ok":
                good_points.append(it["label"])
    score = max(0.0, min(10.0, round(score, 1)))

    if criticals:
        recommendation = "avoid"
    elif score >= 8.0:
        recommendation = "buy"
    elif score >= 5.0:
        recommendation = "buy_with_caution"
    else:
        recommendation = "avoid"

    return {
        "overallScore": score,
        "recommendation": recommendation,
        "criticalIssues": criticals,
        "warnings": warnings,
        "goodPoints": good_points[:10],  # cap list size — UI only renders a few
    }


# ---------- Validation ----------------------------------------------------

def _validate_completable(sections: list[dict[str, Any]]) -> list[str]:
    """Return list of human-readable errors that block submission.

    A report is submittable when:
      • every item has status != 'pending'
      • every item with `status in {critical, warning}` AND requiredMedia=True
        has at least 1 media reference
      • every item with requiredMedia=True has media OR was marked `na` / `ok`
        (we don't force media on items that are explicitly fine — only on
        flagged ones — to keep inspector flow fast in practice; the `ok`
        path implies "I saw it, no issue").
    """
    errors: list[str] = []
    for s in sections:
        for it in s["items"]:
            st = it.get("status")
            if st == "pending":
                errors.append(f"{s['id']}/{it['id']}: not evaluated")
                continue
            if it.get("requiredMedia") and st in ("critical", "warning"):
                if not it.get("media"):
                    errors.append(f"{s['id']}/{it['id']}: photo required for {st} status")
    return errors


# ---------- Pydantic ------------------------------------------------------

class StartBody(BaseModel):
    """Body for POST /api/inspections/{jobId}/start — currently no fields,
    placeholder for future overrides (e.g. inspector wants to start from a
    custom template tailored to the vehicle category)."""
    pass


class ItemUpdateBody(BaseModel):
    status: Optional[str] = Field(default=None, pattern="^(ok|warning|critical|na|pending)$")
    note: Optional[str] = Field(default=None, max_length=2000)
    addMediaIds: Optional[List[str]] = None
    removeMediaIds: Optional[List[str]] = None


class MediaQuality(BaseModel):
    """Client-side deterministic quality heuristics computed at capture time.
    Used for audit + future-trust signals — NOT for hard rejection (the inspector
    can override). Backend simply persists the report."""
    blurScore: Optional[float] = None       # variance-of-laplacian proxy; lower = blurrier
    brightness: Optional[float] = None      # 0..255 mean luminance
    width: Optional[int] = None
    height: Optional[int] = None
    passed: Optional[bool] = None           # client's verdict (all heuristics within bounds)


class MediaCapture(BaseModel):
    """Capture metadata. Provided by the guided-capture UI; stored verbatim."""
    context: Optional[str] = Field(default=None, max_length=24)   # vin / odometer / damage / tire / engine / interior / exterior / document / obd / general
    capturedAt: Optional[str] = Field(default=None, max_length=40)
    deviceModel: Optional[str] = Field(default=None, max_length=80)
    lat: Optional[float] = None
    lng: Optional[float] = None
    quality: Optional[MediaQuality] = None


class MediaUploadBody(BaseModel):
    sectionId: str
    itemId: str
    base64: str = Field(..., max_length=4_500_000)  # ~3.4 MB after b64 overhead
    mime: str = Field(default="image/jpeg", max_length=40)
    caption: Optional[str] = Field(default=None, max_length=200)
    capture: Optional[MediaCapture] = None


class OcrConfirmBody(BaseModel):
    action: str = Field(..., pattern="^(accept|correct)$")
    value: Optional[str] = Field(default=None, max_length=64)


# ---------- Internal -----------------------------------------------------

async def _get_job_or_404(db, job_id: str):
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "inspection job not found")
    return job


async def _ensure_inspector_owns_job(job: dict, user_id: str):
    if job.get("inspectorId") != user_id:
        raise HTTPException(403, "not your job")


# ---------- Endpoints: schema + report lifecycle --------------------------

@router.get("/template")
async def get_template():
    """Public read of the canonical template (used by frontend to render
    the section list before the inspector has started the inspection)."""
    return {"sections": SECTIONS_TEMPLATE}


@router.post("/{job_id}/start")
async def start_inspection_v2(
    job_id: str,
    body: Optional[StartBody] = None,
    ctx: IdentityContext = Depends(require_capability_v2("inspect")),  # noqa: B008
):
    """Create or fetch the draft report for this job. Idempotent."""
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    await _ensure_inspector_owns_job(job, ctx.user_id)

    existing = await db.inspection_reports_v2.find_one({"jobId": job_id}, {"_id": 0})
    if existing:
        return {"report": existing, "created": False}

    report_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "_id": report_id,
        "id": report_id,
        "jobId": job_id,
        "bookingId": job.get("requestId"),
        "vehicleId": job.get("vehicleId"),
        "inspectorId": ctx.user_id,
        "inspectorAccountId": ctx.account.id,
        "status": "draft",
        "startedAt": now,
        "completedAt": None,
        "overallScore": None,
        "recommendation": None,
        "criticalIssues": [],
        "warnings": [],
        "goodPoints": [],
        "sections": _new_template(),
    }
    await db.inspection_reports_v2.insert_one(doc)
    # UX-4B: emit timeline event
    try:
        from .timeline import emit_event
        await emit_event(db, job_id=job_id, event_type="inspection.started",
                         actor_id=ctx.user_id, report_id=report_id,
                         payload={"sectionsCount": len(doc["sections"])})
    except Exception:
        pass
    doc.pop("_id", None)
    return {"report": doc, "created": True}


@router.get("/{job_id}/report")
async def get_draft(
    job_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Read current draft. Inspector (job owner) OR customer (request owner)
    can read once status != draft. While draft, only inspector can read."""
    db = get_db()
    report = await db.inspection_reports_v2.find_one({"jobId": job_id}, {"_id": 0})
    if not report:
        raise HTTPException(404, "no report yet for this job")
    job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 0, "requestId": 1, "inspectorId": 1, "customerId": 1})
    if not job:
        raise HTTPException(404, "job not found")

    is_inspector = job.get("inspectorId") == ctx.user_id
    is_customer = job.get("customerId") == ctx.user_id

    if not is_inspector and not is_customer:
        # Check request owner as a fallback (some flows store customer on the request)
        if job.get("requestId"):
            req = await db.car_requests.find_one({"_id": job["requestId"]}, {"_id": 0, "customerId": 1, "userId": 1})
            if req and (req.get("customerId") == ctx.user_id or req.get("userId") == ctx.user_id):
                is_customer = True
    if not is_inspector and not is_customer:
        raise HTTPException(403, "not allowed")
    if report["status"] == "draft" and not is_inspector:
        raise HTTPException(403, "draft not visible to customer yet")

    return {"report": report}


@router.patch("/{job_id}/sections/{section_id}/items/{item_id}")
async def update_item(
    job_id: str,
    section_id: str,
    item_id: str,
    body: ItemUpdateBody,
    ctx: IdentityContext = Depends(require_capability_v2("inspect")),  # noqa: B008
):
    """Mutate a single checklist item. Inspector-only, draft-only."""
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    await _ensure_inspector_owns_job(job, ctx.user_id)

    report = await db.inspection_reports_v2.find_one({"jobId": job_id})
    if not report:
        raise HTTPException(404, "no report yet — POST /start first")
    if report["status"] != "draft":
        raise HTTPException(409, "report already submitted — cannot edit")

    # Find target section + item
    found = False
    for s in report["sections"]:
        if s["id"] != section_id:
            continue
        for it in s["items"]:
            if it["id"] != item_id:
                continue
            if body.status is not None:
                it["status"] = body.status
            if body.note is not None:
                it["note"] = body.note.strip() or None
            if body.addMediaIds:
                for mid in body.addMediaIds:
                    if mid not in it["media"]:
                        it["media"].append(mid)
            if body.removeMediaIds:
                it["media"] = [m for m in it["media"] if m not in body.removeMediaIds]
            found = True
            break
        break

    if not found:
        raise HTTPException(404, f"section/{section_id}/items/{item_id} not found")

    now = datetime.now(timezone.utc).isoformat()
    await db.inspection_reports_v2.update_one(
        {"jobId": job_id},
        {"$set": {"sections": report["sections"], "updatedAt": now}},
    )

    # UX-4B: emit flagged events only (we don't spam timeline with every
    # status tick; only the transition into critical/warning is interesting).
    if body.status in ("critical", "warning"):
        try:
            # Re-fetch the item label for payload friendliness
            target_label = None
            for s in report["sections"]:
                if s["id"] == section_id:
                    for it in s["items"]:
                        if it["id"] == item_id:
                            target_label = it.get("label")
                            break
                    break
            from .timeline import emit_event
            await emit_event(
                db, job_id=job_id,
                event_type=f"item.flagged_{body.status}",
                actor_id=ctx.user_id, report_id=report["id"],
                payload={
                    "sectionId": section_id,
                    "itemId": item_id,
                    "label": target_label,
                    "note": body.note,
                },
            )
        except Exception:
            pass
    report.pop("_id", None)
    return {"report": report}


@router.post("/{job_id}/media")
async def upload_media(
    job_id: str,
    body: MediaUploadBody,
    ctx: IdentityContext = Depends(require_capability_v2("inspect")),  # noqa: B008
):
    """Upload a base64 photo and link it to the target checklist item.

    Returns the media doc with `id` so the frontend can attach it via
    PATCH addMediaIds in case the auto-link below already failed (we keep
    both paths idempotent)."""
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    await _ensure_inspector_owns_job(job, ctx.user_id)

    report = await db.inspection_reports_v2.find_one({"jobId": job_id})
    if not report:
        raise HTTPException(404, "start the inspection first")
    if report["status"] != "draft":
        raise HTTPException(409, "report already submitted")

    media_id = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    media_doc = {
        "_id": media_id,
        "id": media_id,
        "reportId": report["id"],
        "jobId": job_id,
        "sectionId": body.sectionId,
        "itemId": body.itemId,
        "mime": body.mime,
        "base64": body.base64,
        "caption": (body.caption or "").strip() or None,
        "uploadedBy": ctx.user_id,
        "createdAt": now,
        # UX-4A: guided capture metadata (stored verbatim from client)
        "capture": body.capture.model_dump(exclude_none=True) if body.capture else None,
    }
    await db.inspection_media.insert_one(media_doc)

    # Link into the item.media[] list.
    target_item: dict | None = None
    for s in report["sections"]:
        if s["id"] != body.sectionId:
            continue
        for it in s["items"]:
            if it["id"] == body.itemId:
                it["media"].append(media_id)
                target_item = it
                break
        break
    await db.inspection_reports_v2.update_one(
        {"jobId": job_id},
        {"$set": {"sections": report["sections"], "updatedAt": now}},
    )

    # UX-4B: provenance + suspicion + timeline event.
    # Persist sha256 onto media doc so DUPLICATE_HASH heuristic can find it.
    try:
        from .timeline import build_media_provenance, emit_event
        # Look up expected context from canonical template (handles legacy
        # reports created before captureContext was added to template).
        expected_ctx = None
        for s_t in SECTIONS_TEMPLATE:
            if s_t["id"] != body.sectionId:
                continue
            for it_t in s_t["items"]:
                if it_t["id"] == body.itemId:
                    expected_ctx = it_t.get("captureContext")
                    break
            break
        provenance, suspicion = await build_media_provenance(
            db, job_id=job_id, media_doc=media_doc, item_expected_context=expected_ctx,
        )
        sha = provenance.get("sha256")
        if sha:
            await db.inspection_media.update_one(
                {"_id": media_id}, {"$set": {"sha256": sha}},
            )
        # Event type encodes the captured context (vin_uploaded, odometer_uploaded …)
        captured_ctx = (body.capture.context if body.capture else None) or expected_ctx or "general"
        event_type = f"media.uploaded.{captured_ctx}"
        await emit_event(
            db, job_id=job_id, event_type=event_type, actor_id=ctx.user_id,
            report_id=report["id"],
            payload={
                "mediaId": media_id,
                "sectionId": body.sectionId,
                "itemId": body.itemId,
                "caption": media_doc.get("caption"),
            },
            provenance=provenance, suspicion=suspicion,
        )
    except Exception as exc:
        logger.warning(f"[v2.media] timeline emit failed: {exc}")

    # OCR-1 — synchronous VIN/odometer OCR after upload. Failure-silent.
    ocr_result: dict | None = None
    if (body.capture and body.capture.context in ("vin", "odometer")):
        try:
            from .ocr import run_ocr
            ocr_result = await run_ocr(body.base64, body.capture.context, mime=body.mime)
        except Exception as exc:
            logger.warning(f"[v2.media] ocr call failed: {exc}")
            ocr_result = None
        if ocr_result and ocr_result.get("candidate"):
            ocr_payload = {
                "kind": ocr_result["kind"],
                "candidate": ocr_result["candidate"],
                "confidence": ocr_result["confidence"],
                "status": "detected",
                "at": datetime.now(timezone.utc).isoformat(),
            }
            if ocr_result["kind"] == "odometer":
                ocr_payload["unit"] = ocr_result.get("candidateUnit", "km")
                ocr_payload["rawValue"] = ocr_result.get("rawValue")
                ocr_payload["rawUnit"] = ocr_result.get("rawUnit")
            await db.inspection_media.update_one(
                {"_id": media_id}, {"$set": {"ocr": ocr_payload}},
            )
            # Emit ocr.{kind}_detected timeline event (workflow narrative for
            # the inspector; admin can still see it as part of the same stream).
            try:
                from .timeline import emit_event
                await emit_event(
                    db, job_id=job_id, event_type=f"ocr.{ocr_result['kind']}_detected",
                    actor_id=ctx.user_id, report_id=report["id"],
                    payload={
                        "mediaId": media_id,
                        "sectionId": body.sectionId,
                        "itemId": body.itemId,
                        "candidate": ocr_result["candidate"],
                        "confidence": ocr_result["confidence"],
                    },
                )
            except Exception as exc:
                logger.warning(f"[v2.media] ocr timeline emit failed: {exc}")

    return {
        "media": {
            "id": media_id,
            "sectionId": body.sectionId,
            "itemId": body.itemId,
            "mime": media_doc["mime"],
            "caption": media_doc["caption"],
            "ocr": ocr_result and ocr_result.get("candidate") and {
                "kind": ocr_result["kind"],
                "candidate": ocr_result["candidate"],
                "confidence": ocr_result["confidence"],
                "status": "detected",
                **({"unit": ocr_result.get("candidateUnit", "km")} if ocr_result["kind"] == "odometer" else {}),
            } or None,
        },
    }


@router.get("/{job_id}/media/{media_id}")
async def get_media(
    job_id: str,
    media_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    db = get_db()
    md = await db.inspection_media.find_one({"_id": media_id, "jobId": job_id}, {"_id": 0})
    if not md:
        raise HTTPException(404, "media not found")
    # Authorization same as report read; cheap path: inspector or customer
    job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 0, "inspectorId": 1, "customerId": 1, "requestId": 1})
    if not job:
        raise HTTPException(404, "job not found")
    if job.get("inspectorId") != ctx.user_id:
        # check customer side
        customer_id = job.get("customerId")
        if not customer_id and job.get("requestId"):
            req = await db.car_requests.find_one({"_id": job["requestId"]}, {"customerId": 1, "userId": 1})
            if req:
                customer_id = req.get("customerId") or req.get("userId")
        if customer_id != ctx.user_id:
            raise HTTPException(403, "not allowed")
    return {"media": md}


# ---------- OCR-1 — VIN / odometer correction endpoint -------------------

@router.post("/{job_id}/media/{media_id}/ocr/confirm")
async def ocr_confirm(
    job_id: str,
    media_id: str,
    body: OcrConfirmBody,
    ctx: IdentityContext = Depends(require_capability_v2("inspect")),  # noqa: B008
):
    """Inspector accepts the OCR candidate or corrects it.

    OCR-1 contract:
      • action="accept"  → media.ocr.status = "confirmed", value unchanged
      • action="correct" → media.ocr.status = "corrected",
                           media.ocr.correctedValue = body.value (required),
                           emits ocr.corrected timeline event

    The corrected value is also persisted on the parent report root
    (`extractedVin` for VIN, `extractedMileageKm` for odometer) so the
    customer-facing PDF and admin views can read it without media joins.
    """
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    await _ensure_inspector_owns_job(job, ctx.user_id)

    md = await db.inspection_media.find_one({"_id": media_id, "jobId": job_id})
    if not md:
        raise HTTPException(404, "media not found")
    ocr = md.get("ocr")
    if not ocr:
        raise HTTPException(409, "no OCR result on this media")
    if ocr.get("status") not in (None, "detected"):
        raise HTTPException(409, f"OCR already {ocr.get('status')}")

    kind = ocr.get("kind")
    now = datetime.now(timezone.utc).isoformat()

    if body.action == "accept":
        final_value = ocr.get("candidate")
        new_status = "confirmed"
    else:  # correct
        if not (body.value and body.value.strip()):
            raise HTTPException(400, "correction requires a non-empty value")
        final_value = body.value.strip()
        new_status = "corrected"

    # Light validation for VIN — but never block the inspector. If they
    # explicitly corrected it, we trust their override.
    if kind == "vin" and body.action == "correct":
        final_value = final_value.upper().replace(" ", "").replace("-", "")
    elif kind == "odometer" and body.action == "correct":
        # Strip non-digits but keep raw string for audit
        digits = "".join(c for c in final_value if c.isdigit())
        if digits:
            final_value = digits

    ocr_update = {
        **ocr,
        "status": new_status,
        "finalValue": final_value,
        "confirmedAt": now,
        "confirmedBy": ctx.user_id,
    }
    if body.action == "correct":
        ocr_update["correctedFrom"] = ocr.get("candidate")
    await db.inspection_media.update_one({"_id": media_id}, {"$set": {"ocr": ocr_update}})

    # Persist on report root for fast downstream reads (PDF, customer view, admin).
    report_field = "extractedVin" if kind == "vin" else "extractedMileageKm"
    report_value: Any = final_value
    if kind == "odometer":
        try:
            report_value = int(final_value)
        except (TypeError, ValueError):
            report_value = None
    if report_value not in (None, ""):
        await db.inspection_reports_v2.update_one(
            {"jobId": job_id},
            {"$set": {report_field: report_value, "updatedAt": now}},
        )

    # Timeline event — only for corrections. Acceptances are implicit
    # (the inspector ratifying the candidate is the default path; we don't
    # spam the rail with confirmations).
    if body.action == "correct":
        try:
            from .timeline import emit_event
            await emit_event(
                db, job_id=job_id, event_type="ocr.corrected",
                actor_id=ctx.user_id,
                payload={
                    "mediaId": media_id,
                    "kind": kind,
                    "from": ocr.get("candidate"),
                    "to": final_value,
                },
            )
        except Exception as exc:
            logger.warning(f"[v2.ocr] timeline emit failed: {exc}")

    # Correlation pass — Listing ↔ OCR cross-check. Admin-only, signal-only.
    # Runs after every confirm so signals stay in sync with the latest
    # extracted values. Failure-silent: the inspector confirm path never
    # depends on correlation succeeding.
    try:
        from .correlation import persist_and_emit
        await persist_and_emit(db, job_id=job_id, actor_id=ctx.user_id)
    except Exception as exc:
        logger.warning(f"[v2.ocr] correlation pass failed: {exc}")

    return {
        "ocr": {k: v for k, v in ocr_update.items() if k != "raw"},
        "report": {report_field: report_value},
    }


# ---------- Correlation (Listing ↔ Evidence) — admin-only ----------------

def _is_admin_ctx(ctx: IdentityContext) -> bool:
    """Mirror of timeline.get_timeline admin gate. Kept local to avoid
    coupling between modules — both are 4-line decisions."""
    if (ctx.legacy_role or "").lower() == "admin":
        return True
    acc = ctx.account
    if acc:
        if (getattr(acc, "legacyRole", "") or "").lower() == "admin":
            return True
        if (getattr(acc, "kind", "") or "").lower() == "admin":
            return True
    return False


@router.get("/{job_id}/correlations")
async def get_correlations(
    job_id: str,
    recompute: bool = False,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Read listing-vs-evidence correlation signals for a job.

    Admin-only by design. Inspectors and customers get 403 here even though
    they can read the timeline — signals are deliberately not part of the
    operational workflow.

    Query:
      • `recompute=true` → recompute against latest report+listing state
                           (default reads the cached snapshot).
    """
    if not _is_admin_ctx(ctx):
        raise HTTPException(403, "admin only")

    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 1})
    if not job:
        raise HTTPException(404, "job not found")

    from .correlation import compute_correlations, persist_and_emit
    if recompute:
        return await persist_and_emit(db, job_id=job_id, actor_id=ctx.user_id)

    snapshot = await db.inspection_correlations.find_one(
        {"jobId": job_id}, {"_id": 0},
    )
    if snapshot:
        return snapshot

    # No snapshot yet — compute on-demand (also persist so subsequent reads
    # are cheap). This is the natural first-admin-read path.
    return await persist_and_emit(db, job_id=job_id, actor_id=ctx.user_id)


@router.post("/{job_id}/submit")
async def submit_v2(
    job_id: str,
    override: bool = False,
    ctx: IdentityContext = Depends(require_capability_v2("inspect")),  # noqa: B008
):
    """Validate + finalize draft → status=submitted, compute scoring.

    UX-4C — Required-context enforcement:
      • Hard gaps (identity-critical items: VIN/odometer/registration with
        missing or context-mismatched evidence) ALWAYS block submission.
      • Soft gaps (other requiredMedia items) block by default but the
        inspector can pass `?override=true` to acknowledge them; the override
        is recorded as a timeline event for audit.
    """
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    await _ensure_inspector_owns_job(job, ctx.user_id)

    report = await db.inspection_reports_v2.find_one({"jobId": job_id})
    if not report:
        raise HTTPException(404, "no draft to submit")
    if report["status"] != "draft":
        raise HTTPException(409, "already submitted")

    errors = _validate_completable(report["sections"])
    if errors:
        raise HTTPException(422, {"message": "report incomplete", "errors": errors})

    # UX-4C enforcement — compute structured gap report.
    gaps = await _compute_evidence_gaps(db, job_id, report["sections"])
    if gaps["hardCount"] > 0:
        # Hard gaps are never overridable — these are identity-critical.
        raise HTTPException(
            422,
            {
                "error": True,
                "code": "EVIDENCE_GAPS_HARD",
                "message": "expected_evidence_missing",
                "details": {
                    "kind": "hard",
                    "hardCount": gaps["hardCount"],
                    "softCount": gaps["softCount"],
                    "items": [g for g in gaps["items"] if g["severity"] == "hard_missing"],
                },
            },
        )
    if gaps["softCount"] > 0 and not override:
        raise HTTPException(
            422,
            {
                "error": True,
                "code": "EVIDENCE_GAPS_SOFT",
                "message": "expected_evidence_missing",
                "details": {
                    "kind": "soft",
                    "hardCount": 0,
                    "softCount": gaps["softCount"],
                    "items": [g for g in gaps["items"]
                              if g["severity"] in ("soft_missing", "soft_mismatch")],
                    "hint": "Pass override=true to submit anyway (operator acknowledged).",
                },
            },
        )

    summary = _compute_summary(report["sections"])
    now = datetime.now(timezone.utc).isoformat()
    await db.inspection_reports_v2.update_one(
        {"jobId": job_id},
        {"$set": {
            "status": "submitted",
            "completedAt": now,
            "updatedAt": now,
            **summary,
        }},
    )

    # Mirror into legacy collection so existing customer flows that read
    # `inspection_reports` keep working (UX-2B dashboard reads from there).
    try:
        legacy = {
            "_id": report["id"],
            "jobId": job_id,
            "requestId": report.get("bookingId"),
            "vehicleId": report.get("vehicleId"),
            "inspectorId": ctx.user_id,
            "inspectorAccountId": ctx.account.id,
            "score": summary["overallScore"],
            "verdict": summary["recommendation"],
            "verdict_text": summary["recommendation"],
            "criticalCount": len(summary["criticalIssues"]),
            "warningCount": len(summary["warnings"]),
            "v2": True,
            "createdAt": now,
            "finishedAt": now,
        }
        await db.inspection_reports.update_one(
            {"_id": report["id"]}, {"$set": legacy}, upsert=True,
        )
    except Exception as exc:
        logger.warning(f"[inspections-v2] legacy mirror failed: {exc}")

    # UX-3 lifecycle close: flip the inspection_jobs status to `done`
    # so the inspector UI shows the "report submitted" terminal state
    # and the orchestrator/admin queues see this job as completed.
    try:
        await db.inspection_jobs.update_one(
            {"_id": job_id},
            {"$set": {
                "status": "done",
                "completedAt": now,
                "reportId": report["id"],
                "reportScore": summary["overallScore"],
                "reportRecommendation": summary["recommendation"],
                "updatedAt": now,
            }},
        )
    except Exception as exc:
        logger.warning(f"[inspections-v2] job status update failed: {exc}")

    report["status"] = "submitted"
    report["completedAt"] = now
    report.update(summary)
    report.pop("_id", None)

    # UX-4B: emit submit timeline event
    try:
        from .timeline import emit_event
        # UX-4C: if inspector overrode soft gaps, record that explicitly first
        # so the audit trail captures the acknowledgment chronologically before
        # the report.submitted event.
        if override and gaps["softCount"] > 0:
            await emit_event(
                db, job_id=job_id, event_type="evidence.gaps_overridden",
                actor_id=ctx.user_id, report_id=report["id"],
                payload={
                    "softCount": gaps["softCount"],
                    "items": [
                        {"sectionId": g["sectionId"], "itemId": g["itemId"],
                         "expected": g["expected"], "uploaded": g["uploaded"],
                         "reason": g["reason"]}
                        for g in gaps["items"]
                        if g["severity"] in ("soft_missing", "soft_mismatch")
                    ],
                },
            )
        await emit_event(
            db, job_id=job_id, event_type="report.submitted",
            actor_id=ctx.user_id, report_id=report["id"],
            payload={
                "score": summary["overallScore"],
                "recommendation": summary["recommendation"],
                "criticalCount": len(summary["criticalIssues"]),
                "warningCount": len(summary["warnings"]),
                # UX-4C: surface override flag for downstream forensic UI
                "overrodeSoftGaps": bool(override and gaps["softCount"] > 0),
            },
        )
    except Exception:
        pass

    return {"report": report, "summary": summary}


# ---------- UX-4C — Evidence gaps proactive endpoint ---------------------

@router.get("/{job_id}/evidence-gaps")
async def get_evidence_gaps(
    job_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Inspector-facing pre-submit check. Returns the same gap structure
    that submit() uses internally, so the UI can show per-item indicators
    *before* the inspector hits the submit button.

    Accessible to: inspector assigned to this job, admin.
    """
    db = get_db()
    job = await _get_job_or_404(db, job_id)
    is_inspector = job.get("inspectorId") == ctx.user_id
    is_admin = (
        (ctx.legacy_role or "").lower() == "admin"
        or (ctx.account and (getattr(ctx.account, "legacyRole", "") or "").lower() == "admin")
        or (ctx.account and (getattr(ctx.account, "kind", "") or "").lower() == "admin")
    )
    if not (is_inspector or is_admin):
        raise HTTPException(403, "inspector or admin only")

    report = await db.inspection_reports_v2.find_one({"jobId": job_id})
    if not report:
        return {"jobId": job_id, "items": [], "softCount": 0, "hardCount": 0,
                "status": "no_report"}

    gaps = await _compute_evidence_gaps(db, job_id, report["sections"])
    return {
        "jobId": job_id,
        "status": report.get("status", "draft"),
        **gaps,
    }


# ---------- Customer view ------------------------------------------------

@router.get("/{job_id}/customer-view")
async def customer_view(
    job_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Return the report shaped for the customer screen — sections collapsed
    to readable summaries + media URL pointers (not base64 inline) so the
    customer screen can lazily fetch on tap.

    Authorization: customer of the originating request, or admin, or the
    inspector who produced it. Reports in `draft` are NEVER visible here.
    """
    db = get_db()
    report = await db.inspection_reports_v2.find_one({"jobId": job_id}, {"_id": 0})
    if not report or report.get("status") == "draft":
        raise HTTPException(404, "no submitted report for this job")

    # Auth check (same shape as /report read)
    job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 0, "inspectorId": 1, "customerId": 1, "requestId": 1})
    is_inspector = job and job.get("inspectorId") == ctx.user_id
    customer_id = job and job.get("customerId")
    if not customer_id and job and job.get("requestId"):
        req = await db.car_requests.find_one({"_id": job["requestId"]}, {"customerId": 1, "userId": 1})
        if req:
            customer_id = req.get("customerId") or req.get("userId")
    is_customer = customer_id == ctx.user_id
    is_admin = ctx.account and getattr(ctx.account, "role", None) == "admin"
    if not (is_inspector or is_customer or is_admin):
        raise HTTPException(403, "not allowed")

    return {"report": _shape_customer_payload(report)}


# Section phrases for interpretation (shared between customer-view + PDF).
_SECTION_PHRASES: dict[str, dict[str, str]] = {
    "exterior":    {"critical": "Обнаружены серьёзные дефекты кузова или следы аварии",
                    "warning":  "На кузове есть дефекты, требующие внимания"},
    "interior":    {"critical": "Найдены критичные проблемы в салоне или электронике",
                    "warning":  "В салоне есть моменты, требующие внимания"},
    "engine":      {"critical": "Обнаружены критические проблемы двигателя",
                    "warning":  "У двигателя есть моменты, требующие внимания"},
    "suspension":  {"critical": "Критические проблемы подвески или тормозов",
                    "warning":  "Подвеска или тормоза требуют внимания"},
    "diagnostics": {"critical": "Найдены ошибки диагностики или признаки скрученного пробега",
                    "warning":  "Диагностика выявила моменты для внимания"},
    "test_drive":  {"critical": "Серьёзные проблемы выявились при тест-драйве",
                    "warning":  "Тест-драйв выявил моменты для внимания"},
    "documents":   {"critical": "Проблемы с документами или историей авто",
                    "warning":  "Документы требуют уточнения"},
}


def _shape_customer_payload(report: dict) -> dict:
    """Canonical customer-facing payload — single source of truth shared by
    the JSON `customer-view` endpoint and the PDF renderer.

    Drops `pending` items, computes per-section severity rollup,
    builds human-readable interpretation lines.
    """
    sections_view: list[dict[str, Any]] = []
    for s in report["sections"]:
        items = []
        sec_criticals, sec_warnings, sec_oks, sec_media = 0, 0, 0, 0
        for it in s["items"]:
            if it["status"] == "pending":
                continue
            mids = it.get("media") or []
            items.append({
                "id": it["id"], "label": it["label"], "status": it["status"],
                "note": it.get("note"),
                "mediaIds": mids,
                "mediaCount": len(mids),
            })
            sec_media += len(mids)
            if it["status"] == "critical":
                sec_criticals += 1
            elif it["status"] == "warning":
                sec_warnings += 1
            elif it["status"] == "ok":
                sec_oks += 1
        if items:
            severity = "critical" if sec_criticals else ("warning" if sec_warnings else "ok")
            sections_view.append({
                "id": s["id"],
                "title": s["title"],
                "items": items,
                "criticalCount": sec_criticals,
                "warningCount": sec_warnings,
                "okCount": sec_oks,
                "mediaCount": sec_media,
                "severity": severity,
            })

    interpretation: list[dict[str, Any]] = []
    for sv in sections_view:
        phrases = _SECTION_PHRASES.get(sv["id"], {})
        if sv["criticalCount"] > 0 and phrases.get("critical"):
            interpretation.append({
                "section": sv["id"], "severity": "critical",
                "title": phrases["critical"], "count": sv["criticalCount"],
            })
        elif sv["warningCount"] > 0 and phrases.get("warning"):
            interpretation.append({
                "section": sv["id"], "severity": "warning",
                "title": phrases["warning"], "count": sv["warningCount"],
            })

    rec = report.get("recommendation")
    if rec == "avoid":
        headline = "Мы не рекомендуем покупку"
    elif rec == "buy_with_caution":
        headline = "Покупка возможна, но с торгом и осторожностью"
    elif rec == "buy":
        headline = "Серьёзных проблем не выявлено — авто можно покупать"
    else:
        headline = ""

    return {
        "id": report.get("id"),
        "jobId": report.get("jobId"),
        "overallScore": report.get("overallScore"),
        "recommendation": report.get("recommendation"),
        "criticalIssues": report.get("criticalIssues", []),
        "warnings": report.get("warnings", []),
        "goodPoints": report.get("goodPoints", []),
        "completedAt": report.get("completedAt"),
        "vehicleId": report.get("vehicleId"),
        "bookingId": report.get("bookingId"),
        "inspectorId": report.get("inspectorId"),
        "sections": sections_view,
        "interpretation": {
            "headline": headline,
            "lines": interpretation,
        },
    }


# ---------- PDF export (UX-3D) -------------------------------------------

@router.get("/{job_id}/report.pdf")
async def report_pdf(
    job_id: str,
    ctx: IdentityContext = Depends(decode_and_resolve),  # noqa: B008
):
    """Download canonical inspection report as a portable PDF artifact.

    Deterministic — built from the same `_shape_customer_payload` that
    the in-app customer screen consumes. One source of truth.
    """
    from fastapi.responses import StreamingResponse
    from .pdf import render_report_pdf

    db = get_db()
    report = await db.inspection_reports_v2.find_one({"jobId": job_id}, {"_id": 0})
    if not report or report.get("status") == "draft":
        raise HTTPException(404, "no submitted report for this job")

    # Same auth as customer_view
    job = await db.inspection_jobs.find_one({"_id": job_id}, {"_id": 0, "inspectorId": 1, "customerId": 1, "requestId": 1})
    is_inspector = job and job.get("inspectorId") == ctx.user_id
    customer_id = job and job.get("customerId")
    if not customer_id and job and job.get("requestId"):
        req = await db.car_requests.find_one({"_id": job["requestId"]}, {"customerId": 1, "userId": 1})
        if req:
            customer_id = req.get("customerId") or req.get("userId")
    is_customer = customer_id == ctx.user_id
    is_admin = ctx.account and getattr(ctx.account, "role", None) == "admin"
    if not (is_inspector or is_customer or is_admin):
        raise HTTPException(403, "not allowed")

    # Build canonical payload (same as JSON view) then collect embedded
    # photos as base64 → bytes for PDF embedding.
    payload = _shape_customer_payload(report)
    media_lookup: dict[str, dict] = {}
    for m in report.get("media", []):
        mid = m.get("id")
        if mid and m.get("base64"):
            media_lookup[mid] = {"base64": m["base64"], "mime": m.get("mime", "image/jpeg")}

    # Try to enrich with vehicle info for cover page
    vehicle = None
    if report.get("vehicleId"):
        try:
            v = await db.vehicles.find_one({"_id": report["vehicleId"]}, {"_id": 0})
            if v:
                vehicle = {
                    "title": v.get("title") or v.get("model") or "—",
                    "vin": v.get("vin"),
                    "year": v.get("year"),
                    "mileage": v.get("mileage"),
                }
        except Exception:
            pass

    pdf_bytes = render_report_pdf(payload, media_lookup=media_lookup, vehicle=vehicle)

    filename = f"inspection-{job_id[:8]}.pdf"
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )
