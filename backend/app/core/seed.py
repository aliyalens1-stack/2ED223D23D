"""app.core.seed — Sprint 21 C17: moved from server.py.

Содержит 3 seed-функции (1-в-1 из server.py, без изменений логики):
  - seed_data() — admin user + automation rules + action_chains + market snapshots
                  + failsafe + users index; делегирует в seed_marketplace_data +
                  seed_demo_data.
  - seed_marketplace_data() — categories, services, organizations, branches,
                              provider_services, reviews.
  - seed_demo_data() — bookings, quotes, vehicles, favorites, notifications,
                       payments, disputes, feature_flags, audit_logs + их индексы.

Зависимости: только app.core.* (db, utils, security) + stdlib. Не ссылается
на server.py — поэтому lifespan теперь импортирует seed_data напрямую отсюда.
"""
from __future__ import annotations
import os
import random
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.core.db import db
from app.core.security import hash_pw, verify_pw
from app.core.utils import now_utc, uid


logger = logging.getLogger("server")


async def _cleanup_test_artifacts():
    """Remove pytest-leftover documents that pollute the customer cabinet UI.

    Triggered at backend startup before any seed runs. Idempotent and
    deliberately narrow — only deletes rows that are *clearly* test fixtures:

      • `car_requests` whose `brand` starts with `TEST_` (any case)
      • `car_requests` with empty brand AND empty model (invalid placeholders
        that some pytest cases create without a seedTag)

    Real user-generated requests always have a non-empty brand/model, so
    they survive this filter. Seeded demos (e.g. `customer-journey-demo`)
    have proper brand/model and explicit `seedTag`, so they survive too.

    Logged only when something was actually removed — silent in clean envs.
    """
    try:
        # Delete `TEST_*` branded requests (pytest artifacts).
        res_test = await db.car_requests.delete_many({
            "brand": {"$regex": "^TEST_", "$options": "i"},
        })
        # Delete invalid placeholder rows (empty brand AND empty model).
        res_blank = await db.car_requests.delete_many({
            "$and": [
                {"$or": [{"brand": ""}, {"brand": None}]},
                {"$or": [{"model": ""}, {"model": None}]},
            ],
        })
        total = res_test.deleted_count + res_blank.deleted_count
        if total:
            logger.info(
                f"[seed cleanup] removed {total} test artifacts from car_requests "
                f"(TEST_*={res_test.deleted_count}, blank brand+model={res_blank.deleted_count})"
            )
    except Exception as exc:
        # Never let cleanup break startup.
        logger.warning(f"[seed cleanup] skipped: {exc}")


