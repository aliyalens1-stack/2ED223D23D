"""app.vehicles.public_memory — Public vehicle as a living memory system.

This is NOT a "report page" endpoint. /case/:id renders one event;
/vehicle/:id (this aggregator) renders the **digital life** of a single
car: ownership timeline, multi-report layering, recurring findings,
operator lineage, document events, value trajectory, comparative
intelligence (by brand+model).

The endpoint is intentionally PUBLIC (no auth):
  - When a buyer opens a /vehicle/:id link from outside the platform it
    must work. Auth-gating would defeat shareability.
  - PII (customer notes, plate, vin) is filtered server-side. The
    response contains only what is safe for any visitor to see.

Composition rules:
  - Reads only — never writes.
  - Best-effort joins: missing collections → empty arrays. Never raises
    on missing related docs.
  - Comparative intelligence is precomputed at request time over up to
    1k inspection_reports for the same brand+model. For real
    production scale this would move to a precomputed materialised
    view; for the current dataset (demo + small live) this is fine.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

from app.core.db import db


router = APIRouter(prefix="/api/public/vehicles", tags=["public-vehicles"])


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

def _iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def _safe_int(v: Any) -> Optional[int]:
    try:
        if v is None or v == "":
            return None
        return int(v)
    except Exception:
        return None


def _redact_vehicle(doc: dict) -> dict:
    """Return a public-safe view of a vehicle document.

    Keep identity + cosmetic fields, drop ownership + PII.
    """
    return {
        "id": doc.get("id"),
        "brand": doc.get("brand") or "",
        "model": doc.get("model") or "",
        "year": doc.get("year"),
        "mileage": doc.get("mileage"),
        "price": doc.get("price"),
        "currency": (doc.get("currency") or "EUR").upper() if doc.get("currency") else "EUR",
        "location": doc.get("location"),
        "fuel": doc.get("fuel"),
        "transmission": doc.get("transmission"),
        "color": doc.get("color"),
        "thumbnail": doc.get("thumbnail"),
        "gallery": doc.get("gallery") or ([doc.get("thumbnail")] if doc.get("thumbnail") else []),
        "vinTail": (doc.get("vin")[-6:] if doc.get("vin") else None),
        "engine": doc.get("engine"),
        "bodyType": doc.get("bodyType"),
        "trim": doc.get("trim"),
        "registeredCountry": doc.get("registeredCountry"),
        "importedFrom": doc.get("importedFrom"),
        "importedOn": _iso(doc.get("importedOn")),
        "ownedSince": _iso(doc.get("ownedSince")),
    }


def _verdict_label(v: Optional[str]) -> str:
    if v == "rejected" or v == "reject":
        return "REJECT"
    if v == "risk":
        return "RISK"
    if v == "pass" or v == "recommended":
        return "PASS"
    return "UNKNOWN"


def _verdict_tone(v: Optional[str]) -> str:
    if v in ("rejected", "reject"):
        return "danger"
    if v == "risk":
        return "warning"
    if v in ("pass", "recommended"):
        return "success"
    return "info"


# ─────────────────────────────────────────────────────────────────────
# Aggregator
# ─────────────────────────────────────────────────────────────────────

@router.get("/{vehicle_id}/memory")
async def vehicle_memory(vehicle_id: str):
    """Public, read-only "vehicle as memory system" projection.

    Returns:
        {
          vehicle: {...},
          verdict: { label, tone, score, summary, lastInspectionAt },
          ownership: { mileageNow, monthsOwned, ownedSinceIso,
                       tuvUntilIso, tuvDaysLeft, insuranceUntilIso,
                       insuranceDaysLeft, totalSpentEur,
                       purchasePriceEur, estimatedValueEur,
                       estimatedDeltaEur },
          timeline: [ { id, atIso, year, kind, severity, title, body,
                        operator?, savingsEur?, reportId?, mileage? } ],
          reports: [ ... full multi-report stack ],
          comparative: { modelKey, totalCases, riskRate, rejectRate,
                         passRate, avgSavingsEur, topFindings[] },
          documents: [ ... ],
          operators: [ ... ],
          valueTrajectory: [ { monthIso, eur } ],
        }
    """
    vehicle_doc = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0, "customerId": 0, "vin": 0, "plate": 0})
    if not vehicle_doc:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    # We re-fetch with PII to compute the redacted view (drop _id only).
    raw_full = await db.vehicles.find_one({"id": vehicle_id}, {"_id": 0})
    vehicle_view = _redact_vehicle(raw_full or {})

    brand = (raw_full or {}).get("brand", "")
    model = (raw_full or {}).get("model", "")

    # ── Inspection reports (multi-report layering) ────────────────────
    reports_cur = db.inspection_reports.find(
        {"vehicleId": vehicle_id},
        {"_id": 0},
    ).sort("submittedAt", -1).limit(50)
    reports_raw = await reports_cur.to_list(50)

    reports: list[dict] = []
    for r in reports_raw:
        operator = None
        op_id = r.get("operatorId") or r.get("inspectorId")
        if op_id:
            op_doc = await db.users.find_one({"id": op_id}, {"_id": 0, "passwordHash": 0})
            if op_doc:
                operator = {
                    "id": op_doc.get("id"),
                    "name": op_doc.get("displayName") or op_doc.get("fullName") or op_doc.get("name") or "Inspector",
                    "rating": op_doc.get("rating") or 4.7,
                    "city": op_doc.get("city"),
                    "avatar": op_doc.get("avatar"),
                    "totalInspections": op_doc.get("totalInspections") or op_doc.get("inspectionsCount"),
                }
        reports.append({
            "id": r.get("id") or r.get("reportId"),
            "submittedAt": _iso(r.get("submittedAt") or r.get("createdAt")),
            "verdict": r.get("verdict") or "recommended",
            "verdictLabel": _verdict_label(r.get("verdict")),
            "verdictTone": _verdict_tone(r.get("verdict")),
            "score": r.get("score"),
            "summary": r.get("summary"),
            "savingsEur": r.get("savingsEur") or r.get("savings"),
            "operator": operator,
            "thumbnail": r.get("thumbnail"),
            "mileageAt": r.get("mileageAt") or r.get("mileage"),
            "findings": (r.get("findings") or [])[:8],
            "city": r.get("city"),
        })

    # ── Activity events (imports, repairs, mileage anomalies, etc.) ──
    activity_raw = (raw_full or {}).get("activity", []) or []
    timeline: list[dict] = []

    for i, ev in enumerate(activity_raw):
        kind = ev.get("type") or "vehicle_event"
        severity = "info"
        if kind in ("inspection_completed", "purchased"):
            severity = "success"
        elif kind in ("mileage_anomaly", "repair_required"):
            severity = "warning"
        elif kind in ("recall", "rejected"):
            severity = "danger"
        timeline.append({
            "id": ev.get("id") or f"act_{i}",
            "atIso": _iso(ev.get("at")),
            "kind": kind,
            "severity": ev.get("severity") or severity,
            "title": ev.get("title") or _humanize_kind(kind),
            "body": ev.get("text") or ev.get("body"),
            "operator": ev.get("operator"),
            "savingsEur": ev.get("savingsEur"),
            "mileage": ev.get("mileage"),
            "costEur": ev.get("costEur"),
        })

    # Add inspection reports to the timeline.
    for r in reports:
        timeline.append({
            "id": f"report_{r['id']}",
            "atIso": r["submittedAt"],
            "kind": "inspection",
            "severity": r["verdictTone"],
            "title": f"{r['verdictLabel']} · осмотр",
            "body": r.get("summary") or "Pre-purchase inspection",
            "operator": r.get("operator"),
            "savingsEur": r.get("savingsEur"),
            "mileage": r.get("mileageAt"),
            "reportId": r["id"],
        })

    # Add payments to the timeline (purchase events).
    payments_cur = db.payment_transactions.find(
        {"vehicleId": vehicle_id, "status": {"$in": ["paid", "completed"]}},
        {"_id": 0},
    ).sort("paidAt", -1).limit(20)
    payments_raw = await payments_cur.to_list(20)
    for p in payments_raw:
        timeline.append({
            "id": f"payment_{p.get('id', '')}",
            "atIso": _iso(p.get("paidAt") or p.get("createdAt")),
            "kind": "payment",
            "severity": "success",
            "title": p.get("title") or "Оплата",
            "body": p.get("description") or "Платёжная транзакция",
            "amountEur": p.get("amount"),
            "currency": (p.get("currency") or "EUR").upper(),
        })

    # Sort timeline newest-first.
    timeline.sort(key=lambda x: x.get("atIso") or "", reverse=True)

    # ── Ownership console ─────────────────────────────────────────────
    now = datetime.now(timezone.utc)

    def _to_aware(dt):
        if dt is None:
            return None
        if isinstance(dt, str):
            try:
                return datetime.fromisoformat(dt.replace("Z", "+00:00"))
            except Exception:
                return None
        if hasattr(dt, "tzinfo"):
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        return None

    owned_since = _to_aware((raw_full or {}).get("ownedSince"))
    months_owned = 0
    if owned_since:
        delta = now - owned_since
        months_owned = int(delta.days / 30)

    docs_raw = (raw_full or {}).get("documents", []) or []
    tuv = next((d for d in docs_raw if d.get("kind") == "tuv"), None)
    insurance = next((d for d in docs_raw if d.get("kind") == "insurance"), None)
    registration = next((d for d in docs_raw if d.get("kind") == "registration"), None)

    def _days_until(d):
        if not d or not d.get("expiresAt"):
            return None
        ex = _to_aware(d["expiresAt"])
        if not ex:
            return None
        return int((ex - now).days)

    purchase_price = (raw_full or {}).get("purchasePriceEur") or (raw_full or {}).get("price")
    estimated_value = (raw_full or {}).get("estimatedValueEur")
    if estimated_value is None and purchase_price and months_owned > 0:
        # Naive depreciation: ~12% / year on top of purchase. Realistic
        # for 5–10 yo German cars; for the demo it sells the "value
        # trajectory" idea without needing a real pricing source.
        depreciation = min(0.55, 0.12 * (months_owned / 12))
        estimated_value = round(purchase_price * (1 - depreciation))

    total_spent = (raw_full or {}).get("totalSpentEur")
    if total_spent is None:
        total_spent = sum(
            (ev.get("costEur") or 0) for ev in activity_raw if ev.get("costEur")
        ) + sum((p.get("amount") or 0) for p in payments_raw)

    ownership = {
        "mileageNow": (raw_full or {}).get("mileage"),
        "ownedSinceIso": _iso(owned_since),
        "monthsOwned": months_owned,
        "tuvUntilIso": _iso(tuv.get("expiresAt")) if tuv else None,
        "tuvDaysLeft": _days_until(tuv),
        "insuranceUntilIso": _iso(insurance.get("expiresAt")) if insurance else None,
        "insuranceDaysLeft": _days_until(insurance),
        "registrationUntilIso": _iso(registration.get("expiresAt")) if registration else None,
        "purchasePriceEur": purchase_price,
        "estimatedValueEur": estimated_value,
        "estimatedDeltaEur": (estimated_value - purchase_price) if (estimated_value and purchase_price) else None,
        "totalSpentEur": total_spent,
    }

    # ── Verdict (latest report) ───────────────────────────────────────
    latest = reports[0] if reports else None
    verdict = {
        "label": latest["verdictLabel"] if latest else "UNVERIFIED",
        "tone": latest["verdictTone"] if latest else "info",
        "score": latest.get("score") if latest else None,
        "summary": latest.get("summary") if latest else None,
        "lastInspectionAt": latest["submittedAt"] if latest else None,
        "totalInspections": len(reports),
    }

    # ── Comparative intelligence (model-level) ────────────────────────
    comparative = await _compute_comparative(brand, model)

    # ── Documents archive (all kinds) ─────────────────────────────────
    documents = []
    for d in docs_raw:
        ex = d.get("expiresAt")
        if isinstance(ex, datetime):
            ex_iso = ex.isoformat()
        else:
            ex_iso = ex
        days_left = _days_until(d)
        status = "expired" if (days_left is not None and days_left < 0) else (
            "expiring" if (days_left is not None and days_left <= 30) else "valid"
        )
        documents.append({
            "id": d.get("id"),
            "kind": d.get("kind"),
            "label": d.get("label") or _humanize_kind(d.get("kind") or ""),
            "issuer": d.get("issuer"),
            "issuedAtIso": _iso(d.get("issuedAt")),
            "expiresAtIso": ex_iso,
            "daysLeft": days_left,
            "status": status,
            "documentNumber": d.get("documentNumber"),
        })

    # ── Operator lineage ──────────────────────────────────────────────
    operator_map = {}
    for r in reports:
        op = r.get("operator")
        if op and op.get("id"):
            existing = operator_map.get(op["id"])
            if not existing:
                operator_map[op["id"]] = {
                    **op,
                    "interactions": 1,
                    "lastInteractionAt": r["submittedAt"],
                }
            else:
                existing["interactions"] += 1

    operators = list(operator_map.values())
    operators.sort(key=lambda x: x.get("lastInteractionAt") or "", reverse=True)

    # ── Value trajectory (synthesised from purchase + months_owned) ──
    value_trajectory = []
    if purchase_price and owned_since and hasattr(owned_since, "year"):
        cur = owned_since
        # Quarterly samples — looks like an actual trajectory chart.
        i = 0
        while cur < now:
            depreciation = min(0.55, 0.12 * (i / 4))  # 12% / year, sampled quarterly
            value_trajectory.append({
                "monthIso": cur.isoformat(),
                "eur": round(purchase_price * (1 - depreciation)),
            })
            cur = cur + timedelta(days=92)  # ~quarter
            i += 1
        # Anchor with estimated value as the present sample.
        if estimated_value:
            value_trajectory.append({
                "monthIso": now.isoformat(),
                "eur": estimated_value,
            })

    return {
        "vehicle": vehicle_view,
        "verdict": verdict,
        "ownership": ownership,
        "timeline": timeline,
        "reports": reports,
        "comparative": comparative,
        "documents": documents,
        "operators": operators,
        "valueTrajectory": value_trajectory,
    }


def _humanize_kind(kind: str) -> str:
    table = {
        "imported": "Импорт",
        "import": "Импорт",
        "saved": "Сохранён",
        "purchased": "Покупка",
        "ownership_started": "Оформлено владение",
        "inspection_requested": "Запрос осмотра",
        "inspection_completed": "Осмотр завершён",
        "inspection": "Осмотр",
        "mileage_anomaly": "Аномалия пробега",
        "repair": "Ремонт",
        "repair_required": "Требуется ремонт",
        "service": "Сервис",
        "tuv_passed": "TÜV пройден",
        "tuv_renewal": "Обновление TÜV",
        "insurance_renewed": "Страховка обновлена",
        "documents_updated": "Документы обновлены",
        "tuv": "TÜV",
        "insurance": "Страховка",
        "registration": "Регистрация",
        "service_book": "Сервисная книжка",
        "vehicle_event": "Событие",
        "note_added": "Заметка",
        "status_changed": "Статус изменён",
        "archived": "Архивирован",
        "reopened": "Возвращён в работу",
        "payment": "Оплата",
        "recall": "Отзыв производителя",
        "price_drop": "Цена снизилась",
        "price_increase": "Цена выросла",
        "mileage_update": "Пробег обновился",
        "listing_disappeared": "Объявление исчезло",
        "relisted": "Снова в продаже",
        "viewed": "Карточку открыли",
    }
    return table.get(kind, kind.replace("_", " ").title())


async def _compute_comparative(brand: str, model: str) -> dict:
    if not brand or not model:
        return {
            "modelKey": "—",
            "totalCases": 0,
            "riskRate": 0.0,
            "rejectRate": 0.0,
            "passRate": 0.0,
            "avgSavingsEur": 0,
            "topFindings": [],
        }

    cur = db.inspection_reports.find(
        {"brand": brand, "model": model},
        {"_id": 0, "verdict": 1, "savingsEur": 1, "savings": 1, "findings": 1},
    ).limit(1000)
    docs = await cur.to_list(1000)
    total = len(docs)
    risk = sum(1 for d in docs if d.get("verdict") == "risk")
    reject = sum(1 for d in docs if d.get("verdict") in ("rejected", "reject"))
    passed = sum(1 for d in docs if d.get("verdict") in ("recommended", "pass"))

    savings_values = [d.get("savingsEur") or d.get("savings") or 0 for d in docs]
    savings_values = [s for s in savings_values if s and s > 0]
    avg_savings = round(sum(savings_values) / len(savings_values)) if savings_values else 0

    finding_counts: dict[str, int] = {}
    for d in docs:
        for f in d.get("findings") or []:
            label = f.get("label") if isinstance(f, dict) else str(f)
            if label:
                finding_counts[label] = finding_counts.get(label, 0) + 1
    top = sorted(finding_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    top_findings = [
        {"label": label, "occurrences": count, "percent": round(count / total * 100) if total else 0}
        for label, count in top
    ]

    return {
        "modelKey": f"{brand} · {model}",
        "totalCases": total,
        "riskRate": round(risk / total, 3) if total else 0.0,
        "rejectRate": round(reject / total, 3) if total else 0.0,
        "passRate": round(passed / total, 3) if total else 0.0,
        "avgSavingsEur": avg_savings,
        "topFindings": top_findings,
    }


# ─────────────────────────────────────────────────────────────────────
# Demo seed — one rich vehicle so /vehicle/:id has something to show
# even on a fresh database. Idempotent.
# ─────────────────────────────────────────────────────────────────────

DEMO_VEHICLE_ID = "vehicle_demo_bmw_320d_2018"


async def seed_demo_vehicle() -> None:
    """Seed one richly-populated public vehicle for /vehicle/:id demo.

    Idempotent: replaces any prior demo doc to keep timestamps fresh.
    """
    now = datetime.now(timezone.utc)
    owned_since = now - timedelta(days=int(365 * 2.5))   # ~2.5 yrs
    imported_on = owned_since - timedelta(days=45)

    activity = [
        {
            "id": "evt_imported",
            "type": "imported",
            "at": imported_on,
            "title": "Привезли из Берлина",
            "text": "Mobile.de · BMW Niederlassung Berlin · 106 200 км на момент импорта",
            "mileage": 106_200,
        },
        {
            "id": "evt_purchase",
            "type": "purchased",
            "at": owned_since,
            "title": "Покупка после осмотра",
            "text": "Сторговались с €19 100 → €17 200 после первого отчёта",
            "mileage": 106_400,
            "costEur": 17_200,
        },
        {
            "id": "evt_mileage_anomaly",
            "type": "mileage_anomaly",
            "at": owned_since + timedelta(days=480),
            "title": "Несоответствие в сервисной истории",
            "text": "В прошлом пробеге у предыдущего владельца обнаружено расхождение 4 600 км по записям дилера",
            "mileage": 117_400,
        },
        {
            "id": "evt_suspension",
            "type": "repair",
            "at": owned_since + timedelta(days=600),
            "title": "Замена пыльников + стойки",
            "text": "BMW Service Schwabing · оба передних амортизатора + рулевые наконечники",
            "mileage": 119_800,
            "costEur": 820,
        },
        {
            "id": "evt_tuv_2024",
            "type": "tuv_passed",
            "at": owned_since + timedelta(days=850),
            "title": "TÜV Hauptuntersuchung — пройден",
            "text": "Без замечаний. Действует до 15 авг 2026",
            "mileage": 122_900,
        },
        # Temporal evolution markers — synthetic but plausible. They
        # demonstrate that the listing kept moving while the owner
        # held the car (rivals usually don't track this).
        {
            "id": "evt_price_drop_demo",
            "type": "price_drop",
            "at": now - timedelta(days=11),
            "severity": "success",
            "title": "Аналогичная BMW подешевела на €700",
            "text": "Сравнимый F31 320d у того же дилера: €18 400 → €17 700",
            "savingsEur": 700,
        },
        {
            "id": "evt_mileage_update_demo",
            "type": "mileage_update",
            "at": now - timedelta(days=4),
            "severity": "info",
            "title": "Пробег обновили: +1 500 км",
            "text": "Было 122 900 → стало 124 400 за последний месяц",
            "mileage": 124_400,
        },
    ]

    documents = [
        {
            "id": "doc_tuv",
            "kind": "tuv",
            "label": "TÜV Hauptuntersuchung",
            "issuer": "TÜV SÜD",
            "issuedAt": owned_since + timedelta(days=850),
            "expiresAt": owned_since + timedelta(days=850 + 365 * 2),
            "documentNumber": "HU-2024-09-2233",
        },
        {
            "id": "doc_insurance",
            "kind": "insurance",
            "label": "HUK-Coburg KFZ-Versicherung",
            "issuer": "HUK-Coburg",
            "issuedAt": now - timedelta(days=92),
            "expiresAt": now + timedelta(days=273),
            "documentNumber": "P-2025-008-117",
        },
        {
            "id": "doc_registration",
            "kind": "registration",
            "label": "Fahrzeugschein",
            "issuer": "Kraftfahrt-Bundesamt",
            "issuedAt": owned_since,
            "expiresAt": None,
            "documentNumber": "B-AB-1234",
        },
        {
            "id": "doc_service_book",
            "kind": "service_book",
            "label": "Сервисная книжка",
            "issuer": "BMW Service",
            "issuedAt": owned_since + timedelta(days=850),
            "expiresAt": None,
        },
    ]

    vehicle_doc = {
        "id": DEMO_VEHICLE_ID,
        "customerId": "demo_customer",
        "brand": "BMW",
        "model": "320d Touring",
        "trim": "Sport Line · F31",
        "year": 2018,
        "mileage": 124_400,
        "purchasePriceEur": 17_200,
        "price": 17_200,
        "currency": "EUR",
        "color": "Mineral White",
        "fuel": "Дизель",
        "transmission": "Автомат · ZF 8HP",
        "engine": "2.0 TDI · 190 hp",
        "bodyType": "Универсал",
        "location": "Berlin",
        "registeredCountry": "DE",
        "importedFrom": "Berlin (Mobile.de)",
        "importedOn": imported_on,
        "ownedSince": owned_since,
        "thumbnail": "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=1600&q=80",
        "gallery": [
            "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=1600&q=80",
            "https://images.unsplash.com/photo-1542362567-b07e54358753?w=1600&q=80",
            "https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=1600&q=80",
        ],
        "vin": "WBA8E5G53JNU12345",
        "plate": "B-AB 1234",
        "status": "owned",
        "source": "demo",
        "activity": activity,
        "documents": documents,
        "createdAt": owned_since,
        "updatedAt": now,
    }

    await db.vehicles.replace_one({"id": DEMO_VEHICLE_ID}, vehicle_doc, upsert=True)

    # Demo inspectors.
    inspectors = [
        {
            "id": "user_inspector_misha",
            "email": "demo+misha@auto-search.local",
            "displayName": "Михаил Петров",
            "fullName": "Михаил Петров",
            "city": "Berlin",
            "rating": 4.9,
            "totalInspections": 423,
            "avatar": "https://i.pravatar.cc/120?img=12",
            "role": "inspector",
            "kind": "inspector",
        },
        {
            "id": "user_inspector_anna",
            "email": "demo+anna@auto-search.local",
            "displayName": "Анна Шульц",
            "fullName": "Anna Schulz",
            "city": "Berlin",
            "rating": 4.8,
            "totalInspections": 187,
            "avatar": "https://i.pravatar.cc/120?img=47",
            "role": "inspector",
            "kind": "inspector",
        },
    ]
    for u in inspectors:
        await db.users.update_one({"id": u["id"]}, {"$set": u}, upsert=True)

    # Two reports — RISK (initial), PASS (3 yrs later).
    reports = [
        {
            "id": "report_demo_320d_001",
            "vehicleId": DEMO_VEHICLE_ID,
            "brand": "BMW",
            "model": "320d Touring",
            "operatorId": "user_inspector_misha",
            "submittedAt": owned_since - timedelta(days=2),
            "createdAt": owned_since - timedelta(days=2),
            "verdict": "risk",
            "score": 72,
            "summary": "Машина живая, но турбина идёт в риск через 15–25 тыс. км. Сторговать €1 800–2 100.",
            "savingsEur": 1900,
            "savings": 1900,
            "mileageAt": 106_400,
            "thumbnail": "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=900&q=80",
            "city": "Berlin",
            "findings": [
                {"label": "Турбина — ранний износ", "severity": "warning"},
                {"label": "Пыльники амортизаторов", "severity": "info"},
                {"label": "Подтёк сальника заднего", "severity": "warning"},
                {"label": "Двигатель — норма", "severity": "info"},
                {"label": "Кузов без следов ДТП", "severity": "success"},
            ],
        },
        {
            "id": "report_demo_320d_002",
            "vehicleId": DEMO_VEHICLE_ID,
            "brand": "BMW",
            "model": "320d Touring",
            "operatorId": "user_inspector_anna",
            "submittedAt": now - timedelta(days=24),
            "createdAt": now - timedelta(days=24),
            "verdict": "recommended",
            "score": 88,
            "summary": "Через 2.5 года эксплуатации — состояние выше среднего. Турбина в норме, выполнен сервис подвески.",
            "savingsEur": 0,
            "savings": 0,
            "mileageAt": 124_100,
            "thumbnail": "https://images.unsplash.com/photo-1542362567-b07e54358753?w=900&q=80",
            "city": "Berlin",
            "findings": [
                {"label": "Турбина — норма", "severity": "success"},
                {"label": "Подвеска заменена", "severity": "success"},
                {"label": "Тормоза — 60% ресурс", "severity": "info"},
                {"label": "Электрика без замечаний", "severity": "success"},
            ],
        },
    ]
    for r in reports:
        await db.inspection_reports.replace_one({"id": r["id"]}, r, upsert=True)

    # Comparative cohort — synthesise 8 sibling cases for the same model
    # (different vehicleId values, only used by aggregate counters).
    siblings = [
        ("risk", 1900, [{"label": "Турбина"}, {"label": "Подвеска"}]),
        ("risk", 1450, [{"label": "DSG hesitation"}, {"label": "Подвеска"}]),
        ("recommended", 0, [{"label": "Подвеска"}]),
        ("rejected", 4200, [{"label": "Двигатель — стук"}, {"label": "Кузов — следы ДТП"}]),
        ("risk", 2100, [{"label": "Турбина"}, {"label": "EGR"}]),
        ("recommended", 0, [{"label": "Тормоза"}]),
        ("risk", 1700, [{"label": "Подтёк сальника"}, {"label": "Турбина"}]),
        ("recommended", 0, [{"label": "Электрика"}]),
    ]
    for i, (v, s, findings) in enumerate(siblings):
        sid = f"report_demo_320d_sibling_{i}"
        await db.inspection_reports.replace_one(
            {"id": sid},
            {
                "id": sid,
                "brand": "BMW",
                "model": "320d Touring",
                "vehicleId": f"vehicle_sibling_{i}",
                "submittedAt": now - timedelta(days=20 * i + 5),
                "verdict": v,
                "score": 88 if v == "recommended" else (72 if v == "risk" else 41),
                "savingsEur": s,
                "savings": s,
                "findings": findings,
                "city": "Berlin" if i % 2 == 0 else "München",
            },
            upsert=True,
        )

    # Purchase payment.
    await db.payment_transactions.replace_one(
        {"id": "pmt_demo_320d_purchase"},
        {
            "id": "pmt_demo_320d_purchase",
            "vehicleId": DEMO_VEHICLE_ID,
            "title": "Покупка автомобиля",
            "description": "Перевод продавцу за BMW 320d",
            "status": "paid",
            "amount": 17_200,
            "currency": "EUR",
            "paidAt": owned_since,
            "createdAt": owned_since,
        },
        upsert=True,
    )

    # Service payment (suspension).
    await db.payment_transactions.replace_one(
        {"id": "pmt_demo_320d_suspension"},
        {
            "id": "pmt_demo_320d_suspension",
            "vehicleId": DEMO_VEHICLE_ID,
            "title": "BMW Service Schwabing",
            "description": "Замена пыльников + стоек",
            "status": "paid",
            "amount": 820,
            "currency": "EUR",
            "paidAt": owned_since + timedelta(days=600),
            "createdAt": owned_since + timedelta(days=600),
        },
        upsert=True,
    )
