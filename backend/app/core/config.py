"""app.core.config — environment + path constants.

Sprint 21 C1: вынос env/констант из server.py. Никакого изменения значений.
Модули читают эти константы вместо прямых os.environ.get вызовов.

load_dotenv() вызывается здесь, чтобы config можно было импортировать из любого
места без зависимости от порядка импорта в server.py.
"""
from __future__ import annotations
import os
from pathlib import Path
from dotenv import load_dotenv

# /app/backend/app/core/config.py -> parents[2] = /app/backend
BACKEND_ROOT: Path = Path(__file__).resolve().parents[2]
REPO_ROOT: Path = BACKEND_ROOT.parent  # /app

load_dotenv(BACKEND_ROOT / '.env')

# ── MongoDB
MONGO_URL: str = os.environ.get('MONGO_URL', 'mongodb://localhost:27017')
DB_NAME: str = os.environ.get('DB_NAME', 'test_database')

# ── NestJS subprocess (server.py spawn'ит его из startup_event)
NESTJS_URL: str = os.environ.get('NESTJS_URL', 'http://localhost:3001')

# ── NestJS feature flag (default OFF). Когда выключен:
#    - bootstrap не пытается spawn'ить subprocess и не логирует ERROR
#    - catch-all /api/{path} возвращает 404 без circuit-breaker/relaunch
#    - health отдаёт `nestjs: "disabled"` (а не "starting")
# Включить: `NESTJS_ENABLED=1` в backend/.env. Также требуется собранный
# `backend/dist/main.js` (yarn build).
NESTJS_ENABLED: bool = os.environ.get('NESTJS_ENABLED', '0').strip().lower() in ('1', 'true', 'yes')

# ── Static dist-директории (сервируются через FastAPI под /api/admin-panel/ и /api/web-app/)
ADMIN_BUILD_DIR: Path = Path(os.environ.get('ADMIN_BUILD_DIR', str(REPO_ROOT / 'admin' / 'dist')))
WEBAPP_BUILD_DIR: Path = Path(os.environ.get('WEBAPP_BUILD_DIR', str(REPO_ROOT / 'web-app' / 'dist')))

# ── Auth
JWT_SECRET: str = os.environ.get('JWT_SECRET', 'auto_service_jwt_secret_key_2025_very_secure')
JWT_ALGO: str = 'HS256'

# ── Admin seed (используется в seed_data)
ADMIN_EMAIL: str = os.environ.get('ADMIN_EMAIL', 'admin@autoservice.com')
ADMIN_PASSWORD: str = os.environ.get('ADMIN_PASSWORD', 'Admin123!')

# ── Sprint 1D.T: Test infrastructure flags
# `TESTING=1` in env unconditionally bypasses rate limits + idempotency, used
# only when running pytest against a dedicated test pod. NEVER set this in
# the preview/prod deployment.
# `TEST_BYPASS_TOKEN` is a shared secret. When set, any request carrying
# `X-Test-Bypass: <token>` (matching this value) bypasses the auth rate
# limiter. Tests use this to run combined suites without hitting 5/60s
# throttling. The token MUST stay out of public docs and frontend code.
# If the env var is empty/unset, the bypass is impossible — header is ignored.
TESTING: bool = os.environ.get('TESTING', '0').strip().lower() in ('1', 'true', 'yes')
TEST_BYPASS_TOKEN: str = os.environ.get('TEST_BYPASS_TOKEN', '').strip()