async def seed_data():
    # ═══ Startup cleanup (runs BEFORE any seed inserts) ═══
    # Removes pytest-leftover rows so customer cabinet UI doesn't show
    # `TEST_Brand TEST_Model` / empty cards. Safe — see docstring above.
    await _cleanup_test_artifacts()

    admin_email = os.environ.get("ADMIN_EMAIL", "admin@autoservice.com")
    admin_password = os.environ.get("ADMIN_PASSWORD", "Admin123!")

    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({"email": admin_email, "passwordHash": hash_pw(admin_password), "firstName": "Admin", "lastName": "", "role": "admin", "isActive": True, "createdAt": now_utc().isoformat()})
        logger.info(f"Admin user created: {admin_email}")
    elif not existing.get("passwordHash"):
        await db.users.update_one({"email": admin_email}, {"$set": {"passwordHash": hash_pw(admin_password), "isActive": True}})
        await db.users.update_one({"email": admin_email}, {"$unset": {"password_hash": "", "name": ""}})
    elif not verify_pw(admin_password, existing.get("passwordHash", "")):
        await db.users.update_one({"email": admin_email}, {"$set": {"passwordHash": hash_pw(admin_password), "isActive": True}})

    # Seed automation data
    if await db.auto_action_rules.count_documents({}) == 0:
        rules = [
            {"id": uid(), "name": "Low Score Provider Limit", "isEnabled": True, "mode": "active", "triggerType": "provider", "conditionJson": {"field": "score", "operator": "<", "value": 40}, "actionType": "limit_visibility", "actionPayload": {"visibilityLevel": 0.3}, "cooldownSeconds": 3600, "priority": 1},
            {"id": uid(), "name": "Zone High Demand Surge", "isEnabled": True, "mode": "active", "triggerType": "zone", "conditionJson": {"field": "ratio", "operator": ">", "value": 3}, "actionType": "set_surge", "actionPayload": {"surgeMultiplier": 1.5}, "cooldownSeconds": 600, "priority": 2},
            {"id": uid(), "name": "Slow Response Push", "isEnabled": True, "mode": "active", "triggerType": "zone", "conditionJson": {"field": "avgResponseSeconds", "operator": ">", "value": 600}, "actionType": "send_push", "actionPayload": {"message": "New requests!", "radius": 5}, "cooldownSeconds": 300, "priority": 3},
            {"id": uid(), "name": "High Rating Boost", "isEnabled": True, "mode": "shadow", "triggerType": "provider", "conditionJson": {"field": "rating", "operator": ">", "value": 4.8}, "actionType": "boost_visibility", "actionPayload": {"boostLevel": 1.5}, "cooldownSeconds": 7200, "priority": 4},
            {"id": uid(), "name": "Critical Supply Alert", "isEnabled": True, "mode": "active", "triggerType": "zone", "conditionJson": {"field": "supplyCount", "operator": "<", "value": 2}, "actionType": "expand_radius", "actionPayload": {"radiusKm": 10}, "cooldownSeconds": 900, "priority": 1},
            {"id": uid(), "name": "Auto Penalty No-Shows", "isEnabled": False, "mode": "shadow", "triggerType": "provider", "conditionJson": {"field": "noShowCount", "operator": ">", "value": 3}, "actionType": "limit_provider", "actionPayload": {"penaltyType": "suspension"}, "cooldownSeconds": 86400, "priority": 5},
        ]
        await db.auto_action_rules.insert_many(rules)
        rule_ids = [r["id"] for r in rules]
        execs = []
        for i in range(30):
            rid = random.choice(rule_ids[:5])
            rule = next(r for r in rules if r["id"] == rid)
            execs.append({"id": uid(), "ruleId": rid, "ruleName": rule["name"], "entityType": rule["triggerType"], "entityId": f"entity-{uid()[:8]}", "triggerSnapshot": rule["conditionJson"], "actionType": rule["actionType"], "actionPayload": rule["actionPayload"], "status": random.choice(["executed"]*4 + ["skipped", "failed"]), "isDryRun": False, "affectedEntities": random.randint(1, 20), "createdAt": (now_utc() - timedelta(hours=random.randint(1, 168))).isoformat()})
        await db.auto_action_executions.insert_many(execs)
        fb = []
        for i in range(25):
            rid = random.choice(rule_ids[:5])
            it = random.choice(["positive"]*3 + ["neutral", "negative"])
            sc = random.uniform(5, 15) if it == "positive" else random.uniform(-5, 5) if it == "neutral" else random.uniform(-15, -3)
            cb, eb, rb = random.uniform(55, 75), random.uniform(10, 25), random.uniform(50000, 100000)
            fb.append({"id": uid(), "ruleId": rid, "executionId": random.choice(execs)["id"], "metricBefore": {"conversion": round(cb, 1), "eta": round(eb, 1), "revenue": round(rb)}, "metricAfter": {"conversion": round(cb + random.uniform(-5, 12), 1), "eta": round(eb + random.uniform(-5, 3), 1), "revenue": round(rb + random.uniform(-10000, 20000))}, "impactType": it, "impactScore": round(sc, 2), "createdAt": (now_utc() - timedelta(hours=random.randint(1, 120))).isoformat()})
        await db.automation_feedback.insert_many(fb)
        logger.info("Seeded automation rules + executions + feedback")

    if await db.action_chains.count_documents({}) == 0:
        chains = [
            {"id": uid(), "name": "Low Supply Critical", "isEnabled": True, "triggerType": "zone_state", "triggerConditionJson": {"state": "critical"}, "steps": [{"order": 1, "actionType": "send_push", "payload": {"message": "Urgent"}, "delaySeconds": 0}, {"order": 2, "actionType": "set_surge", "payload": {"multiplier": 1.7}, "delaySeconds": 30}, {"order": 3, "actionType": "expand_radius", "payload": {"radiusKm": 3}, "delaySeconds": 60}, {"order": 4, "actionType": "enable_bidding", "payload": {}, "delaySeconds": 120}]},
            {"id": uid(), "name": "Market Crash Response", "isEnabled": True, "triggerType": "incident", "triggerConditionJson": {"type": "market_crash"}, "steps": [{"order": 1, "actionType": "disable_surge", "payload": {}, "delaySeconds": 0}, {"order": 2, "actionType": "send_push", "payload": {"message": "Stabilization"}, "delaySeconds": 5}, {"order": 3, "actionType": "expand_radius", "payload": {"radiusKm": 5}, "delaySeconds": 30}, {"order": 4, "actionType": "alert_operators", "payload": {"level": "critical"}, "delaySeconds": 0}]},
            {"id": uid(), "name": "Peak Hour Optimization", "isEnabled": True, "triggerType": "zone_state", "triggerConditionJson": {"state": "busy"}, "steps": [{"order": 1, "actionType": "set_surge", "payload": {"multiplier": 1.3}, "delaySeconds": 0}, {"order": 2, "actionType": "reduce_radius", "payload": {"radiusKm": 8}, "delaySeconds": 15}, {"order": 3, "actionType": "send_push", "payload": {"message": "Peak demand!"}, "delaySeconds": 30}]},
            {"id": uid(), "name": "Provider Onboarding", "isEnabled": False, "triggerType": "provider_state", "triggerConditionJson": {"event": "new_provider"}, "steps": [{"order": 1, "actionType": "assign_zone", "payload": {"strategy": "nearest"}, "delaySeconds": 0}, {"order": 2, "actionType": "boost_visibility", "payload": {"level": 2}, "delaySeconds": 5}, {"order": 3, "actionType": "send_welcome", "payload": {"template": "welcome"}, "delaySeconds": 10}]},
        ]
        await db.action_chains.insert_many(chains)
        ch_execs = []
        for i in range(12):
            ch = random.choice(chains[:3])
            ch_execs.append({"id": uid(), "chainId": ch["id"], "status": random.choice(["completed"]*3 + ["failed", "partial"]), "isDryRun": False, "stepsResults": [{"order": s["order"], "actionType": s["actionType"], "status": random.choice(["completed"]*3 + ["failed"]), "delaySeconds": s["delaySeconds"]} for s in ch["steps"]], "createdAt": (now_utc() - timedelta(hours=random.randint(1, 100))).isoformat()})
        await db.action_chain_executions.insert_many(ch_execs)

    if await db.market_state_snapshots.count_documents({}) == 0:
        snaps = []
        zones_list = [("kyiv-center", "Kyiv Center"), ("kyiv-podil", "Kyiv Podil"), ("kyiv-obolon", "Kyiv Obolon"), ("lviv-center", "Lviv Center"), ("odessa-center", "Odessa Center")]
        for h in range(48):
            ts = (now_utc() - timedelta(hours=h)).isoformat()
            ratio = round(random.uniform(0.5, 4.0), 2)
            st = "surplus" if ratio < 0.8 else "balanced" if ratio < 1.5 else "busy" if ratio < 2.5 else "surge" if ratio < 3.5 else "critical"
            snaps.append({"id": uid(), "scopeType": "global", "scopeId": "all", "demandCount": random.randint(5, 80), "supplyCount": random.randint(3, 50), "ratio": ratio, "avgEtaMinutes": round(random.uniform(5, 30), 1), "avgResponseSeconds": round(random.uniform(60, 600)), "conversionRate": round(random.uniform(40, 85), 1), "state": st, "createdAt": ts})
        for zid, zname in zones_list:
            for h in range(0, 48, 4):
                ts = (now_utc() - timedelta(hours=h)).isoformat()
                ratio = round(random.uniform(0.3, 5.0), 2)
                st = "surplus" if ratio < 0.8 else "balanced" if ratio < 1.5 else "busy" if ratio < 2.5 else "surge" if ratio < 3.5 else "critical"
                snaps.append({"id": uid(), "scopeType": "zone", "scopeId": zid, "zoneName": zname, "demandCount": random.randint(2, 30), "supplyCount": random.randint(1, 20), "ratio": ratio, "avgEtaMinutes": round(random.uniform(5, 40), 1), "avgResponseSeconds": round(random.uniform(60, 900)), "conversionRate": round(random.uniform(30, 90), 1), "state": st, "createdAt": ts})
        await db.market_state_snapshots.insert_many(snaps)

    if await db.automation_config.count_documents({}) == 0:
        await db.automation_config.insert_one({"type": "global", "autoDistribution": True, "autoSurge": True, "autoVisibility": True, "autoNotifications": True, "autoChains": False, "dryRunMode": False, "requireOperatorApprovalForCritical": True, "updatedAt": now_utc().isoformat()})

    if await db.failsafe_rules.count_documents({}) == 0:
        fs = [
            {"id": uid(), "name": "Surge Limit Guard", "metric": "surgeMultiplier", "condition": "> 2.5", "rollbackActionType": "rollback_surge", "rollbackPayload": {"resetTo": 1.0}, "isEnabled": True},
            {"id": uid(), "name": "Conversion Floor", "metric": "conversionRate", "condition": "< 30", "rollbackActionType": "disable_bidding", "rollbackPayload": {}, "isEnabled": True},
            {"id": uid(), "name": "Supply Crisis Alert", "metric": "supplyCount", "condition": "== 0", "rollbackActionType": "enable_manual_mode", "rollbackPayload": {"alertLevel": "critical"}, "isEnabled": True},
            {"id": uid(), "name": "Mass Cancel Detector", "metric": "cancelRate", "condition": "> 20", "rollbackActionType": "pause_automation", "rollbackPayload": {}, "isEnabled": True},
            {"id": uid(), "name": "Revenue Drop Guard", "metric": "revenueDelta", "condition": "< -30", "rollbackActionType": "rollback_last_change", "rollbackPayload": {}, "isEnabled": False},
        ]
        await db.failsafe_rules.insert_many(fs)
        fs_ids = [f["id"] for f in fs]
        incidents = []
        for i in range(8):
            fid = random.choice(fs_ids[:4])
            fr = next(f for f in fs if f["id"] == fid)
            incidents.append({"id": uid(), "ruleId": fid, "ruleName": fr["name"], "detectedAt": (now_utc() - timedelta(hours=random.randint(1, 72))).isoformat(), "affectedEntityType": random.choice(["zone", "provider", "market"]), "affectedEntityId": f"entity-{uid()[:8]}", "metricSnapshot": {"metric": fr["metric"], "value": round(random.uniform(0, 100), 1)}, "actionTaken": fr["rollbackActionType"], "status": random.choice(["open", "open", "resolved"])})
        await db.failsafe_incidents.insert_many(incidents)

    await db.users.create_index("email", unique=True)

    # ═══════ SEED MARKETPLACE DATA ═══════
    await seed_marketplace_data()

    # ═══════ SEED DEMO DATA (Sprint 2) — bookings/quotes/vehicles/favorites/notifications/payments ═══════
    await seed_demo_data()

    logger.info("Seed data complete")
    creds_path = Path("/app/memory/test_credentials.md")
    creds_path.parent.mkdir(parents=True, exist_ok=True)
    creds_path.write_text(f"# Test Credentials\n\n## Admin\n- **Email**: {admin_email}\n- **Password**: {admin_password}\n- **Role**: admin\n\n## Customer\n- **Email**: customer@test.com\n- **Password**: Customer123!\n\n## Provider\n- **Email**: provider@test.com\n- **Password**: Provider123!\n\n## Auth Endpoints\n- POST /api/auth/login\n- GET /api/auth/me\n\n## Admin Panel\n- URL: /api/admin-panel\n")


