"""seed_inspector_jobs.py — operational hardening seed for Phase 1.1B.

Purpose:
  Provides realistic, idempotent fixtures for the inspector workspace
  end-to-end lifecycle test. Created jobs cover all four operationally
  meaningful states:

    1. offered      — `inspector_exposures` row with status=visible
                      (+ the underlying `inspection_jobs` row in 'open')
    2. claimed      — `inspection_jobs.status = 'claimed'`
    3. inspecting   — `inspection_jobs.status = 'inspecting'` (the one
                      that drives autosave/draft/submit testing)
    4. report_ready — `inspection_jobs.status = 'done'` + matching
                      `inspection_reports` row (frontend projects 'done'
                      → 'report_ready' via _job_to_dict)

Idempotent: any existing fixture with `seedTag = 'phase11b-hardening'`
is wiped and recreated. Real production rows are untouched.

Usage:
    /root/.venv/bin/python /app/backend/seed_inspector_jobs.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

# Make backend package importable when run as a script.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')

INSPECTOR_EMAIL = os.environ.get('INSPECTOR_SEED_EMAIL', 'inspector@autoservice.com')
SEED_TAG = 'phase11b-hardening'


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return str(uuid.uuid4())


async def main() -> None:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    inspector = await db.users.find_one({'email': INSPECTOR_EMAIL})
    if not inspector:
        print(f'[seed_inspector_jobs] inspector user {INSPECTOR_EMAIL} not found — '
              'run seed_inspector.py first.')
        return
    inspector_id_raw = inspector.get('_id') or inspector.get('id')
    inspector_id = str(inspector_id_raw)
    print(f'[seed_inspector_jobs] inspector id: {inspector_id}')

    # ── 1. Wipe any previous run of this seed (idempotency) ─────────
    await db.inspection_jobs.delete_many({'seedTag': SEED_TAG})
    await db.inspector_exposures.delete_many({'seedTag': SEED_TAG})
    await db.car_requests.delete_many({'seedTag': SEED_TAG})
    await db.inspection_reports.delete_many({'seedTag': SEED_TAG})
    await db.users.delete_many({'seedTag': SEED_TAG})

    # ── 2. Customer (one user the four scenarios share) ─────────────
    customer_id = _new_id()
    await db.users.insert_one({
        '_id': customer_id,
        'id': customer_id,
        'email': 'customer-hardening@autoservice.com',
        'name': 'Anna Schmidt',
        'phone': '+49 30 12345678',
        'role': 'customer',
        'createdAt': _now(),
        'seedTag': SEED_TAG,
    })

    # Reusable factory for a (car_request, inspection_job) pair.
    async def _make_pair(brand, model, year, city, address, fee_eur, fuel='diesel'):
        request_id = _new_id()
        job_id = _new_id()
        now = _now()
        await db.car_requests.insert_one({
            '_id': request_id,
            'id': request_id,
            'userId': customer_id,
            'brand': brand,
            'model': model,
            'budget': fee_eur * 100,        # car budget — unrelated to fee
            'cities': [city],
            'links': [],
            'yearFrom': year,
            'yearTo': year,
            'fuel': fuel,
            'status': 'open',
            'jobsTotal': 1, 'jobsClaimed': 0, 'jobsDone': 0,
            'createdAt': now,
            'updatedAt': now,
            'seedTag': SEED_TAG,
        })
        return request_id, job_id, now

    brief_template = lambda brand, model, year, city, address, fee_eur: {
        'vehicleSummary': f'{year} {brand} {model}',
        'serviceLabel': 'Pre-purchase inspection',
        'cityLabel': city,
        'address': address,
        'customerName': 'Anna Schmidt',
        'customerPhone': '+49 30 12345678',
        'feeEur': fee_eur,
    }

    # ── 3a. OFFERED — open job + visible exposure ──────────────────
    req1, job1, now = await _make_pair('BMW', '320d', 2018, 'Berlin', 'Friedrichstraße 100', 149)
    await db.inspection_jobs.insert_one({
        '_id': job1, 'id': job1, 'requestId': req1,
        'city': 'Berlin', 'inspectorId': None,
        'status': 'open',
        'brand': 'BMW', 'model': '320d', 'budget': 14900,
        'brief': brief_template('BMW', '320d', 2018, 'Berlin', 'Friedrichstraße 100', 149),
        'customerId': customer_id,
        'createdAt': now, 'updatedAt': now,
        'seedTag': SEED_TAG,
    })
    await db.inspector_exposures.insert_one({
        '_id': _new_id(),
        'jobId': job1,
        'requestId': req1,
        'inspectorId': inspector_id,
        'city': 'Berlin',
        'status': 'visible',
        'rank': 1, 'score': 0.92,
        'waveReason': 'initial',
        'exposedAt': now,
        'expiresAt': now + timedelta(hours=2),
        'seedTag': SEED_TAG,
    })

    # ── 3b. CLAIMED — inspector took the job, hasn't started travel ─
    req2, job2, now = await _make_pair('Audi', 'A4', 2020, 'Berlin', 'Alexanderplatz 5', 149)
    claimed_at = now - timedelta(minutes=12)
    await db.inspection_jobs.insert_one({
        '_id': job2, 'id': job2, 'requestId': req2,
        'city': 'Berlin', 'inspectorId': inspector_id,
        'status': 'claimed',
        'brand': 'Audi', 'model': 'A4', 'budget': 18000,
        'brief': brief_template('Audi', 'A4', 2020, 'Berlin', 'Alexanderplatz 5', 149),
        'customerId': customer_id,
        'createdAt': now - timedelta(hours=1),
        'claimedAt': claimed_at,
        'updatedAt': claimed_at,
        'seedTag': SEED_TAG,
    })
    # mark request as assigned (1 job claimed)
    await db.car_requests.update_one(
        {'_id': req2},
        {'$set': {'status': 'assigned', 'jobsClaimed': 1, 'updatedAt': claimed_at}},
    )

    # ── 3c. INSPECTING — the autosave/draft/submit fixture ─────────
    req3, job3, now = await _make_pair('VW', 'Golf 7', 2017, 'Berlin', 'Kurfürstendamm 200', 149)
    started = now - timedelta(minutes=8)
    await db.inspection_jobs.insert_one({
        '_id': job3, 'id': job3, 'requestId': req3,
        'city': 'Berlin', 'inspectorId': inspector_id,
        'status': 'inspecting',
        'brand': 'VW', 'model': 'Golf 7', 'budget': 12000,
        'brief': brief_template('VW', 'Golf 7', 2017, 'Berlin', 'Kurfürstendamm 200', 149),
        'customerId': customer_id,
        'createdAt': now - timedelta(hours=2),
        'claimedAt': now - timedelta(minutes=45),
        'onRouteAt': now - timedelta(minutes=30),
        'arrivedAt': now - timedelta(minutes=15),
        'inspectionStartedAt': started,
        'updatedAt': started,
        'seedTag': SEED_TAG,
    })
    await db.car_requests.update_one(
        {'_id': req3},
        {'$set': {'status': 'in_progress', 'jobsClaimed': 1, 'updatedAt': started}},
    )

    # ── 3d. REPORT_READY — done job + submitted report ─────────────
    req4, job4, now = await _make_pair('Mercedes', 'C220d', 2019, 'Berlin', 'Potsdamer Platz 1', 149)
    completed = now - timedelta(hours=3)
    report_id = _new_id()
    await db.inspection_jobs.insert_one({
        '_id': job4, 'id': job4, 'requestId': req4,
        'city': 'Berlin', 'inspectorId': inspector_id,
        'status': 'done',  # serializer projects to 'report_ready' for web
        'brand': 'Mercedes', 'model': 'C220d', 'budget': 22000,
        'brief': brief_template('Mercedes', 'C220d', 2019, 'Berlin', 'Potsdamer Platz 1', 149),
        'customerId': customer_id,
        'reportId': report_id,
        'hasReport': True,
        'createdAt': now - timedelta(hours=8),
        'claimedAt': now - timedelta(hours=6),
        'onRouteAt': now - timedelta(hours=5, minutes=30),
        'arrivedAt': now - timedelta(hours=5),
        'inspectionStartedAt': now - timedelta(hours=4, minutes=30),
        'completedAt': completed,
        'updatedAt': completed,
        'seedTag': SEED_TAG,
    })
    await db.inspection_reports.insert_one({
        '_id': report_id,
        'id': report_id,
        'jobId': job4,
        'requestId': req4,
        'inspectorId': inspector_id,
        'city': 'Berlin', 'brand': 'Mercedes', 'model': 'C220d',
        'score': 7.8, 'verdict': 'recommended',
        'checklist': [],   # empty list is fine for the read-back path
        'issues': [
            {'severity': 'low', 'title': 'Front-left tire wear',
             'description': 'Within tolerance, replace within 6 months.'},
        ],
        'summary': 'Vehicle is in good operational condition with minor cosmetic wear consistent with mileage.',
        'repairEstimateMin': 200, 'repairEstimateMax': 450,
        'status': 'submitted',
        'createdAt': completed,
        'seedTag': SEED_TAG,
    })

    print(f'[seed_inspector_jobs] created jobs:')
    print(f'  offered     → job={job1}  exposure on /inspector/jobs')
    print(f'  claimed     → job={job2}  ready for /on-route transition')
    print(f'  inspecting  → job={job3}  drives autosave + submit on /report')
    print(f'  report_ready→ job={job4}  read-only, has report id={report_id}')
    print('[seed_inspector_jobs] done.')


if __name__ == '__main__':
    asyncio.run(main())
