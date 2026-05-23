"""app.integrations.seed — initial credentials seed (idempotent).

On first boot, seeds Stripe test keys (provided by the user) so that
the integration is immediately usable. Subsequent boots: NO-OP (idempotent
guard checks if the provider already has a record).
"""
from __future__ import annotations

import logging

from . import credentials_service

logger = logging.getLogger(__name__)


# User-provided Stripe TEST keys (rotateable from admin UI).
_STRIPE_TEST_DEFAULTS = {
    "publishable_key": "pk_test_51TP0ROBXF2ZAbV1VYJ4kSYk60ImPBed3hZ5S4u3Dc7egaiqxmHU6F2Gn4wVD4eEaCPXneGJmtrJhbzbYA2IB90da00dkoOhmyV",
    "secret_key": "sk_test_51TP0ROBXF2ZAbV1VCkyMZRRpfLZ44sEh8A1Y0SSNohBftnduaQmaXgekWgsR7NwszeUy84K701AZoO9igmlO10HH00jpPTVDHl",
    "restricted_key": "rk_test_51TP0ROBXF2ZAbV1V1e0ziiE2khT8XFL2fflgjrHM7vESaABhHyX6Q6VdnwMQ9DNB0d4lguE18sjIKUERZJ9XCmaH00Jbz6gvI9",
    "webhook_secret": "",  # admin MUST set this from Stripe Dashboard before webhooks land
}


async def seed_defaults(*, db) -> None:
    """Idempotently seed default credentials. Logs once at startup."""
    existing = await db["integration_credentials"].find_one({"_id": "stripe"}, {"_id": 1})
    if existing:
        logger.info("integrations.seed: stripe already configured — skipping seed")
        return
    await credentials_service.upsert(
        "stripe",
        _STRIPE_TEST_DEFAULTS,
        mode="test",
        enabled=True,
        actor="seed",
        db=db,
    )
    logger.info("integrations.seed: stripe TEST keys seeded (admin can rotate via /api/admin/integrations)")
