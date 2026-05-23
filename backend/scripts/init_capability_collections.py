#!/usr/bin/env python3
"""Sprint 1B — initialize new collections + indexes + seed controlled vocabulary.

What this script does:
  1. Creates 4 collections IF they don't exist (no-op if they do):
       accounts, account_capabilities, organizations, specializations
  2. Creates indexes (idempotent — Mongo skips existing).
  3. Seeds `specializations` with the canonical enum (also idempotent — uses
     upsert by stable _id, so re-running just refreshes labels/aliases).

What this script does NOT do:
  - No data migration from `users` / providers* — that's Sprint 1C.
  - No edits to existing collections.

Re-runnable. Safe to call from a deploy hook.

Usage:  python /app/backend/scripts/init_capability_collections.py
"""
from __future__ import annotations
import asyncio
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, "/app/backend")

from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import ASCENDING, DESCENDING


# ─────────────────────────────────────────────────────────────────────────────
# Specializations seed — STABLE IDs only. Labels/aliases can evolve.
# Naming rule: lowercase ASCII, no spaces, underscore-separated. NEVER change
# an _id once shipped. Add new ones or set active=False on retired ones.
# ─────────────────────────────────────────────────────────────────────────────

SPECIALIZATIONS_SEED: list[dict] = [
    # ── BRANDS ──────────────────────────────────────────────────────────────
    {"_id": "bmw", "category": "brand", "sortOrder": 10,
     "labels": {"en": "BMW", "de": "BMW", "ru": "BMW"},
     "aliases": ["bmw", "Bmw", "BMW", "BMW/MINI", "БМВ"],
     "searchTokens": ["bmw", "mini"]},
    {"_id": "mercedes", "category": "brand", "sortOrder": 20,
     "labels": {"en": "Mercedes-Benz", "de": "Mercedes-Benz", "ru": "Мерседес"},
     "aliases": ["mercedes", "mercedes-benz", "Mercedes", "Benz", "MB", "Мерседес-Бенц"],
     "searchTokens": ["mercedes", "benz", "amg"]},
    {"_id": "audi", "category": "brand", "sortOrder": 30,
     "labels": {"en": "Audi", "de": "Audi", "ru": "Ауди"},
     "aliases": ["audi", "Audi", "Ауди"],
     "searchTokens": ["audi", "rs"]},
    {"_id": "vw", "category": "brand", "sortOrder": 40,
     "labels": {"en": "Volkswagen", "de": "Volkswagen", "ru": "Фольксваген"},
     "aliases": ["vw", "VW", "volkswagen", "Volkswagen", "Фольксваген"],
     "searchTokens": ["vw", "volkswagen", "vag"]},
    {"_id": "porsche", "category": "brand", "sortOrder": 50,
     "labels": {"en": "Porsche", "de": "Porsche", "ru": "Порше"},
     "aliases": ["porsche", "Porsche", "Порше"],
     "searchTokens": ["porsche"]},
    {"_id": "opel", "category": "brand", "sortOrder": 60,
     "labels": {"en": "Opel", "de": "Opel", "ru": "Опель"},
     "aliases": ["opel", "Opel", "Опель"], "searchTokens": ["opel"]},
    {"_id": "ford", "category": "brand", "sortOrder": 70,
     "labels": {"en": "Ford", "de": "Ford", "ru": "Форд"},
     "aliases": ["ford", "Ford", "Форд"], "searchTokens": ["ford"]},
    {"_id": "skoda", "category": "brand", "sortOrder": 80,
     "labels": {"en": "Škoda", "de": "Škoda", "ru": "Шкода"},
     "aliases": ["skoda", "škoda", "Skoda", "Шкода"], "searchTokens": ["skoda"]},
    {"_id": "toyota", "category": "brand", "sortOrder": 90,
     "labels": {"en": "Toyota", "de": "Toyota", "ru": "Тойота"},
     "aliases": ["toyota", "Toyota", "Тойота"], "searchTokens": ["toyota", "lexus"]},
    {"_id": "japanese", "category": "brand", "sortOrder": 100,
     "labels": {"en": "Japanese brands", "de": "Japanische Marken", "ru": "Японские марки"},
     "aliases": ["japanese", "JDM"],
     "searchTokens": ["japanese", "honda", "nissan", "mazda", "subaru", "mitsubishi"]},

    # ── POWERTRAIN ──────────────────────────────────────────────────────────
    {"_id": "ev", "category": "powertrain", "sortOrder": 200,
     "labels": {"en": "Electric (EV)", "de": "Elektrofahrzeuge", "ru": "Электромобили"},
     "aliases": ["ev", "EV", "electric", "Tesla", "Электро"],
     "searchTokens": ["ev", "electric", "battery", "tesla"]},
    {"_id": "hybrid", "category": "powertrain", "sortOrder": 210,
     "labels": {"en": "Hybrid", "de": "Hybrid", "ru": "Гибрид"},
     "aliases": ["hybrid", "PHEV", "Гибрид"],
     "searchTokens": ["hybrid", "phev", "plugin"]},
    {"_id": "diesel", "category": "powertrain", "sortOrder": 220,
     "labels": {"en": "Diesel", "de": "Diesel", "ru": "Дизель"},
     "aliases": ["diesel", "TDI", "CDI", "BlueTEC"],
     "searchTokens": ["diesel", "tdi", "dpf", "adblue"]},

    # ── VEHICLE CLASS ───────────────────────────────────────────────────────
    {"_id": "classic", "category": "vehicle_class", "sortOrder": 300,
     "labels": {"en": "Classic / Oldtimer", "de": "Oldtimer", "ru": "Классика / Олдтаймер"},
     "aliases": ["classic", "oldtimer", "youngtimer", "Олдтаймер"],
     "searchTokens": ["classic", "oldtimer", "vintage"]},
    {"_id": "motorcycle", "category": "vehicle_class", "sortOrder": 310,
     "labels": {"en": "Motorcycle", "de": "Motorrad", "ru": "Мотоцикл"},
     "aliases": ["moto", "bike", "motorcycle", "Мото"],
     "searchTokens": ["motorcycle", "motorrad", "moto"]},
    {"_id": "truck", "category": "vehicle_class", "sortOrder": 320,
     "labels": {"en": "Truck / LKW", "de": "LKW", "ru": "Грузовик"},
     "aliases": ["truck", "LKW", "lorry", "Грузовик"],
     "searchTokens": ["truck", "lkw", "lorry"]},
    {"_id": "van", "category": "vehicle_class", "sortOrder": 330,
     "labels": {"en": "Van / Transporter", "de": "Transporter", "ru": "Микроавтобус"},
     "aliases": ["van", "Transporter", "Sprinter", "Микроавтобус"],
     "searchTokens": ["van", "transporter", "sprinter", "vito"]},

    # ── SERVICE TYPE / EXPERTISE ────────────────────────────────────────────
    {"_id": "accident_detection", "category": "service_type", "sortOrder": 400,
     "labels": {"en": "Accident detection", "de": "Unfallerkennung", "ru": "Выявление ДТП"},
     "aliases": ["accident", "Unfall"],
     "searchTokens": ["accident", "unfall", "crash", "frame"]},
    {"_id": "mileage_fraud", "category": "service_type", "sortOrder": 410,
     "labels": {"en": "Mileage fraud check", "de": "Tachostand-Prüfung", "ru": "Проверка скрутки пробега"},
     "aliases": ["mileage", "tacho", "odometer", "скрутка"],
     "searchTokens": ["mileage", "tacho", "odometer"]},
    {"_id": "paint_thickness", "category": "service_type", "sortOrder": 420,
     "labels": {"en": "Paint thickness", "de": "Lackschichtenmessung", "ru": "Толщиномер краски"},
     "aliases": ["paint", "Lackschicht"],
     "searchTokens": ["paint", "lack", "thickness"]},
    {"_id": "engine_diagnostics", "category": "service_type", "sortOrder": 430,
     "labels": {"en": "Engine diagnostics", "de": "Motordiagnose", "ru": "Диагностика двигателя"},
     "aliases": ["engine", "OBD", "Motordiagnose"],
     "searchTokens": ["engine", "obd", "diagnostics", "motor"]},
    {"_id": "body_repair", "category": "service_type", "sortOrder": 440,
     "labels": {"en": "Body repair", "de": "Karosserie", "ru": "Кузовной ремонт"},
     "aliases": ["body", "Karosserie"],
     "searchTokens": ["body", "karosserie"]},
    {"_id": "electrical", "category": "service_type", "sortOrder": 450,
     "labels": {"en": "Electrical / electronics", "de": "Elektrik / Elektronik", "ru": "Электрика"},
     "aliases": ["electrical", "Elektrik", "Электрика"],
     "searchTokens": ["electrical", "elektrik"]},
    {"_id": "flood_damage", "category": "service_type", "sortOrder": 460,
     "labels": {"en": "Flood damage check", "de": "Wasserschaden-Prüfung", "ru": "Проверка на утопление"},
     "aliases": ["flood", "Wasser"],
     "searchTokens": ["flood", "water", "wasser"]},

    # ── TRUST SIGNALS / CERTIFICATIONS ──────────────────────────────────────
    {"_id": "tuv_certified", "category": "trust_signal", "sortOrder": 500,
     "labels": {"en": "TÜV-certified", "de": "TÜV-zertifiziert", "ru": "Сертифицировано TÜV"},
     "aliases": ["TÜV", "TUV", "T.U.V."],
     "searchTokens": ["tuv", "tüv"]},
    {"_id": "dekra_certified", "category": "trust_signal", "sortOrder": 510,
     "labels": {"en": "DEKRA-certified", "de": "DEKRA-zertifiziert", "ru": "Сертифицировано DEKRA"},
     "aliases": ["DEKRA"], "searchTokens": ["dekra"]},
    {"_id": "master_mechanic", "category": "trust_signal", "sortOrder": 520,
     "labels": {"en": "Master mechanic (Meister)", "de": "Meister", "ru": "Мастер-механик"},
     "aliases": ["meister", "Meister", "Мастер"],
     "searchTokens": ["meister", "master"]},

    # ── GEOGRAPHIC ──────────────────────────────────────────────────────────
    {"_id": "eu_import", "category": "geographic", "sortOrder": 600,
     "labels": {"en": "EU import expert", "de": "EU-Import-Experte", "ru": "Импорт из ЕС"},
     "aliases": ["EU import", "EU-Import"],
     "searchTokens": ["import", "eu"]},
    {"_id": "ru_import", "category": "geographic", "sortOrder": 610,
     "labels": {"en": "Russian import", "de": "RU-Import", "ru": "Импорт в РФ"},
     "aliases": ["RU import", "Россия"],
     "searchTokens": ["ru", "russia"]},
]


