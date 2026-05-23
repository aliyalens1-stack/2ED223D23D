"""app.orchestrator.cycle — Phase B (zone state) + Phase E/G engine cycles.

Sprint 21 C11: вынесено из server.py 1-в-1. Cycles асинхронные, вызываются
из loop-ов, которые запускаются в server.py startup_with_feedback через
asyncio.create_task. Логика не меняется.
"""
from __future__ import annotations
import asyncio
import logging
import random
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from prod_readiness import dispatch_alert

from app.core.constants import (
    PRE_ENGAGEMENT_BOOST,
    PRE_ENGAGEMENT_TTL_MIN,
)
from app.core.context import ctx
from app.core.db import db, get_db
from app.core.dedupe_bucket import try_claim_bucket
from app.core.geo import haversine, resolve_zone
from app.core.realtime import emit_realtime_event
from app.core.utils import now_utc, uid
from app.orchestrator.feedback import (
    acquire_zone_lock,
    capture_zone_snapshot,
    get_strategy_weight,
    release_zone_lock,
    track_action_feedback,
)
from app.orchestrator.pre_engagement import (
    PRE_ENGAGEMENT_PRESSURE_THRESHOLD,
    trigger_pre_engagement,
)
# Phase 1B — write-side cluster enrichment (pure sync, no DB access).
from app.core.cluster_writer import enrich_with_cluster


# ── Sprint 21 C13: прямые импорты, никаких мостов ──
# C11-bridge (_bridge_from_server / _SERVER_BRIDGE / None-placeholders) УДАЛЁН.
# Все имена теперь берутся напрямую из домен-модулей.
from app.core.overrides import OVERRIDE_MODE_MAP, get_active_override  # noqa: F401
from app.orchestrator.cooldown import is_in_cooldown, set_cooldown  # noqa: F401
from app.orchestrator.actions import build_actions, execute_action  # noqa: F401
from app.ml.predictor import DemandPredictor, predict_demand, _predict_demand_ewma, is_valid_prediction  # noqa: F401


logger = logging.getLogger("server")

# ── Sprint 21 C11: Orchestrator state — mutable module-level globals ──
# Читают: app.orchestrator.cycle (пишут), app.orchestrator.router,
# server.analytics_system_health. Для записи извне использовать
# `import app.orchestrator.cycle as _cycle; _cycle.orchestrator_enabled = ...`
# (стандарт Python: `global` работает только внутри своего модуля).
orchestrator_enabled: bool = True
orchestrator_cycle_count: int = 0
orchestrator_last_cycle_at: Optional[str] = None
orchestrator_last_actions_count: int = 0


# ── Sprint 21 C11: orchestrator default rules ──
ORCHESTRATOR_DEFAULT_RULES = [
    {
        "severity": "BALANCED",
        "enableSurge": False,
        "surgeMultiplier": 1.0,
        "enablePushProviders": False,
        "pushRadiusKm": 0,
        "enableFanoutOverride": False,
        "fanout": 2,
        "enablePriorityBias": False,
        "priorityBiasLevel": 0,
        "enableZoneBoost": False,
        "zoneBoostScore": 0,
        "cooldownSeconds": 120,
    },
    {
        "severity": "BUSY",
        "enableSurge": True,
        "surgeMultiplier": 1.2,
        "enablePushProviders": False,
        "pushRadiusKm": 0,
        "enableFanoutOverride": True,
        "fanout": 3,
        "enablePriorityBias": False,
        "priorityBiasLevel": 0,
        "enableZoneBoost": False,
        "zoneBoostScore": 0,
        "cooldownSeconds": 90,
    },
    {
        "severity": "SURGE",
        "enableSurge": True,
        "surgeMultiplier": 1.5,
        "enablePushProviders": True,
        "pushRadiusKm": 5,
        "enableFanoutOverride": True,
        "fanout": 4,
        "enablePriorityBias": True,
        "priorityBiasLevel": 1,
        "enableZoneBoost": True,
        "zoneBoostScore": 0.05,
        "cooldownSeconds": 60,
    },
    {
        "severity": "CRITICAL",
        "enableSurge": True,
        "surgeMultiplier": 1.8,
        "enablePushProviders": True,
        "pushRadiusKm": 8,
        "enableFanoutOverride": True,
        "fanout": 6,
        "enablePriorityBias": True,
        "priorityBiasLevel": 2,
        "enableZoneBoost": True,
        "zoneBoostScore": 0.1,
        "cooldownSeconds": 30,
    },
]


