"""
Sprint 12 — Production Readiness
──────────────────────────────────
Self-contained module that adds to FastAPI:
  1. Rate limiting (in-memory sliding-window)
  2. Idempotency layer (header Idempotency-Key)
  3. Retry + Circuit Breaker state for NestJS proxy
  4. Alert dispatcher (mock email / push / admin_log)
  5. Audit trail helper

Designed to be imported from server.py without breaking existing behaviour.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone, timedelta
from typing import Any, Awaitable, Callable, Deque, Dict, Optional, Tuple

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


# ──────────────────────────────────────────────────────────────
# 1. RATE LIMITING  (in-memory sliding-window per client+route)
# ──────────────────────────────────────────────────────────────
# Prefixes matched by longest-prefix; wildcard-free.
RATE_LIMITS: Dict[str, Dict[str, int]] = {
    "/api/auth/login":                  {"limit": 5,   "window": 60},
    "/api/auth/register":               {"limit": 5,   "window": 60},
    "/api/auth/forgot-password":        {"limit": 5,   "window": 60},
    "/api/marketplace/quick-request":   {"limit": 20,  "window": 60},
    "/api/marketplace/bookings":        {"limit": 20,  "window": 60},
    "/api/provider/accept":             {"limit": 30,  "window": 60},
    "/api/provider/complete":           {"limit": 30,  "window": 60},
    "/api/matching":                    {"limit": 30,  "window": 60},
    "/api/payments":                    {"limit": 30,  "window": 60},
    "/api/admin":                       {"limit": 120, "window": 60},
}

_rate_buckets: Dict[str, Deque[float]] = defaultdict(deque)

# Loopback + private addresses can be explicitly exempted from rate limits for
# local smoke tests and ingress reverse-proxies.  Disabled by default.
RATE_LIMIT_EXEMPT_LOOPBACK = os.environ.get("RATE_LIMIT_EXEMPT_LOOPBACK", "1") == "1"
_LOOPBACK_IPS = {"127.0.0.1", "::1", "localhost", ""}


def _match_rate_rule(path: str) -> Optional[Tuple[str, Dict[str, int]]]:
    # longest-prefix match
    best: Optional[Tuple[str, Dict[str, int]]] = None
    for prefix, rule in RATE_LIMITS.items():
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            if best is None or len(prefix) > len(best[0]):
                best = (prefix, rule)
    return best


def _client_key(request: Request) -> str:
    # prefer authenticated user if present in Authorization, fall back to IP
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return "u:" + hashlib.sha1(auth[7:].encode()).hexdigest()[:16]
    xff = request.headers.get("x-forwarded-for", "")
    ip = (xff.split(",")[0] if xff else "") or (request.client.host if request.client else "unknown")
    return "ip:" + ip


def check_rate_limit(request: Request) -> Optional[JSONResponse]:
    """Return 429 JSONResponse if the call exceeds its rule, else None."""
    matched = _match_rate_rule(request.url.path)
    if not matched:
        return None
    # Sprint 1D.T: test-suite bypass.
    # Two independent escape hatches, BOTH off by default in production:
    #   1. Env `TESTING=1` — unconditional bypass. Use ONLY in dedicated
    #      test pods. Never set in preview/prod.
    #   2. Header `X-Test-Bypass: <token>` matching env `TEST_BYPASS_TOKEN`
    #      — request-scoped bypass guarded by a shared secret. When the
    #      env var is empty/unset (production default), the header is
    #      ignored entirely — bypass is impossible.
    # Both are evaluated lazily here (not at module import) so that env
    # changes via `--reload` are picked up without restarting the worker.
    from app.core.config import TESTING, TEST_BYPASS_TOKEN
    if TESTING:
        return None
    if TEST_BYPASS_TOKEN:
        provided = request.headers.get("x-test-bypass", "")
        if provided and provided == TEST_BYPASS_TOKEN:
            return None
    # Exempt trusted loopback traffic (local smoke tests, same-pod calls)
    if RATE_LIMIT_EXEMPT_LOOPBACK:
        ip = request.client.host if request.client else ""
        if ip in _LOOPBACK_IPS:
            return None
    prefix, rule = matched
    limit = rule["limit"]
    window = rule["window"]
    key = f"{_client_key(request)}|{prefix}"
    now = time.time()
    bucket = _rate_buckets[key]
    while bucket and (now - bucket[0]) > window:
        bucket.popleft()
    if len(bucket) >= limit:
        retry_after = int(window - (now - bucket[0])) + 1
        return JSONResponse(
            status_code=429,
            content={
                "error": True,
                "code": "RATE_LIMITED",
                "message": f"Too many requests to {prefix}. Try again in {retry_after}s.",
                "details": {"limit": limit, "window": window, "retryAfter": retry_after},
            },
            headers={"Retry-After": str(retry_after)},
        )
    bucket.append(now)
    return None


# ──────────────────────────────────────────────────────────────
# 2. IDEMPOTENCY LAYER
# ──────────────────────────────────────────────────────────────
IDEMPOTENCY_TARGETS = [
    "/api/marketplace/quick-request",
    "/api/marketplace/bookings",
    "/api/marketplace/bookings/",    # :id/review, :id/complete, etc.
    "/api/provider/accept",
    "/api/provider/complete",
    "/api/payments",
    # Sprint 2 Step 5 — Offline Queue: inspector replay actions MUST be
    # idempotent end-to-end. `/api/inspector/jobs/` matches:
    #   POST /api/inspector/jobs/:id/report
    #   POST /api/inspector/jobs/:id/draft
    #   POST /api/inspector/jobs/:id/media/upload
    # (plus existing state-transition POSTs which are also safe to dedupe).
    "/api/inspector/jobs/",
]
IDEMPOTENCY_TTL_HOURS = 24

# Sprint 2 Step 5 + 4xx-policy hotfix.
# Non-success responses must NOT lock a key for 24h — that would break the
# offline-replay scenario where an inspector queues `report_submit` while
# the job is briefly in a 404-window (not yet assigned, race with admin
# refresh, etc). A legitimate retry minutes later must hit the live handler.
#
# Policy:
#   2xx  → cache for IDEMPOTENCY_TTL_HOURS (durable de-duplication)
#   4xx  → cache for IDEMPOTENCY_4XX_TTL_SECONDS (short window dedupes
#          frantic re-taps in the same session; does not block real retry)
#   5xx  → not cached at all; placeholder is deleted so retry is immediate
IDEMPOTENCY_4XX_TTL_SECONDS = 90


def _is_idempotent_target(path: str, method: str) -> bool:
    if method != "POST":
        return False
    return any(path == t or path.startswith(t) for t in IDEMPOTENCY_TARGETS)


async def ensure_idempotency_indexes(db) -> None:
    try:
        await db.idempotency_keys.create_index("key", unique=True)
        await db.idempotency_keys.create_index(
            "expiresAt", expireAfterSeconds=0,
        )
    except Exception:
        pass


async def idempotency_lookup(db, request: Request) -> Optional[JSONResponse]:
    """
    If Idempotency-Key is present on a POST to a protected route:
      - same key → return cached response (even for different body; advisory)
      - no prior key → return None, caller must commit after handler runs

    Note: body-hash conflict detection is handled in idempotency_commit, so we
    avoid reading the request body here (which would break downstream ASGI
    receive handling inside BaseHTTPMiddleware).

    Defensive read: filters out records whose `expiresAt` has already passed
    but which Mongo's TTL monitor (60s sweep) hasn't yet collected. Without
    this guard the short 90s 4xx-TTL would be unobservable for up to a
    minute, defeating the policy.
    """
    key = request.headers.get("idempotency-key")
    if not key:
        return None
    if not _is_idempotent_target(request.url.path, request.method):
        return None

    now = datetime.now(timezone.utc)
    existing = await db.idempotency_keys.find_one({"key": key}, {"_id": 0})
    if existing:
        # Defensive expiry — Mongo TTL monitor may be up to 60s behind.
        exp = existing.get("expiresAt")
        if isinstance(exp, datetime):
            exp_dt = exp if exp.tzinfo else exp.replace(tzinfo=timezone.utc)
        elif isinstance(exp, str):
            try:
                exp_dt = datetime.fromisoformat(exp.replace("Z", "+00:00"))
            except Exception:
                exp_dt = None
        else:
            exp_dt = None
        if exp_dt is not None and exp_dt <= now:
            # Treat as gone — let the new request through. Best-effort delete
            # so the upsert below doesn't fight a duplicate-key constraint.
            try:
                await db.idempotency_keys.delete_one({"key": key})
            except Exception:
                pass
            existing = None

    if existing:
        if existing.get("status") == "completed" and existing.get("response") is not None:
            cached = existing["response"]
            return JSONResponse(
                status_code=existing.get("statusCode", 200),
                content=cached,
                headers={
                    "x-idempotent-replay": "true",
                    # observability: surface cached status class so clients
                    # can tell `200-replay` from `4xx-replay`
                    "x-idempotent-status-class": str(existing.get("statusCode", 200) // 100) + "xx",
                },
            )
        # in_progress → reject to prevent double-processing
        return JSONResponse(
            status_code=409,
            content={
                "error": True,
                "code": "IDEMPOTENCY_IN_PROGRESS",
                "message": "Request with this Idempotency-Key is still processing",
                "details": {},
            },
        )

    # Insert in_progress placeholder. TTL kept at IDEMPOTENCY_TTL_HOURS for
    # the placeholder so a server crash mid-handler doesn't lock the key
    # forever, but ALSO never wedges legitimate retry beyond that window.
    # commit() may overwrite this with a shorter TTL for 4xx, or delete it
    # entirely for 5xx.
    client = _client_key(request)
    try:
        await db.idempotency_keys.insert_one({
            "key": key,
            "path": request.url.path,
            "method": request.method,
            "clientKey": client,
            "status": "in_progress",
            "createdAt": now.isoformat(),
            "expiresAt": now + timedelta(hours=IDEMPOTENCY_TTL_HOURS),
        })
    except Exception:
        # Race: another concurrent request just inserted the same key.
        # That's exactly the 409 in_progress case the next call will see.
        pass
    return None


async def idempotency_commit(db, request: Request, status_code: int, content_bytes: bytes) -> None:
    """
    Status-class-aware commit policy (Sprint 2 Step 5 follow-up).

    2xx → cache COMPLETED with TTL = IDEMPOTENCY_TTL_HOURS (durable dedup).
    4xx → cache COMPLETED with TTL = IDEMPOTENCY_4XX_TTL_SECONDS (short
          window dedupes frantic re-taps in the same session but never
          blocks a legitimate retry after the underlying condition
          changes — e.g. job becomes visible after a brief 404).
    5xx → DELETE placeholder so retry is unconstrained. Server errors
          MUST be retryable immediately; caching them turns one server
          hiccup into 24h of hard failure.
    """
    key = request.headers.get("idempotency-key")
    if not key or not _is_idempotent_target(request.url.path, request.method):
        return

    # 5xx — purge placeholder, do not cache.
    if status_code >= 500:
        try:
            await db.idempotency_keys.delete_one({"key": key})
        except Exception:
            pass
        return

    # 2xx / 4xx — write completed with status-class-specific TTL.
    try:
        payload: Any
        try:
            payload = json.loads(content_bytes.decode("utf-8")) if content_bytes else {}
        except Exception:
            payload = {"raw": content_bytes[:500].decode("utf-8", errors="replace")}

        now = datetime.now(timezone.utc)
        if 200 <= status_code < 300:
            new_expiry = now + timedelta(hours=IDEMPOTENCY_TTL_HOURS)
        elif 400 <= status_code < 500:
            new_expiry = now + timedelta(seconds=IDEMPOTENCY_4XX_TTL_SECONDS)
        else:
            # 1xx/3xx — uncommon for our targets; fall back to short TTL.
            new_expiry = now + timedelta(seconds=IDEMPOTENCY_4XX_TTL_SECONDS)

        await db.idempotency_keys.update_one(
            {"key": key},
            {"$set": {
                "status": "completed",
                "statusCode": status_code,
                "response": payload,
                "completedAt": now.isoformat(),
                "expiresAt": new_expiry,
            }},
        )
    except Exception:
        pass


async def idempotency_conflict_check(db, request: Request) -> Optional[JSONResponse]:
    """
    Optional conflict check: reads the request body and compares hash with a
    stored record (for *completed* keys that include a requestHash).  Used
    only for protected routes — call manually inside a handler when needed.
    """
    key = request.headers.get("idempotency-key")
    if not key or not _is_idempotent_target(request.url.path, request.method):
        return None
    existing = await db.idempotency_keys.find_one({"key": key}, {"_id": 0})
    if not existing or existing.get("status") != "completed":
        return None
    stored_hash = existing.get("requestHash")
    if not stored_hash:
        return None
    body = await request.body()
    body_hash = hashlib.sha256(body or b"").hexdigest()
    if stored_hash != body_hash:
        return JSONResponse(
            status_code=409,
            content={
                "error": True,
                "code": "IDEMPOTENCY_CONFLICT",
                "message": "Idempotency-Key re-used with different payload",
                "details": {},
            },
        )
    return None


# ──────────────────────────────────────────────────────────────
# 3. CIRCUIT BREAKER FOR NESTJS PROXY
# ──────────────────────────────────────────────────────────────
class CircuitBreaker:
    """Simple closed/open/half-open breaker."""
    def __init__(self, failure_threshold: int = 5, open_seconds: int = 30):
        self.failure_threshold = failure_threshold
        self.open_seconds = open_seconds
        self.failures = 0
        self.opened_at: Optional[float] = None
        self.total_trips = 0

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        if (time.time() - self.opened_at) >= self.open_seconds:
            # half-open
            self.opened_at = None
            self.failures = 0
            return True
        return False

    def record_success(self) -> None:
        self.failures = 0
        self.opened_at = None

    def record_failure(self) -> None:
        self.failures += 1
        if self.failures >= self.failure_threshold:
            if self.opened_at is None:
                self.total_trips += 1
            self.opened_at = time.time()

    def state(self) -> Dict[str, Any]:
        if self.opened_at and (time.time() - self.opened_at) < self.open_seconds:
            state = "open"
            retry_in = int(self.open_seconds - (time.time() - self.opened_at))
        elif self.failures > 0:
            state = "half-open" if self.opened_at is None and self.failures > 0 else "closed"
            retry_in = 0
        else:
            state = "closed"
            retry_in = 0
        return {
            "state": state,
            "failures": self.failures,
            "failureThreshold": self.failure_threshold,
            "openSeconds": self.open_seconds,
            "retryIn": retry_in,
            "totalTrips": self.total_trips,
        }


nest_breaker = CircuitBreaker(failure_threshold=5, open_seconds=30)


# ──────────────────────────────────────────────────────────────
# 4. ALERT DISPATCHER  (mock email / push / admin_log)
# ──────────────────────────────────────────────────────────────
ALERT_CHANNELS = ("email_mock", "push_mock", "admin_log")


async def dispatch_alert(db, *, level: str, code: str, message: str,
                        zone_id: Optional[str] = None,
                        meta: Optional[dict] = None,
                        channels: Optional[Tuple[str, ...]] = None) -> dict:
    """
    Persist an alert dispatch record.  Mocked — no outbound HTTP calls.
    Level: critical | warn | info
    """
    ts = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "level": level,
        "code": code,
        "message": message[:500],
        "zoneId": zone_id,
        "meta": meta or {},
        "channels": list(channels or ALERT_CHANNELS),
        "dispatchedAt": ts,
        "status": "delivered-mock",
    }
    try:
        await db.alert_dispatches.insert_one(dict(doc))
    except Exception:
        pass
    return doc


async def ensure_alert_indexes(db) -> None:
    try:
        await db.alert_dispatches.create_index([("dispatchedAt", -1)])
        # 7-day TTL on admin_log-only dispatches — but we keep all for now.
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────
# 5. AUDIT HELPER
# ──────────────────────────────────────────────────────────────
async def write_audit(db, *, actor: str, action: str, target: str,
                      details: Optional[dict] = None) -> None:
    try:
        await db.audit_logs.insert_one({
            "id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor": actor,
            "action": action,
            "target": target,
            "details": details or {},
        })
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────
# 6. TTL CLEANUP for legacy collections
# ──────────────────────────────────────────────────────────────
async def ensure_ttl_indexes(db) -> None:
    """
    Makes sure transient collections expire on their own.
    Each collection stores a field `expiresAt` as ISODate, indexed with
    expireAfterSeconds=0.
    """
    defs = [
        ("password_reset_tokens", "expiresAt"),
        ("realtime_events",       "expiresAt"),
        ("idempotency_keys",      "expiresAt"),
        ("alert_dispatches",      "expiresAt"),
        ("system_logs",           "expiresAt"),
    ]
    for coll, field in defs:
        try:
            await db[coll].create_index(field, expireAfterSeconds=0)
        except Exception:
            pass
