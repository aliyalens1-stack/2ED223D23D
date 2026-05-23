"""seed_customer_journey.py — happy-path fixtures for the customer cabinet.

Создаёт реалистичный набор car_requests + inspection_jobs от лица одного
демонстрационного клиента, покрывающий ВСЕ ключевые состояния customer-UI:

  1. open               → клиент только что подал заявку, никого ещё нет
  2. has_quotes         → пришло несколько quotes от inspector-ов
  3. in_progress        → один inspector взял в работу, есть live-status
  4. completed          → инспекция завершена, report готов к просмотру
  5. multi_city         → одна заявка с городами Berlin + Munich (1:N jobs)
  6. cancelled          → клиент отменил до начала

Каждая запись помечена `seedTag = 'customer-journey-demo'` — идемпотентно.
Демо-клиент: customer@test.com / Customer123! (создаётся, если нет).

Usage:
    python /app/backend/seed_customer_journey.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
from motor.motor_asyncio import AsyncIOMotorClient

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

SEED_TAG = 'customer-journey-demo'
CUSTOMER_EMAIL = 'customer@test.com'
CUSTOMER_PASSWORD = 'Customer123!'


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


def _hash(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


# Demo cars — realistic German market mid-tier listings.
DEMO_CARS = [
    {'brand': 'BMW', 'model': '320d Touring', 'year': 2019, 'budget': 22000, 'fuel': 'diesel'},
    {'brand': 'Audi', 'model': 'A6 Avant 45 TFSI', 'year': 2021, 'budget': 38000, 'fuel': 'gasoline'},
    {'brand': 'Mercedes', 'model': 'GLC 220d 4MATIC', 'year': 2020, 'budget': 34000, 'fuel': 'diesel'},
    {'brand': 'VW', 'model': 'Passat Variant 2.0 TDI', 'year': 2018, 'budget': 18500, 'fuel': 'diesel'},
    {'brand': 'Porsche', 'model': 'Macan S', 'year': 2019, 'budget': 51000, 'fuel': 'gasoline'},
    {'brand': 'Skoda', 'model': 'Octavia RS', 'year': 2022, 'budget': 26000, 'fuel': 'gasoline'},
    {'brand': 'Tesla', 'model': 'Model 3 Long Range', 'year': 2021, 'budget': 41000, 'fuel': 'electric'},
]


async def _ensure_customer(db) -> tuple[str, dict]:
    """Find-or-create the demo customer user. Returns (id, full doc)."""
    user = await db.users.find_one({'email': CUSTOMER_EMAIL})
    if user:
        cid = str(user.get('id') or user.get('_id'))
        # Make sure id is canonical (some legacy users only have _id)
        await db.users.update_one({'email': CUSTOMER_EMAIL}, {'$set': {'id': cid}})
        return cid, user

    cid = _uid()
    doc = {
        '_id': cid, 'id': cid,
        'email': CUSTOMER_EMAIL,
        'name': 'Max Mustermann',
        'phone': '+49 30 99887766',
        'role': 'customer',
        'password': _hash(CUSTOMER_PASSWORD),
        'createdAt': _now(),
        'preferredCity': 'berlin',
    }
    await db.users.insert_one(doc)
    print(f'[seed] created demo customer: {CUSTOMER_EMAIL} / {CUSTOMER_PASSWORD}')
    return cid, doc


async def _ensure_inspectors(db) -> list[dict]:
    """Find any active inspectors for quoting. Bootstrap minimal pool if none."""
    inspectors = await db.users.find(
        {'role': 'inspector'},
        {'_id': 0, 'id': 1, 'name': 1, 'email': 1},
    ).to_list(10)

    if not inspectors:
        # Bootstrap 2 demo inspectors so quote-flow has assignees.
        for i, name in enumerate(['Klaus Berger', 'Sven Hoffmann']):
            iid = _uid()
            await db.users.insert_one({
                '_id': iid, 'id': iid,
                'email': f'inspector_demo_{i+1}@test.com',
                'name': name, 'role': 'inspector',
                'password': _hash('Inspector123!'),
                'createdAt': _now(),
                'rating': 4.7 + i * 0.1,
                'completedJobs': 42 + i * 17,
                'seedTag': SEED_TAG,
            })
            inspectors.append({'id': iid, 'name': name, 'email': f'inspector_demo_{i+1}@test.com'})
        print(f'[seed] bootstrapped {len(inspectors)} demo inspectors')
    return inspectors


async def _wipe_previous(db) -> None:
    """Idempotent wipe of any previous run."""
    res1 = await db.car_requests.delete_many({'seedTag': SEED_TAG})
    res2 = await db.inspection_jobs.delete_many({'seedTag': SEED_TAG})
    res3 = await db.inspection_reports.delete_many({'seedTag': SEED_TAG})
    res4 = await db.request_quotes.delete_many({'seedTag': SEED_TAG})
    res5 = await db.notifications.delete_many({'seedTag': SEED_TAG})
    print(f'[seed] wiped previous run: '
          f'car_requests={res1.deleted_count}, jobs={res2.deleted_count}, '
          f'reports={res3.deleted_count}, quotes={res4.deleted_count}, '
          f'notifications={res5.deleted_count}')


async def _create_request(
    db, *, customer_id: str, car: dict, cities: list[str],
    status: str, hours_ago: int,
) -> tuple[str, datetime]:
    """Create a `car_requests` row. Returns (request_id, created_at)."""
    rid = _uid()
    created = _now() - timedelta(hours=hours_ago)
    doc = {
        '_id': rid, 'id': rid,
        'userId': customer_id, 'customerId': customer_id,
        'brand': car['brand'], 'model': car['model'],
        'budget': car['budget'],
        'yearFrom': car['year'], 'yearTo': car['year'],
        'fuel': car['fuel'],
        'cities': cities,
        'links': [],
        'status': status,
        'jobsTotal': len(cities),
        'jobsClaimed': 0, 'jobsDone': 0,
        'createdAt': created,
        'updatedAt': created,
        'seedTag': SEED_TAG,
    }
    await db.car_requests.insert_one(doc)
    return rid, created


def _brief(car: dict, city: str, address: str, fee: int = 149) -> dict:
    return {
        'vehicleSummary': f"{car['year']} {car['brand']} {car['model']}",
        'serviceLabel': 'Pre-purchase inspection',
        'cityLabel': city.capitalize(),
        'address': address,
        'customerName': 'Max Mustermann',
        'customerPhone': '+49 30 99887766',
        'feeEur': fee,
    }


async def _create_job(
    db, *, request_id: str, customer_id: str, car: dict, city: str,
    address: str, status: str, inspector_id: str | None = None,
    minutes_offset: int = 0, report_id: str | None = None,
) -> str:
    """Create an `inspection_jobs` row tied to a request."""
    jid = _uid()
    now = _now() + timedelta(minutes=minutes_offset)
    doc = {
        '_id': jid, 'id': jid,
        'requestId': request_id, 'customerId': customer_id,
        'city': city.capitalize(),
        'inspectorId': inspector_id,
        'status': status,
        'brand': car['brand'], 'model': car['model'],
        'budget': car['budget'],
        'brief': _brief(car, city, address),
        'createdAt': now, 'updatedAt': now,
        'seedTag': SEED_TAG,
    }
    if report_id:
        doc['reportId'] = report_id
        doc['hasReport'] = True
        doc['completedAt'] = now
    await db.inspection_jobs.insert_one(doc)
    return jid


async def _create_quote(
    db, *, request_id: str, inspector: dict, price: int, eta_hours: int,
    note: str,
) -> None:
    qid = _uid()
    await db.request_quotes.insert_one({
        '_id': qid, 'id': qid,
        'requestId': request_id,
        'inspectorId': inspector.get('id'),
        'inspectorName': inspector.get('name'),
        'price': price,
        'currency': 'EUR',
        'etaHours': eta_hours,
        'note': note,
        'status': 'pending',
        'createdAt': _now(),
        'seedTag': SEED_TAG,
    })


async def _create_notification(
    db, *, user_id: str, title: str, body: str, kind: str, link: str,
) -> None:
    await db.notifications.insert_one({
        '_id': _uid(),
        'userId': user_id,
        'title': title, 'body': body,
        'kind': kind, 'link': link,
        'read': False,
        'createdAt': _now(),
        'seedTag': SEED_TAG,
    })


async def main() -> None:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    customer_id, _ = await _ensure_customer(db)
    inspectors = await _ensure_inspectors(db)
    await _wipe_previous(db)

    # ── Scenario 1: open (just submitted, no quotes yet) ─────────────
    car = DEMO_CARS[0]
    r1, _ = await _create_request(
        db, customer_id=customer_id, car=car, cities=['berlin'],
        status='open', hours_ago=1,
    )
    await _create_job(
        db, request_id=r1, customer_id=customer_id, car=car,
        city='berlin', address='Friedrichstraße 100', status='open',
    )

    # ── Scenario 2: has_quotes (3 inspectors quoted) ─────────────────
    car = DEMO_CARS[1]
    r2, _ = await _create_request(
        db, customer_id=customer_id, car=car, cities=['munich'],
        status='quoted', hours_ago=6,
    )
    await _create_job(
        db, request_id=r2, customer_id=customer_id, car=car,
        city='munich', address='Marienplatz 8', status='open',
    )
    for i, ins in enumerate(inspectors[:3]):
        await _create_quote(
            db, request_id=r2, inspector=ins,
            price=140 + i * 15,
            eta_hours=4 + i,
            note=f"Verfügbar {'heute' if i == 0 else 'morgen'} · TÜV-zertifiziert",
        )
    await _create_notification(
        db, user_id=customer_id,
        title='3 Inspektoren bereit',
        body=f"Ihre Anfrage {car['brand']} {car['model']} hat 3 Angebote.",
        kind='quotes_received', link=f"/customer/requests/{r2}",
    )

    # ── Scenario 3: in_progress (inspector claimed, inspecting now) ───
    car = DEMO_CARS[2]
    r3, _ = await _create_request(
        db, customer_id=customer_id, car=car, cities=['hamburg'],
        status='in_progress', hours_ago=4,
    )
    await db.car_requests.update_one(
        {'_id': r3}, {'$set': {'jobsClaimed': 1}},
    )
    ins = inspectors[0]
    await _create_job(
        db, request_id=r3, customer_id=customer_id, car=car,
        city='hamburg', address='Reeperbahn 25', status='inspecting',
        inspector_id=ins.get('id'),
    )
    await _create_notification(
        db, user_id=customer_id,
        title='Inspektion läuft',
        body=f"{ins.get('name')} prüft Ihr {car['brand']} {car['model']}.",
        kind='inspection_started', link=f"/customer/requests/{r3}",
    )

    # ── Scenario 4: completed (report ready) ─────────────────────────
    car = DEMO_CARS[3]
    r4, _ = await _create_request(
        db, customer_id=customer_id, car=car, cities=['cologne'],
        status='completed', hours_ago=72,
    )
    await db.car_requests.update_one(
        {'_id': r4}, {'$set': {'jobsClaimed': 1, 'jobsDone': 1}},
    )
    ins = inspectors[1] if len(inspectors) > 1 else inspectors[0]
    report_id = _uid()
    j4 = await _create_job(
        db, request_id=r4, customer_id=customer_id, car=car,
        city='cologne', address='Hohe Straße 134', status='done',
        inspector_id=ins.get('id'), report_id=report_id,
    )
    await db.inspection_reports.insert_one({
        '_id': report_id, 'id': report_id,
        'jobId': j4, 'requestId': r4,
        'inspectorId': ins.get('id'),
        'city': 'Cologne', 'brand': car['brand'], 'model': car['model'],
        'score': 8.3, 'verdict': 'recommended',
        'checklist': [
            {'category': 'engine', 'name': 'Cold start', 'state': 'ok'},
            {'category': 'engine', 'name': 'Idle stability', 'state': 'ok'},
            {'category': 'brakes', 'name': 'Front pads', 'state': 'wear', 'note': '60% worn'},
            {'category': 'tires', 'name': 'Tread depth', 'state': 'ok', 'note': '5.2mm avg'},
            {'category': 'electronics', 'name': 'DTC scan', 'state': 'ok'},
        ],
        'issues': [
            {'severity': 'medium', 'title': 'Front brake pads near end-of-life',
             'description': 'Replace within next 5,000 km.', 'estimateEur': 280},
        ],
        'summary': 'Solid condition for mileage. Minor brake maintenance due.',
        'repairEstimateMin': 280, 'repairEstimateMax': 450,
        'mediaCount': 18,
        'status': 'submitted',
        'createdAt': _now() - timedelta(hours=68),
        'seedTag': SEED_TAG,
    })
    await _create_notification(
        db, user_id=customer_id,
        title='Bericht bereit',
        body=f"Inspektionsbericht für {car['brand']} {car['model']} ist verfügbar.",
        kind='report_ready', link=f"/customer/requests/{r4}/report",
    )

    # ── Scenario 5: multi-city request (1 request → 2 jobs) ──────────
    car = DEMO_CARS[4]  # Porsche Macan
    r5, _ = await _create_request(
        db, customer_id=customer_id, car=car,
        cities=['berlin', 'munich'],
        status='in_progress', hours_ago=10,
    )
    await db.car_requests.update_one(
        {'_id': r5}, {'$set': {'jobsClaimed': 2, 'jobsTotal': 2}},
    )
    await _create_job(
        db, request_id=r5, customer_id=customer_id, car=car,
        city='berlin', address='Kurfürstendamm 50', status='claimed',
        inspector_id=inspectors[0].get('id'),
    )
    await _create_job(
        db, request_id=r5, customer_id=customer_id, car=car,
        city='munich', address='Leopoldstraße 200', status='inspecting',
        inspector_id=inspectors[1].get('id') if len(inspectors) > 1 else inspectors[0].get('id'),
        minutes_offset=-30,
    )

    # ── Scenario 6: cancelled ────────────────────────────────────────
    car = DEMO_CARS[5]
    r6, _ = await _create_request(
        db, customer_id=customer_id, car=car, cities=['frankfurt'],
        status='cancelled', hours_ago=24,
    )
    await _create_job(
        db, request_id=r6, customer_id=customer_id, car=car,
        city='frankfurt', address='Zeil 100', status='cancelled',
    )

    # ── Summary ──────────────────────────────────────────────────────
    req_count = await db.car_requests.count_documents({'userId': customer_id, 'seedTag': SEED_TAG})
    job_count = await db.inspection_jobs.count_documents({'customerId': customer_id, 'seedTag': SEED_TAG})
    quote_count = await db.request_quotes.count_documents({'seedTag': SEED_TAG})
    report_count = await db.inspection_reports.count_documents({'seedTag': SEED_TAG})
    notif_count = await db.notifications.count_documents({'userId': customer_id, 'seedTag': SEED_TAG})

    print('[seed_customer_journey] ✅ done')
    print(f'  customer:        {CUSTOMER_EMAIL} / {CUSTOMER_PASSWORD} (id={customer_id})')
    print(f'  inspectors:      {len(inspectors)}')
    print(f'  car_requests:    {req_count}  (open / has_quotes / in_progress / completed / multi-city / cancelled)')
    print(f'  inspection_jobs: {job_count}')
    print(f'  request_quotes:  {quote_count}')
    print(f'  reports:         {report_count}')
    print(f'  notifications:   {notif_count}')


if __name__ == '__main__':
    asyncio.run(main())
