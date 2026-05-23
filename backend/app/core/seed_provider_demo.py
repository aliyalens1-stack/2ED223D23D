"""app.core.seed_provider_demo — Phase 3.1 demo data for Provider Workbench
and Provider Earnings Clarity.

Purpose: ensure that `provider@test.com` always has rich, deterministic
seed data that exercises EVERY ProviderWorkItemState and every
ProviderEarningsItemState — so the mobile + web surfaces can be reviewed
end-to-end without depending on real customer traffic.

Design rules (mirror Phase 3.1 doctrine):
  - Read-only projector; this seed only creates **truths** the projector
    already knows how to read (bookings, inspection_jobs, payments,
    auction_charges, quick_request_offers). It introduces no new
    collections and no new state vocabulary.
  - Idempotent: every inserted document has a stable demo id prefixed
    with `demo-wb-` (workbench) or `demo-er-` (earnings) or `demo-qr-`
    (quick request). On re-run, existing demo docs are upserted; legacy
    bookings owned by the same provider are NOT touched.
  - Off by default for non-demo providers: only acts when the provider
    user `provider@test.com` exists.

Effect on UI:
  - Workbench shows ≥1 item in each visible state group:
      needs_response · blocked · in_progress · on_site · en_route ·
      report_required · awaiting_review · scheduled · completed
  - Earnings Clarity shows items in pending / payable / disputed_hold /
    deducted (Phase 3.1 emits these four; processing + paid_out are
    reserved Phase 3.3 substrate and intentionally absent).
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from typing import Optional

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(d: datetime) -> str:
    return d.isoformat()


async def seed_provider_workbench_demo(db) -> None:
    """Idempotent. Safe to call on every startup."""
    provider = await db.users.find_one({"email": "provider@test.com"})
    if not provider:
        logger.info("[demo-3.1] provider@test.com not found — skip")
        return
    pid = str(provider["_id"])

    org = await db.organizations.find_one({"ownerId": pid, "status": "active"}, {"_id": 0, "slug": 1, "name": 1})
    if not org or not org.get("slug"):
        logger.info("[demo-3.1] provider has no active organization — skip")
        return
    slug = org["slug"]

    now = _now()

    # ── 1. BOOKINGS — operational states + completed (earnings sources) ──
    # Each entry: (suffix, status, kind_extra, completed_offset_hours)
    bookings_spec = [
        # operational
        ("scheduled-1",   "confirmed",   {"slotDate": _iso(now + timedelta(hours=2))}),
        ("on-route-1",    "on_route",    {}),
        ("on-site-1",     "arrived",     {}),
        ("in-progress-1", "in_progress", {}),
        # earnings sources — completed within 24h so projector picks them up.
        ("done-paid",        "completed", {"completedAt": _iso(now - timedelta(hours=2)),  "_payment_status": "paid"}),
        ("done-pending",     "completed", {"completedAt": _iso(now - timedelta(hours=4)),  "_payment_status": None}),
        ("done-disputed",    "completed", {"completedAt": _iso(now - timedelta(hours=6)),  "_payment_status": "disputed"}),
    ]

    booking_docs: list[dict] = []
    for suffix, status, extras in bookings_spec:
        bid = f"demo-wb-bk-{suffix}"
        doc = {
            "id":              bid,
            "providerSlug":    slug,
            "status":          status,
            "serviceName":     {
                "scheduled-1":   "Замена колодок",
                "on-route-1":    "Эвакуация на СТО",
                "on-site-1":     "Проверка двигателя",
                "in-progress-1": "Замена масла",
                "done-paid":        "Диагностика подвески",
                "done-pending":     "Развал-схождение",
                "done-disputed":    "Замена тормозных дисков",
            }[suffix],
            "customerName":    {
                "scheduled-1":   "Мария К.",
                "on-route-1":    "Дмитрий В.",
                "on-site-1":     "Алексей П.",
                "in-progress-1": "Ольга Н.",
                "done-paid":     "Иван С.",
                "done-pending":  "Елена М.",
                "done-disputed": "Сергей Л.",
            }[suffix],
            "address":         "Берлин, Митте",
            "distanceKm":      2.4,
            "priceEstimate":   {
                "scheduled-1":   80,
                "on-route-1":    150,
                "on-site-1":     90,
                "in-progress-1": 60,
                "done-paid":     120,
                "done-pending":  100,
                "done-disputed": 240,
            }[suffix],
            "currency":        "EUR",
            "createdAt":       _iso(now - timedelta(hours=24)),
            "acceptedAt":      _iso(now - timedelta(hours=20)),
        }
        # merge per-spec extras (slotDate, completedAt). _payment_status is consumed by step 2 below, NOT stored.
        for k, v in extras.items():
            if k == "_payment_status":
                continue
            doc[k] = v
        booking_docs.append((doc, extras.get("_payment_status")))

    for doc, _ in booking_docs:
        await db.bookings.update_one({"id": doc["id"]}, {"$set": doc}, upsert=True)

    # ── 2. PAYMENTS — wire payment status for the three completed bookings ──
    for doc, payment_status in booking_docs:
        if payment_status is None:
            # delete any prior demo payment so the booking is "pending" earnings
            await db.payments.delete_many({"bookingId": doc["id"], "id": {"$regex": "^demo-er-pm-"}})
            continue
        pm_id = f"demo-er-pm-{doc['id']}"
        pm = {
            "id":         pm_id,
            "bookingId":  doc["id"],
            "amount":     doc["priceEstimate"],
            "currency":   "EUR",
            "status":     payment_status,  # 'paid' | 'disputed' | etc.
            "paidAt":     _iso(now - timedelta(hours=1)) if payment_status == "paid" else None,
            "createdAt":  _iso(now - timedelta(hours=2)),
        }
        await db.payments.update_one({"id": pm_id}, {"$set": pm}, upsert=True)

    # ── 3. INSPECTION JOBS — exercise inspector-side states + earnings via approved report ──
    # claim/in-progress/done states + reports of statuses submitted/approved/rejected.
    job_specs = [
        # (suffix, status, report_status_or_None, brand, model, budget)
        ("inspection-claimed",         "claimed",    None,       "BMW",   "320d",    150),
        ("inspection-inspecting",      "inspecting", None,       "Audi",  "A4",      170),
        ("inspection-done-no-report",  "done",       None,       "Mercedes", "C200", 180),  # → S_REPORT_REQUIRED
        ("inspection-done-submitted",  "done",       "submitted","VW",    "Passat",  140),  # → S_AWAITING_REVIEW
        ("inspection-done-approved",   "done",       "approved", "Skoda", "Octavia", 130),  # → S_COMPLETED + earnings
        ("inspection-done-rejected",   "done",       "rejected", "Opel",  "Astra",   125),  # → S_BLOCKED
    ]

    for suffix, status, rep_status, brand, model, budget in job_specs:
        jid = f"demo-wb-ij-{suffix}"
        rep_id = f"demo-wb-rep-{suffix}" if rep_status else None
        completed_at = _iso(now - timedelta(hours=3)) if status == "done" else None

        job_doc = {
            "_id":            jid,
            "id":             jid,
            "inspectorId":    pid,
            "status":         status,
            "brand":          brand,
            "model":          model,
            "budget":         budget,
            "currency":       "EUR",
            "city":           "Berlin",
            "address":        "Berlin, Mitte",
            "customerName":   "Demo Customer",
            "scheduledFor":   _iso(now + timedelta(hours=4)) if status == "claimed" else None,
            "createdAt":      _iso(now - timedelta(hours=12)),
            "completedAt":    completed_at,
            "reportId":       rep_id,
        }
        await db.inspection_jobs.update_one({"_id": jid}, {"$set": job_doc}, upsert=True)

        if rep_id:
            rep_doc = {
                "_id":         rep_id,
                "id":          rep_id,
                "jobId":       jid,
                "status":      rep_status,
                "submittedAt": _iso(now - timedelta(hours=2)),
                "approvedAt":  _iso(now - timedelta(hours=1)) if rep_status == "approved" else None,
                "rejectReason": "Не хватает фото подкапотного пространства" if rep_status == "rejected" else None,
            }
            await db.inspection_reports.update_one({"_id": rep_id}, {"$set": rep_doc}, upsert=True)

            # Customer-facing surface reads from `inspection_reports_v2` (the
            # canonical post-Step-9 schema with sections/items/severity).
            # Seed a parallel v2 record so the inspector can open the report
            # from the jobs list ("tap to open" → /inspection-report/[jobId])
            # and the PDF endpoint (/api/inspections/{jobId}/report.pdf)
            # returns real bytes instead of 404. Status `submitted`/`approved`
            # both pass the "report.status != draft" check in customer-view.
            v2_status = "submitted" if rep_status in ("submitted", "approved") else (
                "rejected" if rep_status == "rejected" else "submitted"
            )
            v2_doc = {
                "_id":            rep_id,
                "id":             rep_id,
                "jobId":          jid,
                "status":         v2_status,
                "inspectorId":    pid,
                "submittedAt":    _iso(now - timedelta(hours=2)),
                "completedAt":    _iso(now - timedelta(hours=2)),
                "overallScore":   8 if rep_status == "approved" else 7,
                "recommendation": "buy" if rep_status == "approved" else "buy_with_caution",
                "criticalIssues": [],
                "warnings": [
                    {"section": "exterior", "itemId": "paint_quality",
                     "label": "Незначительные царапины на бампере",
                     "note": "Косметические, не критичны"},
                ],
                "goodPoints": [
                    "Все основные узлы в рабочем состоянии",
                    "Документы в порядке",
                ],
                "sections": [
                    {
                        "id": "exterior", "title": "Кузов",
                        "items": [
                            {"id": "paint_quality", "label": "Состояние ЛКП",
                             "status": "warning",
                             "note": "Незначительные царапины на бампере",
                             "media": []},
                            {"id": "body_alignment", "label": "Геометрия кузова",
                             "status": "ok", "note": None, "media": []},
                        ],
                    },
                    {
                        "id": "engine", "title": "Двигатель",
                        "items": [
                            {"id": "engine_start", "label": "Запуск двигателя",
                             "status": "ok", "note": "Заводится с первого раза",
                             "media": []},
                            {"id": "engine_noise", "label": "Посторонние шумы",
                             "status": "ok", "note": None, "media": []},
                        ],
                    },
                    {
                        "id": "interior", "title": "Салон",
                        "items": [
                            {"id": "interior_wear", "label": "Износ салона",
                             "status": "ok", "note": "Состояние соответствует пробегу",
                             "media": []},
                        ],
                    },
                    {
                        "id": "documents", "title": "Документы",
                        "items": [
                            {"id": "doc_check", "label": "Проверка документов",
                             "status": "ok", "note": "VIN совпадает, обременений нет",
                             "media": []},
                        ],
                    },
                ],
            }
            await db.inspection_reports_v2.update_one(
                {"_id": rep_id}, {"$set": v2_doc}, upsert=True
            )

    # ── 4. QUICK REQUEST OFFERS — needs_response state ──
    # Need a quick_request + a pending offer addressed to our slug.
    # Projector requires qr.status='searching' AND topSolutions[].slug == our slug.
    qr_id = "demo-wb-qr-1"
    qr_doc = {
        "id":              qr_id,
        "status":          "searching",
        "problemLabel":    "Не заводится после ночи",
        "addressHint":     "Berlin, Friedrichshain, Boxhagener Pl. 1",
        "currency":        "EUR",
        "city":            "Berlin",
        "createdAt":       _iso(now - timedelta(minutes=4)),
        "expiresAt":       _iso(now + timedelta(minutes=4)),
        "priceEstimate":   90,
        "surge":           1.2,
        "topSolutions":    [
            {"slug": slug, "finalPrice": 90, "priceFrom": 80, "distance": 1.2},
        ],
    }
    await db.quick_requests.update_one({"id": qr_id}, {"$set": qr_doc}, upsert=True)

    offer_id = "demo-wb-qro-1"
    offer_doc = {
        "id":            offer_id,
        "requestId":     qr_id,
        "providerSlug":  slug,
        "status":        "pending",
        "createdAt":     _iso(now - timedelta(minutes=2)),
        "snapshot":      {"distance": 1.2, "surge": 1.0},
        "priceQuoted":   90,
        "currency":      "EUR",
    }
    await db.quick_request_offers.update_one({"id": offer_id}, {"$set": offer_doc}, upsert=True)

    # ── 5. AUCTION CHARGES — lead-fee deductions ──
    fees_spec = [
        ("af-1", "berlin-mitte",    8,  now - timedelta(days=2)),
        ("af-2", "berlin-neukolln", 10, now - timedelta(days=4)),
        ("af-3", "berlin-altona",   6,  now - timedelta(days=8)),
    ]
    for suffix, zone, amt, ts in fees_spec:
        cid = f"demo-er-{suffix}"
        await db.auction_charges.update_one(
            {"id": cid},
            {"$set": {
                "id":             cid,
                "providerSlug":   slug,
                "zone":           zone,
                "bookingId":      None,
                "amountCharged":  amt,
                "currency":       "EUR",
                "createdAt":      _iso(ts),
            }},
            upsert=True,
        )

    logger.info(
        "[demo-3.1] provider workbench/earnings demo seed: "
        "%d bookings, %d inspections, 1 QR offer, %d lead-fees for slug=%s",
        len(booking_docs), len(job_specs), len(fees_spec), slug,
    )