async def zone_state_engine():
    """Phase B: Periodic zone state recalculation engine (every 10s)"""
    _last_critical_alert: dict[str, float] = {}  # zoneId → epoch-seconds
    CRITICAL_ALERT_COOLDOWN = 300  # 5 min
    while True:
        try:
            zones = await db.zones.find({}, {"_id": 0, "id": 1, "center": 1, "cluster": 1}).to_list(50)
            for z in zones:
                zid = z["id"]
                # Sprint 9 — zone override check: if active, freeze engine writes for status/surge
                override = await get_active_override(zid)
                # Count active demand (pending/confirmed bookings + quotes)
                demand_bookings = await db.web_bookings.count_documents({"zoneId": zid, "status": {"$in": ["pending", "confirmed", "on_route"]}}) if await db.web_bookings.count_documents({}) > 0 else 0
                demand_events = await db.booking_demand_events.count_documents({"zoneId": zid, "type": "created", "timestamp": {"$gte": (now_utc() - timedelta(minutes=30)).isoformat()}})
                demand = max(1, demand_bookings + demand_events + random.randint(2, 8))
                
                # Count online providers in zone
                supply_org = await db.organizations.count_documents({"status": "active", "isOnline": True})
                supply_loc = await db.provider_locations.count_documents({"zoneId": zid, "isOnline": True})
                supply = max(1, supply_loc if supply_loc > 0 else max(1, supply_org // max(len(zones), 1) + random.randint(0, 3)))
                
                ratio = round(demand / supply, 2)
                
                # Status
                if ratio < 1: status, color = "BALANCED", "#22C55E"
                elif ratio < 2: status, color = "BUSY", "#F59E0B"
                elif ratio < 3: status, color = "SURGE", "#F97316"
                else: status, color = "CRITICAL", "#EF4444"
                
                # Surge pricing — Sprint 20: feed-forward через predicted demand
                # Берём max(current ratio, predicted ratio) — поднимаем цену ДО пика, не во время.
                surge_ratio = ratio
                try:
                    pred_p50 = await DemandPredictor.predict(zid)  # ML P50
                    if pred_p50 is not None and supply > 0:
                        forecast_ratio = pred_p50 / max(supply, 1)
                        # Не даём прогнозу обвалить цену в спокойной зоне:
                        # учитываем его только если он ВЫШЕ текущего ratio.
                        surge_ratio = max(ratio, forecast_ratio)
                except Exception:
                    pass

                if surge_ratio < 1: surge = 1.0
                elif surge_ratio < 2: surge = round(1 + (surge_ratio - 1) * 0.3, 2)
                elif surge_ratio < 3: surge = round(1.3 + (surge_ratio - 2) * 0.4, 2)
                else: surge = min(2.5, round(1.7 + (surge_ratio - 3) * 0.3, 2))
                
                avg_eta = max(3, int(8 + ratio * 3 + random.uniform(-2, 2)))
                match_rate = max(30, int(90 - ratio * 12 + random.uniform(-5, 5)))
                
                update = {
                    "demandScore": demand, "supplyScore": supply, "ratio": ratio,
                    "surgeMultiplier": surge, "avgEta": avg_eta, "matchRate": match_rate,
                    "status": status, "color": color, "updatedAt": now_utc().isoformat(),
                }
                # Sprint 9 — if override active, force mode/surge/color (preserve real demand/supply/eta)
                if override:
                    o_status, o_color, o_surge = OVERRIDE_MODE_MAP.get(override["mode"], (status, color, surge))
                    update["status"] = o_status
                    update["color"] = o_color
                    update["surgeMultiplier"] = o_surge
                    update["overriddenUntil"] = override.get("expiresAt")
                    update["overrideMode"] = override.get("mode")
                await db.zones.update_one({"id": zid}, {"$set": update})
                
                # Save snapshot every cycle
                snap = {
                    "zoneId": zid, "timestamp": now_utc().isoformat(),
                    "demand": demand, "supply": supply, "ratio": ratio,
                    "surge": surge, "avgEta": avg_eta,
                }
                # Phase 1B — cluster auto-tag from zone in scope (pure, no DB).
                enrich_with_cluster(snap, cluster=z.get("cluster"),
                                    strategy="zone_lookup", source_field="zoneId")
                await db.zone_snapshots.insert_one(snap)
                
                # Emit realtime event
                await emit_realtime_event("zone:updated", {"zoneId": zid, "status": status, "surge": surge, "ratio": ratio, "demand": demand, "supply": supply})

                # Sprint 12: alert on CRITICAL zone (cooldown-throttled)
                final_status = update["status"]
                if final_status == "CRITICAL":
                    last = _last_critical_alert.get(zid, 0)
                    if (time.time() - last) > CRITICAL_ALERT_COOLDOWN:
                        _last_critical_alert[zid] = time.time()
                        asyncio.create_task(dispatch_alert(
                            db, level="critical", code="ZONE_CRITICAL",
                            message=f"Zone {zid} entered CRITICAL state (ratio {ratio})",
                            zone_id=zid,
                            meta={"ratio": ratio, "demand": demand, "supply": supply,
                                  "surge": update["surgeMultiplier"], "avgEta": avg_eta},
                        ))
            
            # Cleanup old snapshots (keep last 48h)
            cutoff = (now_utc() - timedelta(hours=48)).isoformat()
            await db.zone_snapshots.delete_many({"timestamp": {"$lt": cutoff}})
            
        except Exception as e:
            logger.error(f"Zone engine error: {e}")
        
        await asyncio.sleep(10)


async def seed_orchestrator_rules():
    """Seed default orchestrator rules if none exist"""
    for rule in ORCHESTRATOR_DEFAULT_RULES:
        existing = await db.orchestrator_rules.find_one({"severity": rule["severity"]})
        if not existing:
            await db.orchestrator_rules.insert_one({**rule, "createdAt": now_utc().isoformat(), "updatedAt": now_utc().isoformat()})
    logger.info("Orchestrator rules seeded")


async def orchestrator_run_cycle():
    """Single orchestrator cycle: analyze all zones, decide, execute, log"""
    global orchestrator_cycle_count, orchestrator_last_cycle_at, orchestrator_last_actions_count

    if not orchestrator_enabled:
        return

    # 1. Get live zone states from DB
    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    if not zones:
        return

    # 2. Get rules
    rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)
    if not rules:
        await seed_orchestrator_rules()
        rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)

    rules_map = {r["severity"]: r for r in rules}

    # 3. Get active overrides
    overrides = await db.orchestrator_overrides.find(
        {"isActive": True},
        {"_id": 0}
    ).to_list(50)
    # Filter expired overrides
    active_overrides = []
    for ov in overrides:
        expires = ov.get("expiresAt")
        if expires and expires < now_utc().isoformat():
            await db.orchestrator_overrides.update_one({"id": ov["id"]}, {"$set": {"isActive": False}})
            continue
        active_overrides.append(ov)
    overrides_map = {ov["zoneId"]: ov for ov in active_overrides}

    total_actions = 0

    for zone in zones:
        zone_id = zone.get("id")
        severity = zone.get("status", "BALANCED")  # BALANCED, BUSY, SURGE, CRITICAL

        # ─── Sprint 18: Pre-Engagement check ─────────────────────────────
        # Запускаем ДО severity-based actions: даже если зона ещё BALANCED, но
        # тренд показывает рост — поднимем мастеров заранее.
        #
        # Sprint 21 C14: guard — predict_demand теперь никогда не возвращает
        # NaN/None/Inf (встроенный двухслойный fallback), но мы проверяем
        # ещё раз на границе домена + supply>0. При проблеме — warning,
        # pre-engagement не триггерится, цикл не падает.
        try:
            predicted = await predict_demand(zone_id)
            supply = int(zone.get("supplyScore", 0) or 0)
            if not is_valid_prediction(predicted):
                logger.warning(
                    f"Pre-engagement skipped for zone={zone_id}: invalid predicted={predicted!r}"
                )
            elif supply <= 0:
                # supply=0 → делить нельзя; raising трёт цикл. Просто пропускаем.
                pass
            else:
                pressure = predicted / supply
                if pressure > PRE_ENGAGEMENT_PRESSURE_THRESHOLD:
                    await trigger_pre_engagement(zone, pressure, predicted, supply)
        except Exception as e:
            logger.warning(f"Pre-engagement check failed for zone {zone_id}: {e}")
        # ─────────────────────────────────────────────────────────────────

        rule = rules_map.get(severity)
        if not rule:
            continue

        # Check cooldown
        if await is_in_cooldown(zone_id, severity, rule.get("cooldownSeconds", 60)):
            continue

        # ── Redis-Truthfulness pass (2026-05-12): Mongo-side insert dedupe ──
        # When Redis is unreachable, `is_in_cooldown` returns False every cycle
        # and the same zone+severity logs/dispatches every 10s. Bucket claim
        # holds the line via `dedupe_buckets` unique index — same window as
        # the rule cooldown, single-fire per zone+severity.
        if not await try_claim_bucket(
            scope="orchestrator_log",
            key=f"{zone_id}:{severity}",
            window_seconds=rule.get("cooldownSeconds", 60),
        ):
            continue

        zone_override = overrides_map.get(zone_id)

        # Build actions
        actions = build_actions(zone, rule, zone_override)
        if not actions:
            continue

        # Execute actions
        for action in actions:
            await execute_action(action)

        # Log
        log_entry = {
            "id": uid(),
            "zoneId": zone_id,
            "zoneName": zone.get("name", zone_id),
            "severity": severity,
            "detectedState": {
                "demand": zone.get("demandScore", 0),
                "supply": zone.get("supplyScore", 0),
                "ratio": zone.get("ratio", 0),
                "avgEta": zone.get("avgEta", 0),
                "surgeMultiplier": zone.get("surgeMultiplier", 1.0),
            },
            "actions": actions,
            "source": "admin_override" if zone_override else "system",
            "cycleNumber": orchestrator_cycle_count,
            "createdAt": now_utc().isoformat(),
        }
        # Phase 1B — cluster auto-tag (pure, zone in scope).
        enrich_with_cluster(log_entry, cluster=zone.get("cluster"),
                            strategy="zone_lookup", source_field="zoneId")
        await db.orchestrator_logs.insert_one(log_entry)
        total_actions += len(actions)

        # Set cooldown
        await set_cooldown(zone_id, severity, ttl_seconds=rule.get("cooldownSeconds", 60))

        # Emit realtime event
        await emit_realtime_event("orchestrator:zone_action", {
            "zoneId": zone_id,
            "severity": severity,
            "actionsCount": len(actions),
            "actions": [{"type": a["type"], "status": a["status"]} for a in actions],
        })

    orchestrator_cycle_count += 1
    orchestrator_last_cycle_at = now_utc().isoformat()
    orchestrator_last_actions_count = total_actions

    if total_actions > 0:
        logger.info(f"Orchestrator cycle #{orchestrator_cycle_count}: {total_actions} actions across {len(zones)} zones")