async def seed_marketplace_data():
    """Seed real marketplace data: categories, services, organizations, users"""
    # Seed test users
    for u in [
        {"email": "customer@test.com", "passwordHash": hash_pw("Customer123!"), "firstName": "Иван", "lastName": "Петров", "role": "customer", "isActive": True, "createdAt": now_utc().isoformat()},
        {"email": "provider@test.com", "passwordHash": hash_pw("Provider123!"), "firstName": "Сергей", "lastName": "Мастеров", "role": "provider_owner", "isActive": True, "createdAt": now_utc().isoformat()},
    ]:
        if not await db.users.find_one({"email": u["email"]}):
            await db.users.insert_one(u)

    # Seed service categories
    if await db.servicecategories.count_documents({}) == 0:
        cats = [
            {"name": "Диагностика", "slug": "diagnostics", "icon": "search", "order": 1, "isActive": True},
            {"name": "Ремонт двигателя", "slug": "engine", "icon": "engine", "order": 2, "isActive": True},
            {"name": "Ходовая часть", "slug": "suspension", "icon": "car", "order": 3, "isActive": True},
            {"name": "Тормозная система", "slug": "brakes", "icon": "shield", "order": 4, "isActive": True},
            {"name": "Электрика", "slug": "electric", "icon": "lightning", "order": 5, "isActive": True},
            {"name": "ТО и масла", "slug": "maintenance", "icon": "wrench", "order": 6, "isActive": True},
            {"name": "Кузовной ремонт", "slug": "body", "icon": "car", "order": 7, "isActive": True},
            {"name": "Эвакуация", "slug": "tow", "icon": "truck", "order": 8, "isActive": True},
        ]
        result = await db.servicecategories.insert_many(cats)
        cat_ids = {c["slug"]: str(rid) for c, rid in zip(cats, result.inserted_ids)}
        logger.info(f"Seeded {len(cats)} service categories")

        # Seed services
        svcs = [
            {"name": "Компьютерная диагностика", "slug": "computer-diagnostics", "categoryId": cat_ids["diagnostics"], "priceFrom": 500, "priceTo": 1500, "durationMinutes": 30, "isActive": True},
            {"name": "Диагностика ходовой", "slug": "suspension-diagnostics", "categoryId": cat_ids["diagnostics"], "priceFrom": 300, "priceTo": 800, "durationMinutes": 45, "isActive": True},
            {"name": "Замена масла", "slug": "oil-change", "categoryId": cat_ids["maintenance"], "priceFrom": 300, "priceTo": 800, "durationMinutes": 30, "isActive": True},
            {"name": "Замена тормозных колодок", "slug": "brake-pads", "categoryId": cat_ids["brakes"], "priceFrom": 400, "priceTo": 1200, "durationMinutes": 60, "isActive": True},
            {"name": "Замена тормозных дисков", "slug": "brake-discs", "categoryId": cat_ids["brakes"], "priceFrom": 800, "priceTo": 2500, "durationMinutes": 90, "isActive": True},
            {"name": "Ремонт стартера", "slug": "starter-repair", "categoryId": cat_ids["electric"], "priceFrom": 500, "priceTo": 2000, "durationMinutes": 120, "isActive": True},
            {"name": "Замена аккумулятора", "slug": "battery-replace", "categoryId": cat_ids["electric"], "priceFrom": 200, "priceTo": 500, "durationMinutes": 15, "isActive": True},
            {"name": "Прикурить авто", "slug": "jump-start", "categoryId": cat_ids["electric"], "priceFrom": 200, "priceTo": 500, "durationMinutes": 15, "isActive": True},
            {"name": "Ремонт подвески", "slug": "suspension-repair", "categoryId": cat_ids["suspension"], "priceFrom": 800, "priceTo": 5000, "durationMinutes": 180, "isActive": True},
            {"name": "Развал-схождение", "slug": "wheel-alignment", "categoryId": cat_ids["suspension"], "priceFrom": 400, "priceTo": 1000, "durationMinutes": 60, "isActive": True},
            {"name": "Эвакуация", "slug": "tow-service", "categoryId": cat_ids["tow"], "priceFrom": 800, "priceTo": 3000, "durationMinutes": 60, "isActive": True},
            {"name": "Полное ТО", "slug": "full-maintenance", "categoryId": cat_ids["maintenance"], "priceFrom": 1500, "priceTo": 5000, "durationMinutes": 240, "isActive": True},
        ]
        svc_result = await db.services.insert_many(svcs)
        svc_ids = [str(sid) for sid in svc_result.inserted_ids]
        logger.info(f"Seeded {len(svcs)} services")
    else:
        svc_ids = [str(s["_id"]) async for s in db.services.find({}, {"_id": 1})]

    # Seed organizations (providers)
    if await db.organizations.count_documents({}) == 0:
        provider_user = await db.users.find_one({"email": "provider@test.com"})
        provider_uid = str(provider_user["_id"]) if provider_user else uid()

        orgs = [
            {"name": "АвтоМастер Про", "slug": "avtomaster-pro", "description": "Профессиональная диагностика и ремонт. Работаем с 2015 года.", "type": "sto",
             "ownerId": provider_uid, "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5234, 50.4501]}, "address": "Киев, ул. Крещатик 22",
             "ratingAvg": 4.9, "reviewsCount": 234, "bookingsCount": 567, "completedBookingsCount": 534,
             "avgResponseTimeMinutes": 8, "visibilityScore": 95, "visibilityState": "boosted",
             "serviceIds": svc_ids[:4] if svc_ids else [], "isOnline": True,
             "badges": ["verified", "top", "fast_response"], "whyReasons": ["Очень близко", "Быстро отвечает", "Есть слот сегодня"],
             "priceFrom": 500, "workHours": "Пн-Сб 09:00-20:00",
             "clusters": ["repair", "inspection"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "Мобильный Сервис 24", "slug": "mobile-service-24", "description": "Выездной ремонт в любое время. Приедем за 15 минут.", "type": "mobile",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5150, 50.4550]}, "address": "Киев, выездной",
             "ratingAvg": 4.8, "reviewsCount": 156, "bookingsCount": 389, "completedBookingsCount": 372,
             "avgResponseTimeMinutes": 5, "visibilityScore": 90, "visibilityState": "normal",
             "serviceIds": svc_ids[2:5] if len(svc_ids) > 4 else [], "isOnline": True,
             "badges": ["verified", "mobile", "urgent"], "whyReasons": ["Ближайший к вам", "Срочный выезд", "Низкая цена"],
             "priceFrom": 300, "workHours": "24/7",
             "clusters": ["repair"], "providerType": "mobile_mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "СТО Формула", "slug": "sto-formula", "description": "Специализация: ходовая и тормоза. Гарантия 12 месяцев.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.4950, 50.4350]}, "address": "Киев, ул. Автозаводская 15",
             "ratingAvg": 4.7, "reviewsCount": 189, "bookingsCount": 412, "completedBookingsCount": 398,
             "avgResponseTimeMinutes": 12, "visibilityScore": 85, "visibilityState": "normal",
             "serviceIds": svc_ids[3:6] if len(svc_ids) > 5 else [], "isOnline": True,
             "badges": ["verified", "warranty"], "whyReasons": ["Высокий рейтинг", "Много отзывов", "Гарантия 12 мес"],
             "priceFrom": 400, "workHours": "Пн-Пт 08:00-19:00",
             "clusters": ["repair"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "ТехноДиагностик", "slug": "techno-diagnostic", "description": "Компьютерная диагностика всех марок. Дилерское оборудование.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5400, 50.4200]}, "address": "Киев, пр. Науки 8",
             "ratingAvg": 4.6, "reviewsCount": 312, "bookingsCount": 678, "completedBookingsCount": 645,
             "avgResponseTimeMinutes": 15, "visibilityScore": 80, "visibilityState": "normal",
             "serviceIds": svc_ids[:3] if svc_ids else [], "isOnline": False,
             "badges": ["verified", "top_diagnostics", "dealer_equipment"], "whyReasons": ["312 отзывов", "Топ по диагностике", "Дилерское оборудование"],
             "priceFrom": 600, "workHours": "Пн-Сб 09:00-18:00",
             "clusters": ["repair", "inspection"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "ЭвакуаторUA", "slug": "evacuator-ua", "description": "Эвакуация авто по Киеву и области. Работаем 24/7.", "type": "mobile",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5500, 50.4600]}, "address": "Киев, выездной",
             "ratingAvg": 4.9, "reviewsCount": 445, "bookingsCount": 890, "completedBookingsCount": 871,
             "avgResponseTimeMinutes": 18, "visibilityScore": 92, "visibilityState": "boosted",
             "serviceIds": svc_ids[10:12] if len(svc_ids) > 10 else [], "isOnline": True,
             "badges": ["verified", "24_7", "top_tow"], "whyReasons": ["445 отзывов", "Работает 24/7", "Топ-1 эвакуатор"],
             "priceFrom": 800, "workHours": "24/7",
             "clusters": ["repair", "delivery"], "providerType": "transporter",
             "createdAt": now_utc().isoformat()},
            {"name": "БрейкСервис", "slug": "brake-service", "description": "Тормозные системы любой сложности. Оригинальные запчасти.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5100, 50.4450]}, "address": "Киев, ул. Механическая 5",
             "ratingAvg": 4.5, "reviewsCount": 98, "bookingsCount": 245, "completedBookingsCount": 231,
             "avgResponseTimeMinutes": 10, "visibilityScore": 75, "visibilityState": "normal",
             "serviceIds": svc_ids[3:5] if len(svc_ids) > 4 else [], "isOnline": True,
             "badges": ["verified", "specialist"], "whyReasons": ["Специалист по тормозам", "Гарантия 1 год"],
             "priceFrom": 800, "workHours": "Пн-Пт 09:00-18:00",
             "clusters": ["repair"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "AutoElectric Pro", "slug": "autoelectric-pro", "description": "Автоэлектрика, стартеры, генераторы, проводка.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": False,
             "location": {"type": "Point", "coordinates": [30.4800, 50.4380]}, "address": "Киев, ул. Электриков 10",
             "ratingAvg": 4.4, "reviewsCount": 67, "bookingsCount": 134, "completedBookingsCount": 128,
             "avgResponseTimeMinutes": 20, "visibilityScore": 70, "visibilityState": "normal",
             "serviceIds": svc_ids[5:8] if len(svc_ids) > 7 else [], "isOnline": True,
             "badges": ["electric_specialist"], "whyReasons": ["Узкая специализация", "Доступные цены"],
             "priceFrom": 350, "workHours": "Пн-Пт 10:00-19:00",
             "clusters": ["repair"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            {"name": "КузовМастер", "slug": "kuzov-master", "description": "Кузовной ремонт, покраска, полировка. Европейское оборудование.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [30.5300, 50.4100]}, "address": "Киев, ул. Промышленная 22",
             "ratingAvg": 4.8, "reviewsCount": 201, "bookingsCount": 356, "completedBookingsCount": 340,
             "avgResponseTimeMinutes": 25, "visibilityScore": 88, "visibilityState": "normal",
             "serviceIds": svc_ids[6:8] if len(svc_ids) > 6 else [], "isOnline": False,
             "badges": ["verified", "premium"], "whyReasons": ["201 отзывов", "Премиум качество", "Европейское оборудование"],
             "priceFrom": 2000, "workHours": "Пн-Пт 08:00-18:00",
             "clusters": ["repair"], "providerType": "mechanic",
             "createdAt": now_utc().isoformat()},
            # Sprint 33 — German market seed (inspection / selection / delivery clusters)
            {"name": "Berlin Auto-Check", "slug": "berlin-auto-check", "description": "Pre-purchase car inspection in Berlin. TÜV-certified inspectors.", "type": "mobile",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [13.405, 52.52]}, "address": "Berlin Mitte, on-site",
             "ratingAvg": 4.9, "reviewsCount": 87, "bookingsCount": 142, "completedBookingsCount": 138,
             "avgResponseTimeMinutes": 7, "visibilityScore": 90, "visibilityState": "boosted",
             "serviceIds": [], "isOnline": True,
             "badges": ["verified", "tuv", "fast_response"], "whyReasons": ["TÜV-certified", "Mobile inspector", "1h on-site"],
             "priceFrom": 120, "workHours": "Mo-Sa 08:00-20:00",
             "clusters": ["inspection"], "providerType": "inspector",
             "createdAt": now_utc().isoformat()},
            {"name": "Car Selection Expert EU", "slug": "car-selection-eu", "description": "Подбор авто под бюджет в Германии. Полный цикл от поиска до покупки.", "type": "sto",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [13.40, 52.50]}, "address": "Berlin, on-site",
             "ratingAvg": 4.8, "reviewsCount": 64, "bookingsCount": 98, "completedBookingsCount": 95,
             "avgResponseTimeMinutes": 30, "visibilityScore": 85, "visibilityState": "normal",
             "serviceIds": [], "isOnline": True,
             "badges": ["verified", "expert", "premium"], "whyReasons": ["10+ лет опыта", "100% mobile.de coverage", "Гарантия чистоты"],
             "priceFrom": 500, "workHours": "Mo-Fr 09:00-18:00",
             "clusters": ["selection", "inspection"], "providerType": "buyer",
             "createdAt": now_utc().isoformat()},
            {"name": "EU Auto Delivery", "slug": "eu-auto-delivery", "description": "Пригон авто из Европы. Trusted carriers.", "type": "mobile",
             "ownerId": uid(), "status": "active", "isVerified": True,
             "location": {"type": "Point", "coordinates": [13.41, 52.51]}, "address": "Berlin → EU-wide",
             "ratingAvg": 4.7, "reviewsCount": 112, "bookingsCount": 178, "completedBookingsCount": 174,
             "avgResponseTimeMinutes": 45, "visibilityScore": 80, "visibilityState": "normal",
             "serviceIds": [], "isOnline": True,
             "badges": ["verified", "logistics", "insured"], "whyReasons": ["Insured shipping", "EU coverage", "Door-to-door"],
             "priceFrom": 300, "workHours": "Mo-Fr 09:00-19:00",
             "clusters": ["delivery"], "providerType": "transporter",
             "createdAt": now_utc().isoformat()},
        ]
        await db.organizations.insert_many(orgs)
        await db.organizations.create_index([("location", "2dsphere")])
        logger.info(f"Seeded {len(orgs)} organizations")

    # ═══ Sprint 33 — idempotent cluster migration ═══
    # Tag any legacy provider doc that pre-dates Sprint 33 with `clusters: ["repair"]`
    # so the cluster filter in `quick_request.resolve` doesn't return zero matches.
    legacy_count = await db.organizations.count_documents({"clusters": {"$exists": False}})
    if legacy_count:
        await db.organizations.update_many(
            {"clusters": {"$exists": False}},
            {"$set": {"clusters": ["repair"], "providerType": "mechanic"}},
        )
        logger.info(f"Sprint 33 migration: tagged {legacy_count} legacy orgs with clusters=['repair']")

    # ═══ Sprint 33 C5 — provider_bids cluster migration ═══
    # Pre-C5 bids (and auction_charges) have no `cluster` field. Tag them as 'repair'
    # so cluster-scoped leaderboards/charge_lead/aggregations work for legacy data.
    legacy_bids = await db.provider_bids.count_documents({"cluster": {"$exists": False}})
    if legacy_bids:
        await db.provider_bids.update_many(
            {"cluster": {"$exists": False}},
            {"$set": {"cluster": "repair"}},
        )
        logger.info(f"Sprint 33 C5 migration: tagged {legacy_bids} legacy provider_bids with cluster='repair'")
    legacy_charges = await db.auction_charges.count_documents({"cluster": {"$exists": False}})
    if legacy_charges:
        await db.auction_charges.update_many(
            {"cluster": {"$exists": False}},
            {"$set": {"cluster": "repair"}},
        )
        logger.info(f"Sprint 33 C5 migration: tagged {legacy_charges} legacy auction_charges with cluster='repair'")

    # ═══ Sprint 33 C6 — Germany zones backfill (idempotent) ═══
    # Seed Berlin/Munich/Hamburg if not present so resolve_zone() never falls back to Kyiv.
    germany_zones = [
        {"id": "berlin-mitte", "name": "Berlin Mitte", "city": "Berlin", "country": "DE", "currency": "EUR",
         "center": {"lat": 52.52, "lng": 13.405},
         "polygon": {"type": "Polygon", "coordinates": [[[13.36, 52.49], [13.45, 52.49], [13.45, 52.55], [13.36, 52.55], [13.36, 52.49]]]},
         "demandScore": 22, "supplyScore": 6, "ratio": 3.67, "surgeMultiplier": 1.6,
         "avgEta": 14, "matchRate": 60, "status": "SURGE", "color": "#F97316"},
        {"id": "berlin-neukolln", "name": "Berlin Neukölln", "city": "Berlin", "country": "DE", "currency": "EUR",
         "center": {"lat": 52.481, "lng": 13.435},
         "polygon": {"type": "Polygon", "coordinates": [[[13.40, 52.46], [13.48, 52.46], [13.48, 52.50], [13.40, 52.50], [13.40, 52.46]]]},
         "demandScore": 14, "supplyScore": 5, "ratio": 2.8, "surgeMultiplier": 1.4,
         "avgEta": 16, "matchRate": 65, "status": "BUSY", "color": "#F59E0B"},
        {"id": "munich-zentrum", "name": "Munich Zentrum", "city": "Munich", "country": "DE", "currency": "EUR",
         "center": {"lat": 48.1351, "lng": 11.582},
         "polygon": {"type": "Polygon", "coordinates": [[[11.53, 48.10], [11.63, 48.10], [11.63, 48.17], [11.53, 48.17], [11.53, 48.10]]]},
         "demandScore": 18, "supplyScore": 7, "ratio": 2.57, "surgeMultiplier": 1.3,
         "avgEta": 12, "matchRate": 70, "status": "BUSY", "color": "#F59E0B"},
        {"id": "hamburg-altona", "name": "Hamburg Altona", "city": "Hamburg", "country": "DE", "currency": "EUR",
         "center": {"lat": 53.5511, "lng": 9.9937},
         "polygon": {"type": "Polygon", "coordinates": [[[9.93, 53.52], [10.06, 53.52], [10.06, 53.59], [9.93, 53.59], [9.93, 53.52]]]},
         "demandScore": 12, "supplyScore": 5, "ratio": 2.4, "surgeMultiplier": 1.2,
         "avgEta": 15, "matchRate": 72, "status": "BALANCED", "color": "#22C55E"},
    ]
    inserted_de = 0
    for gz in germany_zones:
        gz["createdAt"] = now_utc().isoformat()
        gz["updatedAt"] = now_utc().isoformat()
        existing = await db.zones.find_one({"id": gz["id"]})
        if not existing:
            await db.zones.insert_one(gz)
            inserted_de += 1
    if inserted_de:
        logger.info(f"Sprint 33 C6 migration: seeded {inserted_de} Germany zones")

    # ═══ EU-expansion 2026-05-17 — Latvia / Lithuania / Estonia / Belarus / Austria zones ═══
    # Real demand-zone *containers* for capitals + secondary hubs. Demand/supply
    # counters start near-zero (BALANCED state) so analytics has honest data
    # to grow from — these are NOT demo orgs, just zone metadata so
    # resolve_zone(), ranking, and ops-map have somewhere to register events.
    expansion_zones = [
        # ── AT (Austria) — already had legacy data without zones ─────────
        {"id": "vienna-zentrum",       "name": "Wien Zentrum",       "city": "Vienna",  "country": "AT", "currency": "EUR",
         "center": {"lat": 48.2082, "lng": 16.3738},
         "polygon": {"type": "Polygon", "coordinates": [[[16.34, 48.18], [16.42, 48.18], [16.42, 48.24], [16.34, 48.24], [16.34, 48.18]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "salzburg-altstadt",    "name": "Salzburg Altstadt",  "city": "Salzburg","country": "AT", "currency": "EUR",
         "center": {"lat": 47.8095, "lng": 13.0550},
         "polygon": {"type": "Polygon", "coordinates": [[[13.02, 47.78], [13.09, 47.78], [13.09, 47.84], [13.02, 47.84], [13.02, 47.78]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        # ── LV (Latvia) ─────────────────────────────────────────────────
        {"id": "riga-centrs",          "name": "Rīga Centrs",        "city": "Riga",    "country": "LV", "currency": "EUR",
         "center": {"lat": 56.9496, "lng": 24.1052},
         "polygon": {"type": "Polygon", "coordinates": [[[24.08, 56.93], [24.14, 56.93], [24.14, 56.97], [24.08, 56.97], [24.08, 56.93]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "riga-agenskalns",      "name": "Rīga Āgenskalns",    "city": "Riga",    "country": "LV", "currency": "EUR",
         "center": {"lat": 56.9450, "lng": 24.0500},
         "polygon": {"type": "Polygon", "coordinates": [[[24.02, 56.93], [24.08, 56.93], [24.08, 56.96], [24.02, 56.96], [24.02, 56.93]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        # ── LT (Lithuania) ──────────────────────────────────────────────
        {"id": "vilnius-senamiestis",  "name": "Vilnius Senamiestis","city": "Vilnius", "country": "LT", "currency": "EUR",
         "center": {"lat": 54.6872, "lng": 25.2797},
         "polygon": {"type": "Polygon", "coordinates": [[[25.27, 54.67], [25.31, 54.67], [25.31, 54.71], [25.27, 54.71], [25.27, 54.67]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "kaunas-centras",       "name": "Kaunas Centras",     "city": "Kaunas",  "country": "LT", "currency": "EUR",
         "center": {"lat": 54.8985, "lng": 23.9036},
         "polygon": {"type": "Polygon", "coordinates": [[[23.89, 54.88], [23.94, 54.88], [23.94, 54.92], [23.89, 54.92], [23.89, 54.88]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        # ── EE (Estonia) ────────────────────────────────────────────────
        {"id": "tallinn-kesklinn",     "name": "Tallinn Kesklinn",   "city": "Tallinn", "country": "EE", "currency": "EUR",
         "center": {"lat": 59.4370, "lng": 24.7536},
         "polygon": {"type": "Polygon", "coordinates": [[[24.73, 59.42], [24.78, 59.42], [24.78, 59.45], [24.73, 59.45], [24.73, 59.42]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "tartu-kesklinn",       "name": "Tartu Kesklinn",     "city": "Tartu",   "country": "EE", "currency": "EUR",
         "center": {"lat": 58.3776, "lng": 26.7290},
         "polygon": {"type": "Polygon", "coordinates": [[[26.71, 58.37], [26.75, 58.37], [26.75, 58.39], [26.71, 58.39], [26.71, 58.37]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        # ── BY (Belarus) ────────────────────────────────────────────────
        {"id": "minsk-centralny",      "name": "Минск Центральный",  "city": "Minsk",   "country": "BY", "currency": "BYN",
         "center": {"lat": 53.9006, "lng": 27.5590},
         "polygon": {"type": "Polygon", "coordinates": [[[27.53, 53.88], [27.59, 53.88], [27.59, 53.92], [27.53, 53.92], [27.53, 53.88]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "minsk-frunzensky",     "name": "Минск Фрунзенский",  "city": "Minsk",   "country": "BY", "currency": "BYN",
         "center": {"lat": 53.9006, "lng": 27.4900},
         "polygon": {"type": "Polygon", "coordinates": [[[27.45, 53.88], [27.53, 53.88], [27.53, 53.92], [27.45, 53.92], [27.45, 53.88]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
        {"id": "brest-centr",          "name": "Брест Центр",        "city": "Brest",   "country": "BY", "currency": "BYN",
         "center": {"lat": 52.0976, "lng": 23.7341},
         "polygon": {"type": "Polygon", "coordinates": [[[23.71, 52.08], [23.76, 52.08], [23.76, 52.12], [23.71, 52.12], [23.71, 52.08]]]},
         "demandScore": 0, "supplyScore": 0, "ratio": 0.0, "surgeMultiplier": 1.0,
         "avgEta": 0, "matchRate": 0, "status": "BALANCED", "color": "#22C55E"},
    ]
    inserted_exp = 0
    for ez in expansion_zones:
        ez["createdAt"] = now_utc().isoformat()
        ez["updatedAt"] = now_utc().isoformat()
        existing = await db.zones.find_one({"id": ez["id"]})
        if not existing:
            await db.zones.insert_one(ez)
            inserted_exp += 1
    if inserted_exp:
        logger.info(f"EU-expansion 2026-05-17: seeded {inserted_exp} zones (LV/LT/EE/BY/AT)")

    # Tag legacy zones (Kyiv) without country/currency fields
    legacy_zones = await db.zones.count_documents({"country": {"$exists": False}})
    if legacy_zones:
        await db.zones.update_many(
            {"country": {"$exists": False}},
            {"$set": {"country": "UA", "currency": "UAH", "city": "Kyiv"}},
        )
        logger.info(f"Sprint 33 C6 migration: tagged {legacy_zones} legacy zones as UA/UAH")

    # ═══ SEED: Branches (1 per org) — required for quick-request matching ═══
    if await db.branches.count_documents({}) == 0:
        orgs_list = await db.organizations.find({}, {"_id": 1, "name": 1, "location": 1, "address": 1, "workHours": 1}).to_list(50)
        branches = []
        for org in orgs_list:
            loc = org.get("location") or {"type": "Point", "coordinates": [30.5234, 50.4501]}
            branches.append({
                "organizationId": org["_id"],
                "name": org.get("name", "Main branch"),
                "address": org.get("address", ""),
                "location": loc,
                "city": "Kyiv",
                "status": "active",
                "isMobile": False,
                "phone": "+380-44-000-00-00",
                "workHours": org.get("workHours", "09:00-18:00"),
                "createdAt": now_utc().isoformat(),
            })
        if branches:
            await db.branches.insert_many(branches)
            try:
                await db.branches.create_index([("location", "2dsphere")])
            except Exception:
                pass
        logger.info(f"Seeded {len(branches)} branches")

    # ═══ SEED: ProviderServices (price list) — required for quick-request pricing ═══
    if await db.providerservices.count_documents({}) == 0:
        svc_list = await db.services.find({}, {"_id": 1, "slug": 1, "name": 1}).to_list(50)
        branches_list = await db.branches.find({}, {"_id": 1, "organizationId": 1}).to_list(50)
        ps_docs = []
        for branch in branches_list:
            org_services = svc_list[:5]  # top 5 services per branch
            for s in org_services:
                ps_docs.append({
                    "organizationId": branch["organizationId"],
                    "branchId": branch["_id"],
                    "serviceId": s["_id"],
                    "priceFrom": random.randint(300, 1500),
                    "priceMin": random.randint(300, 1500),
                    "description": s.get("name", ""),
                    "durationMinutes": random.choice([30, 45, 60, 90]),
                    "status": "active",
                    "createdAt": now_utc().isoformat(),
                })
        if ps_docs:
            await db.providerservices.insert_many(ps_docs)
        logger.info(f"Seeded {len(ps_docs)} provider services")


    # Seed reviews
    if await db.reviews.count_documents({}) == 0:
        orgs_list = await db.organizations.find({}, {"_id": 1, "slug": 1}).to_list(20)
        reviews = []
        names = ["Анна К.", "Дмитрий С.", "Ольга П.", "Максим В.", "Елена Н.", "Андрей Б.", "Марина Г.", "Виктор Т.", "Наталья Л.", "Игорь М."]
        texts = [
            "Отличный сервис! Всё сделали быстро и качественно.",
            "Очень доволен работой. Приехали вовремя, починили за час.",
            "Рекомендую! Честные цены и профессиональный подход.",
            "Хороший мастер, разобрался с проблемой быстро.",
            "Спасибо за оперативность! Машина работает идеально.",
            "Немного долго ждал, но результат отличный.",
            "Всё на высшем уровне. Буду обращаться ещё.",
        ]
        for org in orgs_list:
            for i in range(random.randint(3, 8)):
                reviews.append({
                    "organizationId": str(org["_id"]), "userId": uid(), "bookingId": uid(),
                    "authorName": random.choice(names), "rating": random.choice([4, 4, 5, 5, 5, 4, 5]),
                    "text": random.choice(texts), "createdAt": (now_utc() - timedelta(days=random.randint(1, 90))).isoformat(),
                })
        if reviews:
            await db.reviews.insert_many(reviews)
        logger.info(f"Seeded {len(reviews)} reviews")

    # ═══ SEED: Provider Availability + Performance + Skills ═══
    if await db.provider_availability.count_documents({}) == 0:
        orgs_list = await db.organizations.find({}, {"_id": 0, "slug": 1, "workHours": 1}).to_list(20)
        avails, perfs, skills_data = [], [], []
        SKILL_CATS = ["engine", "electric", "body", "suspension", "brakes", "diagnostics", "tow", "maintenance"]
        for org in orgs_list:
            slug = org["slug"]
            is_24_7 = "24/7" in org.get("workHours", "")
            schedule = []
            for day in range(7):
                if is_24_7:
                    schedule.append({"day": day, "slots": [{"from": "00:00", "to": "23:59"}]})
                elif day < 5:
                    schedule.append({"day": day, "slots": [{"from": "09:00", "to": "13:00"}, {"from": "14:00", "to": "19:00"}]})
                elif day == 5:
                    schedule.append({"day": day, "slots": [{"from": "10:00", "to": "16:00"}]})
                else:
                    schedule.append({"day": day, "slots": []})
            avails.append({"providerSlug": slug, "weeklySchedule": schedule, "exceptions": [], "isOnline": org.get("isOnline", True), "updatedAt": now_utc().isoformat()})
            
            accept_rate = round(random.uniform(70, 98), 1)
            perfs.append({
                "providerSlug": slug,
                "acceptanceRate": accept_rate,
                "avgResponseTime": random.randint(3, 25),
                "completionRate": round(random.uniform(85, 99), 1),
                "cancelRate": round(random.uniform(1, 10), 1),
                "latenessScore": round(random.uniform(0, 15), 1),
                "qualityScore": round(random.uniform(70, 98), 1),
                "totalJobs": random.randint(50, 900),
                "repeatCustomerRate": round(random.uniform(15, 45), 1),
                "updatedAt": now_utc().isoformat(),
            })
            
            num_skills = random.randint(2, 5)
            chosen = random.sample(SKILL_CATS, min(num_skills, len(SKILL_CATS)))
            for cat in chosen:
                skills_data.append({"providerSlug": slug, "category": cat, "level": random.randint(2, 5), "verified": random.random() > 0.3, "createdAt": now_utc().isoformat()})
        
        await db.provider_availability.insert_many(avails)
        await db.provider_performance.insert_many(perfs)
        await db.provider_skills.insert_many(skills_data)
        logger.info(f"Seeded availability, performance, skills for {len(orgs_list)} providers")

    # ═══ SEED: Zones with polygons ═══
    if await db.zones.count_documents({}) == 0:
        zones = [
            {"id": "kyiv-center", "name": "Центр", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.4501, "lng": 30.5234}, "polygon": {"type": "Polygon", "coordinates": [[[30.49, 50.44], [30.55, 50.44], [30.55, 50.46], [30.49, 50.46], [30.49, 50.44]]]}, "demandScore": 25, "supplyScore": 12, "ratio": 2.1, "surgeMultiplier": 1.3, "avgEta": 8, "matchRate": 78, "status": "BUSY", "color": "#F59E0B"},
            {"id": "kyiv-podil", "name": "Подол", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.4650, "lng": 30.5150}, "polygon": {"type": "Polygon", "coordinates": [[[30.49, 50.46], [30.54, 50.46], [30.54, 50.48], [30.49, 50.48], [30.49, 50.46]]]}, "demandScore": 8, "supplyScore": 6, "ratio": 1.3, "surgeMultiplier": 1.0, "avgEta": 12, "matchRate": 85, "status": "BALANCED", "color": "#22C55E"},
            {"id": "kyiv-obolon", "name": "Оболонь", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.5100, "lng": 30.4900}, "polygon": {"type": "Polygon", "coordinates": [[[30.46, 50.48], [30.52, 50.48], [30.52, 50.53], [30.46, 50.53], [30.46, 50.48]]]}, "demandScore": 15, "supplyScore": 4, "ratio": 3.75, "surgeMultiplier": 1.8, "avgEta": 18, "matchRate": 55, "status": "CRITICAL", "color": "#EF4444"},
            {"id": "kyiv-pechersk", "name": "Печерск", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.4350, "lng": 30.5400}, "polygon": {"type": "Polygon", "coordinates": [[[30.52, 50.42], [30.58, 50.42], [30.58, 50.45], [30.52, 50.45], [30.52, 50.42]]]}, "demandScore": 18, "supplyScore": 8, "ratio": 2.25, "surgeMultiplier": 1.4, "avgEta": 10, "matchRate": 72, "status": "SURGE", "color": "#F97316"},
            {"id": "kyiv-sviatoshyn", "name": "Святошин", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.4580, "lng": 30.3700}, "polygon": {"type": "Polygon", "coordinates": [[[30.34, 50.44], [30.40, 50.44], [30.40, 50.48], [30.34, 50.48], [30.34, 50.44]]]}, "demandScore": 5, "supplyScore": 7, "ratio": 0.71, "surgeMultiplier": 1.0, "avgEta": 6, "matchRate": 92, "status": "BALANCED", "color": "#22C55E"},
            {"id": "kyiv-darnytsia", "name": "Дарница", "city": "Kyiv", "country": "UA", "currency": "UAH", "center": {"lat": 50.4300, "lng": 30.6100}, "polygon": {"type": "Polygon", "coordinates": [[[30.58, 50.41], [30.65, 50.41], [30.65, 50.45], [30.58, 50.45], [30.58, 50.41]]]}, "demandScore": 12, "supplyScore": 3, "ratio": 4.0, "surgeMultiplier": 2.0, "avgEta": 22, "matchRate": 45, "status": "CRITICAL", "color": "#EF4444"},
            # Sprint 33 C6 — Germany zones (Berlin/Munich/Hamburg) for cluster-aware Europe rollout
            {"id": "berlin-mitte", "name": "Berlin Mitte", "city": "Berlin", "country": "DE", "currency": "EUR", "center": {"lat": 52.52, "lng": 13.405}, "polygon": {"type": "Polygon", "coordinates": [[[13.36, 52.49], [13.45, 52.49], [13.45, 52.55], [13.36, 52.55], [13.36, 52.49]]]}, "demandScore": 22, "supplyScore": 6, "ratio": 3.67, "surgeMultiplier": 1.6, "avgEta": 14, "matchRate": 60, "status": "SURGE", "color": "#F97316"},
            {"id": "berlin-neukolln", "name": "Berlin Neukölln", "city": "Berlin", "country": "DE", "currency": "EUR", "center": {"lat": 52.481, "lng": 13.435}, "polygon": {"type": "Polygon", "coordinates": [[[13.40, 52.46], [13.48, 52.46], [13.48, 52.50], [13.40, 52.50], [13.40, 52.46]]]}, "demandScore": 14, "supplyScore": 5, "ratio": 2.8, "surgeMultiplier": 1.4, "avgEta": 16, "matchRate": 65, "status": "BUSY", "color": "#F59E0B"},
            {"id": "munich-zentrum", "name": "Munich Zentrum", "city": "Munich", "country": "DE", "currency": "EUR", "center": {"lat": 48.1351, "lng": 11.582}, "polygon": {"type": "Polygon", "coordinates": [[[11.53, 48.10], [11.63, 48.10], [11.63, 48.17], [11.53, 48.17], [11.53, 48.10]]]}, "demandScore": 18, "supplyScore": 7, "ratio": 2.57, "surgeMultiplier": 1.3, "avgEta": 12, "matchRate": 70, "status": "BUSY", "color": "#F59E0B"},
            {"id": "hamburg-altona", "name": "Hamburg Altona", "city": "Hamburg", "country": "DE", "currency": "EUR", "center": {"lat": 53.5511, "lng": 9.9937}, "polygon": {"type": "Polygon", "coordinates": [[[9.93, 53.52], [10.06, 53.52], [10.06, 53.59], [9.93, 53.59], [9.93, 53.52]]]}, "demandScore": 12, "supplyScore": 5, "ratio": 2.4, "surgeMultiplier": 1.2, "avgEta": 15, "matchRate": 72, "status": "BALANCED", "color": "#22C55E"},
        ]
        for z in zones:
            z["updatedAt"] = now_utc().isoformat()
            z["createdAt"] = now_utc().isoformat()
        await db.zones.insert_many(zones)
        
        # Seed zone snapshots (history)
        snaps = []
        for z in zones:
            for h in range(48):
                ts = (now_utc() - timedelta(hours=h)).isoformat()
                d = max(1, z["demandScore"] + random.randint(-8, 8))
                s = max(1, z["supplyScore"] + random.randint(-3, 3))
                ratio = round(d / s, 2)
                snaps.append({"zoneId": z["id"], "timestamp": ts, "demand": d, "supply": s, "ratio": ratio, "surge": round(max(1, min(2.5, ratio * 0.6)), 2), "avgEta": max(3, int(z["avgEta"] + random.randint(-5, 5)))})
        await db.zone_snapshots.insert_many(snaps)
        logger.info(f"Seeded {len(zones)} zones + {len(snaps)} snapshots")


async def seed_demo_data():
    """Sprint 2: seed empty collections so UI shows populated lists.
    All checks are idempotent (skip if already seeded)."""
    # --- Get seed actors ---
    customer = await db.users.find_one({"email": "customer@test.com"})
    provider = await db.users.find_one({"email": "provider@test.com"})
    if not customer or not provider:
        logger.warning("seed_demo_data: test users not found, skipping")
        return
    customer_id = str(customer["_id"])
    provider_id = str(provider["_id"])

    orgs = await db.organizations.find({}, {"_id": 1, "name": 1, "slug": 1, "priceFrom": 1}).to_list(20)
    svcs = await db.services.find({}, {"_id": 1, "name": 1, "priceFrom": 1, "priceTo": 1, "durationMinutes": 1}).to_list(20)
    if not orgs or not svcs:
        logger.warning("seed_demo_data: no orgs/services, skipping")
        return

    from bson import ObjectId

    # --- Vehicles ---
    if await db.vehicles.count_documents({}) == 0:
        vehs = [
            {"userId": ObjectId(customer_id), "brand": "Toyota", "model": "Camry", "year": 2019, "plate": "AA1234BB", "vin": "1HGBH41JXMN109186", "color": "Белый", "mileageKm": 85000, "status": "active", "createdAt": now_utc().isoformat()},
            {"userId": ObjectId(customer_id), "brand": "BMW",    "model": "X5",    "year": 2021, "plate": "AA5678CC", "vin": "5UXCR6C06L9C01234", "color": "Чёрный", "mileageKm": 42000, "status": "active", "createdAt": now_utc().isoformat()},
            {"userId": ObjectId(customer_id), "brand": "Ford",   "model": "Focus", "year": 2016, "plate": "AB9012DD", "vin": "1FADP3K28JL200567", "color": "Синий",  "mileageKm": 128000, "status": "active", "createdAt": now_utc().isoformat()},
            {"userId": ObjectId(customer_id), "brand": "Mercedes-Benz", "model": "E-Class", "year": 2020, "plate": "AI3344EE", "vin": "WDDZF4JB9LA123456", "color": "Серебристый", "mileageKm": 55000, "status": "active", "createdAt": now_utc().isoformat()},
            {"userId": ObjectId(customer_id), "brand": "Volkswagen", "model": "Passat", "year": 2017, "plate": "AE5566FF", "vin": "1VWBN7A37HC056123", "color": "Серый", "mileageKm": 96000, "status": "active", "createdAt": now_utc().isoformat()},
        ]
        await db.vehicles.insert_many(vehs)
        logger.info(f"demo-seed: {len(vehs)} vehicles")

    # --- Favorites ---
    if await db.favorites.count_documents({}) == 0:
        favs = []
        for o in orgs[:5]:
            favs.append({
                "userId": ObjectId(customer_id),
                "organizationId": o["_id"],
                "createdAt": now_utc().isoformat(),
            })
        await db.favorites.insert_many(favs)
        logger.info(f"demo-seed: {len(favs)} favorites")

    # --- Bookings (20 штук разных статусов) ---
    if await db.bookings.count_documents({}) == 0:
        statuses_dist = (["completed"] * 10 + ["cancelled"] * 2 + ["on_route"] * 2 +
                         ["in_progress"] * 2 + ["confirmed"] * 2 + ["pending"] * 2)
        bookings = []
        for i, st in enumerate(statuses_dist):
            o = random.choice(orgs)
            s = random.choice(svcs)
            price = random.randint(s.get("priceFrom", 300) or 300, s.get("priceTo", 2000) or 2000)
            created = now_utc() - timedelta(days=random.randint(0, 60), hours=random.randint(0, 23))
            scheduled = created + timedelta(hours=random.randint(2, 72))
            doc = {
                "bookingNumber": f"BK-{1000 + i}",
                "userId": ObjectId(customer_id),
                "organizationId": o["_id"],
                "serviceId": s["_id"],
                "serviceName": s.get("name"),
                "orgName": o.get("name"),
                "priceEstimate": price,
                "finalPrice": price if st == "completed" else None,
                "status": st,
                "source": random.choice(["quick", "direct", "quote", "repeat"]),
                "scheduledAt": scheduled.isoformat(),
                "address": f"Киев, ул. Тестовая {random.randint(1,99)}",
                "location": {"type": "Point", "coordinates": [30.5 + random.uniform(-0.1, 0.1), 50.45 + random.uniform(-0.05, 0.05)]},
                "createdAt": created.isoformat(),
                "updatedAt": (created + timedelta(hours=random.randint(1, 48))).isoformat(),
            }
            if st == "completed":
                doc["completedAt"] = (scheduled + timedelta(hours=random.randint(1, 4))).isoformat()
            if st == "cancelled":
                doc["cancelledAt"] = (created + timedelta(hours=random.randint(1, 12))).isoformat()
                doc["cancelReason"] = random.choice(["Клиент отменил", "Мастер недоступен", "Изменились планы"])
            bookings.append(doc)
        await db.bookings.insert_many(bookings)
        logger.info(f"demo-seed: {len(bookings)} bookings")

    # --- Quotes (10) ---
    if await db.quotes.count_documents({}) == 0:
        qs = []
        for i in range(10):
            s = random.choice(svcs)
            st = random.choice(["open", "open", "matched", "accepted", "closed"])
            created = now_utc() - timedelta(days=random.randint(0, 30))
            qs.append({
                "userId": ObjectId(customer_id),
                "serviceId": s["_id"],
                "serviceName": s.get("name"),
                "description": f"Нужна помощь с {s.get('name','сервисом').lower()}. Машина не заводится, вызовите мастера.",
                "status": st,
                "priceBudget": random.randint(500, 5000),
                "vehicleBrand": random.choice(["Toyota", "BMW", "Ford", "VW"]),
                "location": {"type": "Point", "coordinates": [30.5 + random.uniform(-0.1, 0.1), 50.45 + random.uniform(-0.05, 0.05)]},
                "address": f"Киев, ул. Тестовая {random.randint(1,99)}",
                "responsesCount": random.randint(0, 5),
                "createdAt": created.isoformat(),
                "updatedAt": created.isoformat(),
            })
        await db.quotes.insert_many(qs)
        logger.info(f"demo-seed: {len(qs)} quotes")

    # --- Payments (5 mocked) ---
    if await db.payments.count_documents({}) == 0:
        done_bookings = await db.bookings.find({"status": "completed"}).to_list(5)
        pays = []
        for b in done_bookings:
            pays.append({
                "userId": b["userId"],
                "bookingId": b["_id"],
                "organizationId": b.get("organizationId"),
                "amount": b.get("finalPrice") or b.get("priceEstimate") or 1000,
                "currency": "UAH",
                "status": "paid",
                "method": "mock",
                "provider": "stripe-mock",
                "stripePaymentIntentId": f"pi_mock_{uid()[:16]}",
                "paidAt": b.get("completedAt") or now_utc().isoformat(),
                "createdAt": b.get("createdAt") or now_utc().isoformat(),
            })
        if pays:
            await db.payments.insert_many(pays)
            logger.info(f"demo-seed: {len(pays)} payments (mocked)")

    # --- Notifications (10) ---
    if await db.notifications.count_documents({}) == 0:
        templates = [
            ("booking_confirmed",   "Бронь подтверждена",     "Ваш заказ принят мастером"),
            ("booking_en_route",    "Мастер в пути",          "Мастер едет к вам, ETA ~15 минут"),
            ("booking_completed",   "Заказ выполнен",         "Пожалуйста, оцените работу"),
            ("quote_response",      "Новый ответ на запрос",  "СТО ответила на ваш запрос"),
            ("promo",               "Скидка 10%",             "На следующий визит — промокод SAVE10"),
            ("system",              "Обслуживание системы",   "Платформа обновлена до версии 2.1"),
        ]
        notifs = []
        for i in range(10):
            t = random.choice(templates)
            created = now_utc() - timedelta(hours=random.randint(0, 168))
            notifs.append({
                "userId": ObjectId(customer_id),
                "type": t[0],
                "title": t[1],
                "body": t[2],
                "isRead": random.random() > 0.4,
                "createdAt": created.isoformat(),
                "readAt": created.isoformat() if random.random() > 0.4 else None,
            })
        await db.notifications.insert_many(notifs)
        logger.info(f"demo-seed: {len(notifs)} notifications")

    # --- Disputes (3) ---
    if await db.disputes.count_documents({}) == 0:
        some_bookings = await db.bookings.find({"status": "completed"}).to_list(3)
        ds = []
        for b in some_bookings:
            ds.append({
                "bookingId": b["_id"],
                "userId": b["userId"],
                "organizationId": b.get("organizationId"),
                "reason": random.choice(["quality", "price", "delay", "no_show"]),
                "description": "Описание проблемы от клиента.",
                "status": random.choice(["open", "investigating", "resolved"]),
                "createdAt": now_utc().isoformat(),
            })
        if ds:
            await db.disputes.insert_many(ds)
            logger.info(f"demo-seed: {len(ds)} disputes")

    # --- Feature flags (5) ---
    if await db.feature_flags.count_documents({}) == 0:
        flags = [
            {"key": "new_matching_v2",    "enabled": True,  "description": "Новый алгоритм матчинга v2", "rolloutPct": 100},
            {"key": "surge_pricing",      "enabled": True,  "description": "Динамическое surge-ценообразование", "rolloutPct": 100},
            {"key": "provider_boost",     "enabled": True,  "description": "Платный boost видимости мастеров", "rolloutPct": 100},
            {"key": "realtime_tracking",  "enabled": True,  "description": "Live-трекинг мастера на карте", "rolloutPct": 100},
            {"key": "voice_requests",     "enabled": False, "description": "Голосовые заявки (beta)", "rolloutPct": 10},
        ]
        await db.feature_flags.insert_many([{**f, "updatedAt": now_utc().isoformat()} for f in flags])
        logger.info(f"demo-seed: {len(flags)} feature flags")

    # --- Audit logs (recent activity) ---
    if await db.audit_logs.count_documents({}) == 0:
        actors = ["admin@autoservice.com", "system", "orchestrator"]
        actions = ["user.login", "booking.created", "payment.captured", "provider.verified",
                   "zone.surge_changed", "automation.rule_enabled"]
        logs = []
        for _ in range(30):
            logs.append({
                "actor": random.choice(actors),
                "action": random.choice(actions),
                "target": f"entity_{uid()[:8]}",
                "meta": {"ip": f"10.0.{random.randint(0,255)}.{random.randint(0,255)}"},
                "createdAt": (now_utc() - timedelta(hours=random.randint(0, 48))).isoformat(),
            })
        await db.audit_logs.insert_many(logs)
        logger.info(f"demo-seed: {len(logs)} audit_logs")

    # Indexes for new collections
    await db.vehicles.create_index("userId")
    await db.favorites.create_index([("userId", 1), ("organizationId", 1)], unique=True)
    await db.bookings.create_index([("userId", 1), ("createdAt", -1)])
    await db.notifications.create_index([("userId", 1), ("createdAt", -1)])
    await db.password_reset_tokens.create_index("token", unique=True)
    await db.password_reset_tokens.create_index("expiresAt", expireAfterSeconds=86400)

    # Phase 3.1 demo — Provider Workbench + Earnings Clarity sample data.
    # Idempotent: re-running upserts demo-prefixed docs without touching legacy
    # bookings/jobs. Required so mobile/web surfaces can be reviewed end-to-end
    # for `provider@test.com` without depending on real customer traffic.
    try:
        from app.core.seed_provider_demo import seed_provider_workbench_demo
        await seed_provider_workbench_demo(db)
    except Exception as exc:
        logger.warning(f"[demo-3.1] seed_provider_workbench_demo failed: {exc}")
