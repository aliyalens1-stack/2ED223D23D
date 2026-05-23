"""app.core.bootstrap — Sprint 21 C17: lifecycle side-effects.

Всё, что делал старый `startup_event`, КРОМЕ запуска loops:
  - start_nestjs  — subprocess spawn (NestJS на :3001)
  - seed_data     — тянется из app.core.seed (чистый модуль)
  - geo/ttl/production-readiness indexes
  - shutdown_cleanup — close mongo + kill NestJS subprocess

Раньше эти helpers жили в server.py и тянулись в lifespan через runtime
`from server import` (C15.1 tech debt). В C17 — чистое разделение: lifespan
импортирует отсюда на module-top, нет cycles.
"""
from __future__ import annotations
import asyncio
import logging
import os
import subprocess
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from app.core.config import BACKEND_ROOT, NESTJS_URL, MONGO_URL, DB_NAME, NESTJS_ENABLED
from app.core.db import db
from app.core.geo import resolve_zone
from app.core.seed import seed_data
from app.core.utils import now_utc

# prod_readiness — внешний модуль в /app/backend/prod_readiness.py
from prod_readiness import (
    ensure_idempotency_indexes,
    ensure_alert_indexes,
    ensure_ttl_indexes,
)

logger = logging.getLogger("server")

# NestJS subprocess handle — module-level чтобы shutdown_cleanup имел к нему доступ.
nestjs_process: Optional[subprocess.Popen] = None


async def start_nestjs() -> bool:
    """Поднимает NestJS subprocess на NESTJS_URL. Idempotent — если уже жив,
    возвращает True без re-spawn. Вызывается из bootstrap_side_effects."""
    global nestjs_process
    # Feature flag: если NESTJS_ENABLED=0 — подсервис официально выключен.
    # FastAPI native перекрывает все основные роуты, NestJS опционален.
    if not NESTJS_ENABLED:
        logger.info("NestJS disabled (NESTJS_ENABLED=0) — FastAPI native handles all routes")
        return False
    try:
        # 1. Проверяем, может NestJS уже запущен (например, после reload)
        async with httpx.AsyncClient() as http:
            try:
                r = await http.get(f"{NESTJS_URL}/api/admin/automation/dashboard", timeout=2.0)
                if r.status_code < 500:
                    logger.info("NestJS already running")
                    return True
            except Exception:
                pass

        # 2. Ищем собранный dist
        dist_main = BACKEND_ROOT / 'dist' / 'main.js'
        if not dist_main.exists():
            logger.warning(f"NestJS dist not found at {dist_main} — run `yarn build` to enable")
            return False

        # 3. Spawn
        env = os.environ.copy()
        env['PORT'] = '3001'
        env['MONGO_URL'] = MONGO_URL
        env['DB_NAME'] = DB_NAME
        env['JWT_ACCESS_SECRET'] = os.environ.get(
            'JWT_SECRET', 'auto_service_jwt_secret_key_2025_very_secure'
        )

        nestjs_process = subprocess.Popen(
            ['node', 'dist/main.js'],
            cwd=str(BACKEND_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )

        # 4. Wait up to 60s для готовности
        for i in range(60):
            await asyncio.sleep(1)
            try:
                async with httpx.AsyncClient() as http:
                    r = await http.get(
                        f"{NESTJS_URL}/api/admin/automation/dashboard", timeout=2.0
                    )
                    if r.status_code < 500:
                        logger.info("NestJS started successfully")
                        return True
            except Exception:
                if nestjs_process.poll() is not None:
                    out = nestjs_process.stdout.read().decode() if nestjs_process.stdout else ""
                    logger.error(f"NestJS crashed: {out[:2000]}")
                    return False
        return False
    except Exception as e:
        logger.error(f"Failed to start NestJS: {e}")
        return False


async def bootstrap_side_effects() -> None:
    """Все side-effects инициализации КРОМЕ запуска loops.

    Порядок:
      1) seed_data()                               — admin user, правила, snapshots
      2) asyncio.create_task(start_nestjs())       — non-blocking subprocess spawn
      3) geo indexes                               — 2dsphere для provider_locations
      4) provider_locations seeding                — если коллекция пустая
      5) production-readiness indexes              — idempotency/alerts/TTL
      6) quick_request TTL + uniqueness indexes    — Sprint 16
    """
    await seed_data()

    # NestJS spawn только если feature flag включен. Иначе start_nestjs()
    # возвращает False сразу и не логирует ничего шумного.
    if NESTJS_ENABLED:
        asyncio.create_task(start_nestjs())

    # ── Geo indexes (Phase B) ──
    await db.provider_locations.create_index([("location", "2dsphere")])
    await db.provider_locations.create_index("providerId", unique=True)
    await db.booking_demand_events.create_index([("zoneId", 1), ("timestamp", -1)])
    await db.zone_snapshots.create_index([("zoneId", 1), ("timestamp", -1)])

    # ── Seed provider_locations из organizations ──
    if await db.provider_locations.count_documents({}) == 0:
        orgs = await db.organizations.find(
            {"status": "active"},
            {"_id": 0, "slug": 1, "location": 1, "isOnline": 1},
        ).to_list(50)
        for org in orgs:
            coords = org.get("location", {}).get("coordinates", [30.5234, 50.4501])
            zid = resolve_zone(coords[1], coords[0])
            await db.provider_locations.insert_one({
                "providerId": org["slug"],
                "location": {"type": "Point", "coordinates": coords},
                "zoneId": zid,
                "isOnline": org.get("isOnline", False),
                "heading": 0,
                "speed": 0,
                "updatedAt": now_utc().isoformat(),
            })
        logger.info(f"Seeded {len(orgs)} provider locations")

    # ── Sprint 12: production-readiness indexes + TTLs ──
    await ensure_idempotency_indexes(db)
    await ensure_alert_indexes(db)
    await ensure_ttl_indexes(db)
    logger.info("Sprint 12: production-readiness indexes ensured")

    # ── Sprint 16: quick_request TTL + uniqueness ──
    try:
        await db.quick_requests.create_index("expiresAt", expireAfterSeconds=86400 * 7)
        await db.quick_request_offers.create_index("expiresAt", expireAfterSeconds=86400 * 7)
        await db.quick_requests.create_index("id", unique=True)
        await db.quick_request_offers.create_index([("requestId", 1), ("providerSlug", 1)])
        logger.info("Sprint 16: quick_request TTL + uniqueness indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 16 index creation warning: {e}")


async def shutdown_cleanup() -> None:
    """Закрытие mongo client + kill NestJS subprocess. Вызывается из lifespan.shutdown."""
    try:
        # db.client — обратная ссылка из AsyncIOMotorDatabase на клиент.
        db.client.close()
    except Exception as e:
        logger.warning(f"shutdown_cleanup: mongo close error: {e}")

    if nestjs_process:
        try:
            nestjs_process.terminate()
            try:
                nestjs_process.wait(timeout=5)
            except Exception:
                nestjs_process.kill()
        except Exception as e:
            logger.warning(f"shutdown_cleanup: nestjs kill error: {e}")