async def orchestrator_engine_loop():
    """Phase E: Orchestrator Engine - runs every 10 seconds"""
    await seed_orchestrator_rules()
    logger.info("Phase E: Orchestrator Engine started (10s cycle)")

    # Create indexes
    await db.orchestrator_logs.create_index([("createdAt", -1)])
    await db.orchestrator_logs.create_index([("zoneId", 1), ("createdAt", -1)])
    await db.orchestrator_overrides.create_index([("zoneId", 1), ("isActive", 1)])

    # Sprint 18: pre_engagement_events TTL — авто-удаление по expiresAt
    try:
        await db.pre_engagement_events.create_index("expiresAt", expireAfterSeconds=0)
        await db.pre_engagement_events.create_index([("zoneId", 1), ("createdAt", -1)])
        logger.info("Sprint 18: pre_engagement_events TTL + zone indexes ensured")
    except Exception as e:
        logger.error(f"Failed to create pre_engagement_events indexes: {e}")

    while True:
        try:
            await orchestrator_run_cycle()
        except Exception as e:
            logger.error(f"Orchestrator engine error: {e}")
        await asyncio.sleep(10)


async def orchestrator_run_cycle_with_feedback():
    """Enhanced orchestrator cycle with feedback tracking"""
    global orchestrator_cycle_count, orchestrator_last_cycle_at, orchestrator_last_actions_count

    if not orchestrator_enabled:
        return

    zones = await db.zones.find({}, {"_id": 0}).to_list(50)
    if not zones:
        return

    rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)
    if not rules:
        await seed_orchestrator_rules()
        rules = await db.orchestrator_rules.find({}, {"_id": 0}).to_list(10)

    rules_map = {r["severity"]: r for r in rules}

    overrides = await db.orchestrator_overrides.find({"isActive": True}, {"_id": 0}).to_list(50)
    active_overrides = []
    for ov in overrides:
        expires = ov.get("expiresAt")
        if expires and expires < now_utc().isoformat():
            await db.orchestrator_overrides.update_one({"id": ov["id"]}, {"$set": {"isActive": False}})
            continue
        active_overrides.append(ov)
    overrides_map = {ov["zoneId"]: ov for ov in active_overrides}

    total_actions = 0

    for zone in zones:
        zone_id = zone.get("id")
        zone_name = zone.get("name", zone_id)
        severity = zone.get("status", "BALANCED")

        # ─── Sprint 18 + 20: Pre-Engagement check (predict_with_interval) ─────
        # Sprint 20: используем P90 (верхняя граница 80%-доверительного интервала)
        # вместо точечного предикта — это убирает ложные срабатывания при шумном
        # прогнозе, и одновременно заставляет систему срабатывать на ВЕРХНИЕ
        # сценарии нагрузки, не на медианные.
        #
        # Sprint 21 C14: добавлены guard-ы на валидность p90/predicted и
        # supply>0; при невалидных значениях pre-engagement не создаётся,
        # цикл продолжает работать, логи идут warning (не error).
        try:
            supply = int(zone.get("supplyScore", 0) or 0)
            if supply <= 0:
                # supply=0 — делить нельзя, пропускаем pre-engagement
                pass
            else:
                interval = await DemandPredictor.predict_with_interval(zone_id)
                if interval is not None and is_valid_prediction(interval.get("p90")):
                    # ML mode: считаем риск перегруза по P90
                    p90 = interval["p90"]
                    pressure = p90 / supply
                    predicted_for_log = interval["p50"]  # для логов берём медиану
                    if pressure > PRE_ENGAGEMENT_PRESSURE_THRESHOLD:
                        await trigger_pre_engagement(zone, pressure, predicted_for_log, supply,
                                                     p10=interval.get("p10"), p90=p90)
                else:
                    # Fallback EWMA — так же, как было, но с валидацией
                    try:
                        predicted = await _predict_demand_ewma(zone_id)
                    except Exception as e:
                        logger.warning(f"Pre-engagement EWMA fallback failed for zone {zone_id}: {e}")
                        predicted = None
                    if is_valid_prediction(predicted):
                        pressure = predicted / supply
                        if pressure > PRE_ENGAGEMENT_PRESSURE_THRESHOLD:
                            await trigger_pre_engagement(zone, pressure, predicted, supply)
                    # else: тихо пропускаем — нет валидного сигнала
        except Exception as e:
            logger.warning(f"Pre-engagement check failed for zone {zone_id}: {e}")
        # ─────────────────────────────────────────────────────────────────

        rule = rules_map.get(severity)
        if not rule:
            continue

        if await is_in_cooldown(zone_id, severity, rule.get("cooldownSeconds", 60)):
            continue

        # ── Redis-Truthfulness pass (2026-05-12): Mongo-side insert dedupe ──
        # See orchestrator_run_cycle for full rationale — same guard, same
        # window. Skips actions/feedback/log/emit when bucket already claimed
        # (i.e. zone+severity already processed within cooldown window).
        if not await try_claim_bucket(
            scope="orchestrator_log",
            key=f"{zone_id}:{severity}",
            window_seconds=rule.get("cooldownSeconds", 60),
        ):
            continue

        # ── FIX 1: Zone Lock — prevent race conditions ──
        if not await acquire_zone_lock(zone_id, "orchestrator", ttl_seconds=15):
            continue  # Zone is locked by another process

        zone_override = overrides_map.get(zone_id)
        actions = build_actions(zone, rule, zone_override)
        if not actions:
            continue

        # ── PHASE G: Strategy weight filtering ──
        # Skip actions with very low weight (< 0.4)
        weighted_actions = []
        for action in actions:
            weight = await get_strategy_weight(zone_id, action["type"])
            action["strategyWeight"] = round(weight, 3)
            if weight >= 0.4:
                weighted_actions.append(action)
            else:
                action["status"] = "skipped"
                action["reason"] = f"Strategy weight too low ({weight:.2f})"
                weighted_actions.append(action)

        # Execute non-skipped actions
        for action in weighted_actions:
            if action["status"] != "skipped":
                await execute_action(action)
                # ── PHASE G: Track feedback for executed actions ──
                if action["status"] == "executed":
                    await track_action_feedback(
                        zone_id, zone_name, action["type"],
                        severity, action.get("payload", {}),
                        cluster=zone.get("cluster"),
                    )

        # Log
        log_entry = {
            "id": uid(),
            "zoneId": zone_id,
            "zoneName": zone_name,
            "severity": severity,
            "detectedState": {
                "demand": zone.get("demandScore", 0),
                "supply": zone.get("supplyScore", 0),
                "ratio": zone.get("ratio", 0),
                "avgEta": zone.get("avgEta", 0),
                "surgeMultiplier": zone.get("surgeMultiplier", 1.0),
            },
            "actions": weighted_actions,
            "source": "admin_override" if zone_override else "system",
            "cycleNumber": orchestrator_cycle_count,
            "createdAt": now_utc().isoformat(),
        }
        # Phase 1B — cluster auto-tag (pure, zone in scope).
        enrich_with_cluster(log_entry, cluster=zone.get("cluster"),
                            strategy="zone_lookup", source_field="zoneId")
        await db.orchestrator_logs.insert_one(log_entry)
        total_actions += len([a for a in weighted_actions if a["status"] == "executed"])

        await set_cooldown(zone_id, severity, ttl_seconds=rule.get("cooldownSeconds", 60))
        await release_zone_lock(zone_id, "orchestrator")  # FIX 1: Release lock
        await emit_realtime_event("orchestrator:zone_action", {
            "zoneId": zone_id, "severity": severity,
            "actionsCount": len(weighted_actions),
            "actions": [{"type": a["type"], "status": a["status"], "weight": a.get("strategyWeight", 1.0)} for a in weighted_actions],
        })

    orchestrator_cycle_count += 1
    orchestrator_last_cycle_at = now_utc().isoformat()
    orchestrator_last_actions_count = total_actions

    if total_actions > 0:
        logger.info(f"Orchestrator cycle #{orchestrator_cycle_count}: {total_actions} actions across {len(zones)} zones")


