"""
seed_inspector.py — idempotent inspector account seed for development.

Creates one inspector user that web-app inspector workspace (Phase 1.1A) can
log in with. Reuses the same JWT/account-row machinery as production login —
the inspector's `accounts` row is created lazily on first login through
`ensure_account_for_user`.

Run:
    cd /app/backend && python seed_inspector.py

Idempotent: if the email already exists, the script updates the password and
ensures the role is `inspector`. Safe to run repeatedly.
"""
import os
import sys
from datetime import datetime, timezone

import bcrypt
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

INSPECTOR_EMAIL = os.environ.get('INSPECTOR_SEED_EMAIL', 'inspector@autoservice.com')
INSPECTOR_PASSWORD = os.environ.get('INSPECTOR_SEED_PASSWORD', 'Inspector123!')
INSPECTOR_FIRST = 'Klaus'
INSPECTOR_LAST = 'Müller'

MONGO_URL = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME = os.environ.get('DB_NAME', 'test_database')


def hash_pw(plain: str) -> str:
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt()).decode()


def main() -> int:
    db = MongoClient(MONGO_URL).get_database(DB_NAME)
    now = datetime.now(timezone.utc).isoformat()

    existing = db.users.find_one({'email': INSPECTOR_EMAIL})
    payload = {
        'email': INSPECTOR_EMAIL,
        'passwordHash': hash_pw(INSPECTOR_PASSWORD),
        'firstName': INSPECTOR_FIRST,
        'lastName': INSPECTOR_LAST,
        'role': 'inspector',
        'isActive': True,
    }

    if existing:
        db.users.update_one({'_id': existing['_id']}, {'$set': payload})
        print(f'[seed_inspector] updated existing user: {INSPECTOR_EMAIL}')
    else:
        payload['createdAt'] = now
        db.users.insert_one(payload)
        print(f'[seed_inspector] created new user: {INSPECTOR_EMAIL}')

    print(f'[seed_inspector] login with: {INSPECTOR_EMAIL} / {INSPECTOR_PASSWORD}')
    print('[seed_inspector] account row will be created on first login (Sprint 1A lazy ensure).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
