"""app.core.overrides — Sprint 21 C13.

Zone override primitive, ранее жил в server.py. Используется и admin-API
(app/admin/controls.py), и orchestrator-cycle (app/orchestrator/cycle.py).
Никаких from server import — чистый module.
"""
from __future__ import annotations

from app.core.db import db
from app.core.utils import now_utc


# Mode → (zoneStatus, color, surgeMultiplier)
OVERRIDE_MODE_MAP = {
    "FORCE_BALANCED": ("BALANCED", "#22C55E", 1.0),
    "FORCE_BUSY":     ("BUSY",     "#F59E0B", 1.3),
    "FORCE_SURGE":    ("SURGE",    "#F97316", 1.7),
    "FORCE_CRITICAL": ("CRITICAL", "#EF4444", 2.2),
}


async def get_active_override(zone_id: str):
    """Return active override doc or None (expired overrides are purged lazily)."""
    o = await db.zone_overrides.find_one({"zoneId": zone_id}, {"_id": 0})
    if not o:
        return None
    exp = o.get("expiresAt")
    if exp and exp < now_utc().isoformat():
        await db.zone_overrides.delete_one({"zoneId": zone_id})
        return None
    return o