# Replace the orchestrator engine loop to use enhanced cycle


async def orchestrator_engine_loop_v2():
    """Phase E+G: Enhanced Orchestrator Engine with feedback integration"""
    await seed_orchestrator_rules()
    logger.info("Phase E+G: Enhanced Orchestrator Engine started (10s cycle)")

    await db.orchestrator_logs.create_index([("createdAt", -1)])
    await db.orchestrator_logs.create_index([("zoneId", 1), ("createdAt", -1)])
    await db.orchestrator_overrides.create_index([("zoneId", 1), ("isActive", 1)])

    # Sprint 18: pre_engagement_events — TTL по expiresAt
    try:
        await db.pre_engagement_events.create_index("expiresAt", expireAfterSeconds=0)
        await db.pre_engagement_events.create_index([("zoneId", 1), ("createdAt", -1)])
        await db.pre_engagement_acceptances.create_index([("providerSlug", 1), ("acceptedAt", -1)])
        logger.info("Sprint 18: pre_engagement_events TTL + zone indexes ensured")
    except Exception as e:
        logger.error(f"Failed to create pre_engagement indexes: {e}")

    while True:
        try:
            await orchestrator_run_cycle_with_feedback()
        except Exception as e:
            logger.error(f"Orchestrator engine error: {e}")
        await asyncio.sleep(10)


# ── Update startup to include feedback + strategy optimizer ──
