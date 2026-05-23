"""app.customer.service — Sprint 21 C17: rebuild_customer_intelligence.

Вынесено 1-в-1 из server.py. Использует только db + stdlib.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

from app.core.db import db
from app.core.utils import now_utc


logger = logging.getLogger("server")


async def rebuild_customer_intelligence(customer_id: str) -> dict:
    """Rebuild aggregate intelligence for a customer"""
    # Get completed bookings
    bookings = await db.web_bookings.find(
        {"customerId": customer_id, "status": "completed"}, {"_id": 0}
    ).to_list(200)
    if not bookings:
        bookings = await db.bookings.find(
            {"customerId": customer_id, "status": "completed"}, {"_id": 0}
        ).to_list(200)

    # Get favorites
    favs = await db.customer_favorites.find(
        {"customerId": customer_id}, {"_id": 0}
    ).to_list(50)
    fav_ids = [f.get("providerId") for f in favs]

    # Get vehicles
    vehicles = await db.vehicles.find({"userId": customer_id}, {"_id": 0}).to_list(10)

    # Calculate intelligence
    service_freq = {}
    provider_freq = {}
    zone_freq = {}
    hours_freq = {}
    days_freq = {}
    total_spend = 0

    for b in bookings:
        sid = b.get("serviceId", b.get("serviceName", "unknown"))
        service_freq[sid] = service_freq.get(sid, 0) + 1

        pid = b.get("providerId", b.get("organizationSlug", ""))
        if pid:
            provider_freq[pid] = provider_freq.get(pid, 0) + 1

        zid = b.get("zoneId", "")
        if zid:
            zone_freq[zid] = zone_freq.get(zid, 0) + 1

        total_spend += b.get("price", b.get("amount", 0))

    top_services = sorted(service_freq.items(), key=lambda x: -x[1])[:5]
    top_providers = sorted(provider_freq.items(), key=lambda x: -x[1])[:5]
    top_zones = sorted(zone_freq.items(), key=lambda x: -x[1])[:3]

    n = max(len(bookings), 1)
    repeat_providers = sum(1 for c in provider_freq.values() if c > 1)
    repeat_rate = round(repeat_providers / max(len(provider_freq), 1) * 100, 1)

    last_booking = bookings[0] if bookings else None
    last_at = (
        last_booking.get("completedAt", last_booking.get("createdAt"))
        if last_booking
        else None
    )

    profile = {
        "customerId": customer_id,
        "preferredServiceIds": [s[0] for s in top_services],
        "preferredServices": [{"id": s[0], "count": s[1]} for s in top_services],
        "preferredProviderIds": [p[0] for p in top_providers] + fav_ids,
        "preferredZones": [z[0] for z in top_zones],
        "avgBookingValue": round(total_spend / n, 2) if n else 0,
        "totalSpend": round(total_spend, 2),
        "bookingsCount": len(bookings),
        "vehiclesCount": len(vehicles),
        "repeatRate": repeat_rate,
        "lastBookingAt": last_at,
        "loyaltyTier": (
            "gold" if len(bookings) >= 10
            else "silver" if len(bookings) >= 5
            else "bronze"
        ),
        "updatedAt": now_utc().isoformat(),
    }

    await db.customer_intelligence.update_one(
        {"customerId": customer_id},
        {"$set": profile},
        upsert=True,
    )
    return profile