# ─────────────────────────────────────────────────────────────────────────────
# Index plan — what each collection needs at scale.
# ─────────────────────────────────────────────────────────────────────────────

INDEXES: dict[str, list[dict]] = {
    "accounts": [
        # one user can hold multiple accounts (kinds), but only one per kind.
        {"keys": [("userId", ASCENDING), ("kind", ASCENDING)], "unique": True, "name": "uniq_user_kind"},
        {"keys": [("kind", ASCENDING), ("status", ASCENDING)], "name": "by_kind_status"},
        {"keys": [("organizationId", ASCENDING)], "sparse": True, "name": "by_org"},
        {"keys": [("publicSlug", ASCENDING)], "unique": True, "sparse": True, "name": "uniq_slug"},
        {"keys": [("createdAt", DESCENDING)], "name": "by_created"},
    ],
    "account_capabilities": [
        # one row per (account, capability)
        {"keys": [("accountId", ASCENDING), ("capability", ASCENDING)], "unique": True, "name": "uniq_account_cap"},
        {"keys": [("capability", ASCENDING), ("status", ASCENDING)], "name": "by_cap_status"},
        {"keys": [("specializations", ASCENDING)], "name": "by_spec"},
    ],
    "account_organizations": [
        # Sprint 1B: NEW collection for "team/business owning multiple accounts".
        # Distinct from legacy `organizations` (provider/workshop directory).
        # 1C may merge them; 1B keeps them separate to avoid schema clashes.
        {"keys": [("slug", ASCENDING)], "unique": True, "name": "uniq_slug"},
        {"keys": [("ownerUserId", ASCENDING)], "name": "by_owner"},
        {"keys": [("type", ASCENDING)], "name": "by_type"},
    ],
    "organization_members": [
        # Sprint 1C: separate collection (NOT embedded array) so 1 org × N members
        # × M role-changes doesn't create hot documents at scale.
        {"keys": [("organizationId", ASCENDING), ("userId", ASCENDING)], "unique": True, "name": "uniq_org_user"},
        {"keys": [("userId", ASCENDING), ("leftAt", ASCENDING)], "name": "by_user_active"},
        {"keys": [("organizationId", ASCENDING), ("role", ASCENDING)], "name": "by_org_role"},
    ],
    "specializations": [
        {"keys": [("category", ASCENDING), ("sortOrder", ASCENDING)], "name": "by_cat_order"},
        {"keys": [("active", ASCENDING)], "name": "by_active"},
        {"keys": [("searchTokens", ASCENDING)], "name": "by_search"},
        {"keys": [("aliases", ASCENDING)], "name": "by_alias"},
    ],
}


