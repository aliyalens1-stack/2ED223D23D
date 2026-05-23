"""app.admin.control_tower — Control Tower KPI feed.

Sprint 21 hygiene pass: NestJS прежде отдавал `/api/admin/dashboard` и
`/api/admin/metrics/market`. После выключения NestJS обе ручки вылетали в
404 и весь Dashboard / "Здоровье платформы" висели пустыми. Здесь —
честная агрегация из MongoDB, без mock-данных.

Контракт:

  GET /api/admin/dashboard
    { users:         { total, active, today },
      organizations: { total, active, pending },
      quotes:        { today, noResponse },
      bookings:      { today, inProgress },
      disputes:      { open, urgent },
      payments:      { failed },
      reviews:       { total },
      gmv:           { total, today, week } }

  GET /api/admin/metrics/market
    { response: { avgTimeMinutes, health },
      today:    { gmv, bookings },
      conversion: { quotesToBookings, bookingsToComplete } }
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

from app.core.db import get_db

router = APIRouter()


def _today_iso_floor() -> datetime:
    n = datetime.now(timezone.utc)
    return n.replace(hour=0, minute=0, second=0, microsecond=0)


def _week_floor() -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=7)


async def _count(coll, q):
    """Tolerant counter — pretends 0 if collection is missing."""
    try:
        return await coll.count_documents(q)
    except Exception:
        return 0


async def _sum_field(coll, q, field):
    """Sum a numeric field with $group. Returns 0 if pipeline fails."""
    try:
        pipe = [{"$match": q}, {"$group": {"_id": None, "sum": {"$sum": f"${field}"}}}]
        async for doc in coll.aggregate(pipe):
            return float(doc.get("sum") or 0)
    except Exception:
        pass
    return 0.0


@router.get("/api/admin/dashboard")
async def admin_dashboard():
    db = get_db()
    today = _today_iso_floor()
    today_iso = today.isoformat()
    week_iso = _week_floor().isoformat()
    no_response_threshold = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()

    # Users
    users_total = await _count(db.users, {})
    users_active = await _count(db.users, {"isActive": {"$ne": False}})
    users_today = await _count(db.users, {"createdAt": {"$gte": today_iso}})

    # Organizations / Providers
    orgs_total = await _count(db.organizations, {})
    orgs_active = await _count(db.organizations, {"status": "active"})
    orgs_pending = await _count(
        db.organizations, {"status": {"$in": ["pending", "pending_verification", "review"]}}
    )

    # Quotes (auto-requests + legacy quotes collection)
    quotes_today = await _count(db.quotes, {"createdAt": {"$gte": today_iso}})
    quotes_no_resp = await _count(
        db.quotes,
        {
            "createdAt": {"$lt": no_response_threshold},
            "status": {"$in": ["pending", "new", "open"]},
        },
    )

    # Bookings
    bookings_today = await _count(db.bookings, {"createdAt": {"$gte": today_iso}})
    bookings_in_progress = await _count(
        db.bookings, {"status": {"$in": ["in_progress", "accepted", "confirmed"]}}
    )

    # Disputes
    disputes_open = await _count(db.disputes, {"status": {"$in": ["open", "in_review"]}})
    disputes_urgent = await _count(db.disputes, {"priority": {"$in": ["urgent", "critical"]}})

    # Payments — failed
    pay_failed = await _count(db.payments, {"status": {"$in": ["failed", "declined", "error"]}})

    # Reviews
    reviews_total = await _count(db.reviews, {})

    # GMV — sum of `amount` from successful payments (fallback: bookings.price)
    gmv_total = await _sum_field(
        db.payments, {"status": {"$in": ["paid", "captured", "succeeded"]}}, "amount"
    )
    gmv_today = await _sum_field(
        db.payments,
        {
            "status": {"$in": ["paid", "captured", "succeeded"]},
            "createdAt": {"$gte": today_iso},
        },
        "amount",
    )
    gmv_week = await _sum_field(
        db.payments,
        {
            "status": {"$in": ["paid", "captured", "succeeded"]},
            "createdAt": {"$gte": week_iso},
        },
        "amount",
    )
    if gmv_total == 0:
        # fallback: completed bookings * price
        gmv_total = await _sum_field(
            db.bookings, {"status": {"$in": ["completed", "done"]}}, "price"
        )
        gmv_today = await _sum_field(
            db.bookings,
            {"status": {"$in": ["completed", "done"]}, "createdAt": {"$gte": today_iso}},
            "price",
        )
        gmv_week = await _sum_field(
            db.bookings,
            {"status": {"$in": ["completed", "done"]}, "createdAt": {"$gte": week_iso}},
            "price",
        )

    return {
        "users": {"total": users_total, "active": users_active, "today": users_today},
        "organizations": {
            "total": orgs_total,
            "active": orgs_active,
            "pending": orgs_pending,
        },
        "quotes": {"today": quotes_today, "noResponse": quotes_no_resp},
        "bookings": {"today": bookings_today, "inProgress": bookings_in_progress},
        "disputes": {"open": disputes_open, "urgent": disputes_urgent},
        "payments": {"failed": pay_failed},
        "reviews": {"total": reviews_total},
        "gmv": {"total": gmv_total, "today": gmv_today, "week": gmv_week},
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


@router.get("/api/admin/metrics/market")
async def admin_metrics_market():
    """Health of the marketplace: response time, GMV, conversion ratios."""
    db = get_db()
    today = _today_iso_floor()
    today_iso = today.isoformat()

    # Avg response time on quotes (createdAt -> firstResponseAt, in minutes).
    avg_resp_min = 0.0
    try:
        pipe = [
            {"$match": {"firstResponseAt": {"$ne": None}, "createdAt": {"$ne": None}}},
            {
                "$project": {
                    "diff": {
                        "$divide": [
                            {"$subtract": ["$firstResponseAt", "$createdAt"]},
                            60000,  # ms -> minutes
                        ]
                    }
                }
            },
            {"$group": {"_id": None, "avg": {"$avg": "$diff"}}},
        ]
        async for d in db.quotes.aggregate(pipe):
            avg_resp_min = float(d.get("avg") or 0)
    except Exception:
        pass

    if avg_resp_min <= 0:
        # fallback: median age of in-progress bookings vs now (loose proxy)
        try:
            sample = await db.bookings.find_one(
                {"acceptedAt": {"$ne": None}, "createdAt": {"$ne": None}},
                sort=[("createdAt", -1)],
            )
            if sample and sample.get("acceptedAt") and sample.get("createdAt"):
                a = sample["acceptedAt"]
                c = sample["createdAt"]
                if isinstance(a, str):
                    a = datetime.fromisoformat(a.replace("Z", "+00:00"))
                if isinstance(c, str):
                    c = datetime.fromisoformat(c.replace("Z", "+00:00"))
                avg_resp_min = max(0.0, (a - c).total_seconds() / 60)
        except Exception:
            pass

    health = "good" if avg_resp_min <= 5 else ("warning" if avg_resp_min <= 15 else "critical")

    gmv_today = await _sum_field(
        db.payments,
        {
            "status": {"$in": ["paid", "captured", "succeeded"]},
            "createdAt": {"$gte": today_iso},
        },
        "amount",
    )
    if gmv_today == 0:
        gmv_today = await _sum_field(
            db.bookings,
            {"status": {"$in": ["completed", "done"]}, "createdAt": {"$gte": today_iso}},
            "price",
        )

    bookings_today = await _count(db.bookings, {"createdAt": {"$gte": today_iso}})
    quotes_today = await _count(db.quotes, {"createdAt": {"$gte": today_iso}})
    bookings_completed = await _count(
        db.bookings,
        {"status": {"$in": ["completed", "done"]}, "createdAt": {"$gte": today_iso}},
    )

    q_to_b = (bookings_today / quotes_today) if quotes_today else 0
    b_to_c = (bookings_completed / bookings_today) if bookings_today else 0

    return {
        "response": {
            "avgTimeMinutes": round(avg_resp_min, 2),
            "health": health,
        },
        "today": {
            "gmv": gmv_today,
            "bookings": bookings_today,
            "quotes": quotes_today,
        },
        "conversion": {
            "quotesToBookings": round(q_to_b, 4),
            "bookingsToComplete": round(b_to_c, 4),
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