async def main():
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "auto_search_platform")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    print(f"\n=== Sprint 1B init  · {db_name} ===\n")

    existing = set(await db.list_collection_names())

    # 1) Ensure collections exist (Mongo creates on first write — explicit create
    # so admin tools see them and we can attach indexes immediately).
    # NOTE: legacy `organizations` collection (provider/workshop directory) is
    # intentionally NOT touched. The new team-model lives in `account_organizations`
    # to avoid schema clash. Sprint 1C will decide whether/how to merge.
    for name in ("accounts", "account_capabilities", "account_organizations", "organization_members", "specializations"):
        if name not in existing:
            await db.create_collection(name)
            print(f"  + created collection {name}")
        else:
            print(f"  · collection {name} already exists")

    # 2) Apply indexes (idempotent — Mongo skips if already present with same spec).
    for coll_name, idx_specs in INDEXES.items():
        coll = db[coll_name]
        for spec in idx_specs:
            kwargs = {"name": spec["name"]}
            if spec.get("unique"):
                kwargs["unique"] = True
            if spec.get("sparse"):
                kwargs["sparse"] = True
            await coll.create_index(spec["keys"], **kwargs)
        print(f"  · {coll_name}: {len(idx_specs)} indexes ensured")

    # 3) Seed specializations (upsert by _id — idempotent, can re-run to refresh labels).
    spec_coll = db["specializations"]
    seeded_now = datetime.now(timezone.utc)
    upserted = 0
    for spec in SPECIALIZATIONS_SEED:
        doc = {**spec, "active": True, "createdAt": seeded_now}
        # Don't overwrite createdAt on existing rows — use $setOnInsert pattern.
        result = await spec_coll.update_one(
            {"_id": spec["_id"]},
            {
                "$set": {
                    "category": doc["category"],
                    "labels": doc["labels"],
                    "aliases": doc["aliases"],
                    "searchTokens": doc["searchTokens"],
                    "active": True,
                    "sortOrder": doc.get("sortOrder", 0),
                },
                "$setOnInsert": {"createdAt": seeded_now},
            },
            upsert=True,
        )
        if result.upserted_id is not None:
            upserted += 1
    total_specs = await spec_coll.count_documents({})
    print(f"\n  · specializations: {len(SPECIALIZATIONS_SEED)} in seed → "
          f"{upserted} newly inserted, {total_specs} total in DB")

    # 4) Sanity prints
    print("\n  Final state:")
    for name in ("accounts", "account_capabilities", "organizations", "specializations"):
        cnt = await db[name].count_documents({})
        idx_cnt = len(await db[name].index_information())
        print(f"    {name:25s} docs={cnt:5d}  indexes={idx_cnt}")

    print("\n✓ Sprint 1B init complete. No legacy data was touched.\n")
    client.close()


if __name__ == "__main__":
    asyncio.run(main())
