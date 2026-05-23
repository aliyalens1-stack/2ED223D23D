"""Sprint 24 — Redis state + locks + rate limit. Backend integration tests.

Run: pytest /app/backend/tests/test_sprint24_redis_hardening.py -v \
     --junitxml=/app/test_reports/pytest/sprint24.xml

Backend exposed at EXT URL via Kubernetes ingress; supervisor runs it on
0.0.0.0:8001 internally. Redis: redis://127.0.0.1:6379/0 (local).
"""
from __future__ import annotations

import os
import subprocess
import time

import pytest
import redis
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
LOCAL = "http://127.0.0.1:8001"
RCLI = redis.Redis.from_url("redis://127.0.0.1:6379/0", decode_responses=True)

ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}


# ── helpers ─────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json=ADMIN, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("accessToken") or r.json().get("token")
    assert tok, "no accessToken in login response"
    return tok


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _hdr_ip(ip: str) -> dict:
    return {"X-Forwarded-For": ip}


# ── 1. Redis connectivity ──────────────────────────────────────────────

class TestRedisConnectivity:
    def test_redis_ping(self):
        assert RCLI.ping() is True

    def test_backend_log_redis_connected(self):
        # accept either supervisor err.log OR out.log
        out = subprocess.run(
            ["grep", "-rh", "Redis connected", "/var/log/supervisor/"],
            capture_output=True, text=True
        ).stdout
        assert "redis://127.0.0.1:6379/0" in out, f"no 'Redis connected' log line found"


# ── 2. Cooldown migration: orchestrator + pre-engagement keys ──────────

class TestCooldownMigration:
    def test_orch_or_preengage_keys_appear(self):
        """Orchestrator runs every 10s. Wait up to 35s for any cooldown:* key
        (orch or preengage) — at least one zone in any cycle should set one."""
        deadline = time.time() + 35
        seen_orch, seen_pre = [], []
        while time.time() < deadline:
            seen_orch = list(RCLI.scan_iter(match="cooldown:orch:*"))
            seen_pre = list(RCLI.scan_iter(match="cooldown:preengage:*"))
            if seen_orch or seen_pre:
                break
            time.sleep(2)
        # Sprint 24 spec — at least one of the two should appear within ~3 cycles
        assert seen_orch or seen_pre, (
            "no cooldown:* keys after waiting 35s — orchestrator may be idle "
            "(all zones BALANCED). Reporting as observation; not a failure of Redis "
            "state migration itself, but spec expectation."
        )

    def test_orch_key_format_and_ttl(self):
        keys = list(RCLI.scan_iter(match="cooldown:orch:*"))
        if not keys:
            pytest.skip("no cooldown:orch:* keys — orchestrator currently idle")
        k = keys[0]
        # Format: cooldown:orch:{zone}:{severity}
        parts = k.split(":")
        assert len(parts) >= 4, f"unexpected key format: {k}"
        ttl = RCLI.ttl(k)
        assert ttl > 0, f"key {k} has no positive TTL ({ttl})"
        assert ttl <= 600, f"TTL too long ({ttl}s)"

    def test_preengage_key_ttl(self):
        keys = list(RCLI.scan_iter(match="cooldown:preengage:*"))
        if not keys:
            pytest.skip("no cooldown:preengage:* keys — pressure threshold not crossed")
        k = keys[0]
        ttl = RCLI.ttl(k)
        assert ttl > 0 and ttl <= 600


# ── 3. Zone lock ────────────────────────────────────────────────────────

class TestZoneLock:
    def test_lock_zone_keys_or_inspect(self):
        """Zone locks have very short TTL (15s); we may not catch one. We just
        check the namespace conforms — at least no leaked locks > 30s TTL."""
        for k in RCLI.scan_iter(match="lock:zone:*"):
            ttl = RCLI.ttl(k)
            assert ttl <= 30, f"zone lock {k} has TTL {ttl}s — should be ≤30"


# ── 4. Rate limit (per IP) ──────────────────────────────────────────────

class TestRateLimitZonesLiveState:
    def test_60_pass_15_throttle(self):
        ip = f"9.9.9.{int(time.time()) % 250}"
        url = f"{BASE_URL}/api/zones/live-state"
        ok, throttled, body_429 = 0, 0, ""
        sess = requests.Session()
        for _ in range(75):
            r = sess.get(url, headers=_hdr_ip(ip), timeout=15)
            if r.status_code == 200:
                ok += 1
            elif r.status_code == 429:
                throttled += 1
                if not body_429:
                    body_429 = r.text
        assert ok == 60, f"expected 60 OK, got {ok}; throttled={throttled}"
        assert throttled == 15, f"expected 15 throttled, got {throttled}; ok={ok}"
        assert ("Too many requests" in body_429
                or "RATE_LIMITED" in body_429), f"429 body did not contain expected msg: {body_429!r}"


class TestRateLimitIsolatedPerIP:
    def test_different_ips_isolated(self):
        ip_a = f"7.7.7.{int(time.time()) % 250}"
        ip_b = f"8.8.8.{int(time.time()) % 250}"
        url = f"{BASE_URL}/api/zones/live-state"
        # exhaust ip_a
        sess = requests.Session()
        for _ in range(65):
            sess.get(url, headers=_hdr_ip(ip_a), timeout=15)
        # ip_b should still pass
        r = requests.get(url, headers=_hdr_ip(ip_b), timeout=15)
        assert r.status_code == 200, f"isolated IP got {r.status_code}: {r.text[:200]}"


class TestRateLimitOtherEndpoints:
    def test_marketplace_providers(self):
        ip = f"6.{int(time.time())%250}.{(int(time.time())//7)%250}.{(int(time.time())//13)%250}"
        url = f"{BASE_URL}/api/marketplace/providers"
        codes = []
        sess = requests.Session()
        for _ in range(70):
            r = sess.get(url, headers=_hdr_ip(ip), timeout=15)
            codes.append(r.status_code)
        ok = codes.count(200)
        thr = codes.count(429)
        assert thr >= 5, f"expected ≥5 throttled on /providers, got {thr} (ok={ok})"

    def test_marketplace_quick_request(self):
        ip = f"5.5.5.{int(time.time()) % 250}"
        url = f"{BASE_URL}/api/marketplace/quick-request"
        thr = 0
        for _ in range(70):
            r = requests.post(url, headers=_hdr_ip(ip),
                              json={"problem": "diagnostics", "lat": 50.45, "lng": 30.52},
                              timeout=15)
            if r.status_code == 429:
                thr += 1
        assert thr >= 5, f"expected ≥5 throttled on quick-request, got {thr}"


class TestRateLimitNotOnAdmin:
    def test_admin_forecast_status_not_rate_limited(self, admin_h):
        # NOTE: prod_readiness has a separate global limiter on /api/admin (120/min);
        # we send 50 reqs to stay within that to assert Sprint 24 limiter (60/min)
        # is NOT applied here. Sprint 24 spec says "200+ req без 429" — that
        # contradicts pre-existing prod_readiness (120/min) — flagged as design gap.
        ip = f"4.4.4.{int(time.time()) % 250}"
        url = f"{BASE_URL}/api/admin/forecast/status"
        thr = 0
        for _ in range(50):
            r = requests.get(url, headers={**admin_h, **_hdr_ip(ip)}, timeout=15)
            if r.status_code == 429:
                thr += 1
        assert thr == 0, f"admin forecast/status got {thr}/50 429s — Sprint 24 limiter leaked onto admin"

    def test_admin_billing_stripe_config_not_rate_limited(self, admin_h):
        # See note above — probe under prod_readiness limit
        time.sleep(60)  # let prod_readiness window decay
        ip = f"3.3.3.{int(time.time()) % 250}"
        url = f"{BASE_URL}/api/admin/billing/stripe-config"
        thr = 0
        for _ in range(50):
            r = requests.get(url, headers={**admin_h, **_hdr_ip(ip)}, timeout=15)
            if r.status_code == 429:
                thr += 1
        assert thr == 0, f"got {thr}/50 429s on admin/stripe-config"


# ── 5. Redis fallback (fail-open) ──────────────────────────────────────

class TestRedisFallback:
    def test_zones_live_state_works_when_redis_down(self):
        # stop redis
        subprocess.run(["sudo", "supervisorctl", "stop", "redis"],
                       capture_output=True, text=True)
        time.sleep(2)
        try:
            r = requests.get(f"{BASE_URL}/api/zones/live-state", timeout=15)
            assert r.status_code == 200, f"live-state failed during Redis-down: {r.status_code} {r.text[:300]}"
            data = r.json()
            assert "zones" in data
        finally:
            subprocess.run(["sudo", "supervisorctl", "start", "redis"],
                           capture_output=True, text=True)
            time.sleep(2)
            # warm up redis client (best-effort ping via endpoint)
            requests.get(f"{BASE_URL}/api/zones/live-state", timeout=15)

    def test_billing_checkout_works_when_redis_down(self, admin_h):
        # ensure stripe config is set
        requests.post(f"{BASE_URL}/api/admin/billing/stripe-config",
                      headers=admin_h,
                      json={"secretKey": "sk_test_emergent",
                            "webhookSecret": "whsec_test123",
                            "enabled": True}, timeout=15)
        subprocess.run(["sudo", "supervisorctl", "stop", "redis"],
                       capture_output=True, text=True)
        time.sleep(2)
        try:
            r = requests.post(f"{BASE_URL}/api/billing/checkout",
                              headers=admin_h,
                              json={"plan": "pro", "successUrl": "https://x.dev/s",
                                    "cancelUrl": "https://x.dev/c"},
                              timeout=20)
            # accept 200 or 201 (or 4xx from Stripe-side issue but NOT 5xx caused by Redis)
            assert r.status_code < 500, f"checkout got 5xx during Redis-down: {r.status_code} {r.text[:300]}"
        finally:
            subprocess.run(["sudo", "supervisorctl", "start", "redis"],
                           capture_output=True, text=True)
            time.sleep(2)


# ── 6. Sprint 22/23 regression ──────────────────────────────────────────

class TestRegression:
    def test_admin_billing_stripe_config_get(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/admin/billing/stripe-config",
                         headers=admin_h, timeout=15)
        assert r.status_code == 200
        body = r.json()
        # accept either 'enabled' field or top-level structure
        assert isinstance(body, dict)

    def test_admin_billing_stripe_config_post(self, admin_h):
        r = requests.post(f"{BASE_URL}/api/admin/billing/stripe-config",
                          headers=admin_h,
                          json={"secretKey": "sk_test_emergent",
                                "webhookSecret": "whsec_test123",
                                "enabled": True}, timeout=15)
        assert r.status_code in (200, 201)

    def test_billing_checkout_session(self, admin_h):
        r = requests.post(f"{BASE_URL}/api/billing/checkout", headers=admin_h,
                          json={"productCode": "promoted_7d",
                                "originUrl": "https://x.dev",
                                "successUrl": "https://x.dev/s",
                                "cancelUrl": "https://x.dev/c"}, timeout=20)
        assert r.status_code == 200, f"checkout: {r.status_code} {r.text[:300]}"
        body = r.json()
        # should expose either a Stripe URL or sessionId
        assert any(k in body for k in ("url", "sessionId", "checkoutUrl", "id")), f"missing session fields: {body}"

    def test_admin_forecast_status(self, admin_h):
        r = requests.get(f"{BASE_URL}/api/admin/forecast/status",
                         headers=admin_h, timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert isinstance(body, dict)

    def test_zones_live_state_has_forecast(self):
        # use unique IP to dodge prior rate-limit windows
        ip = f"2.2.2.{int(time.time()) % 250}"
        r = requests.get(f"{BASE_URL}/api/zones/live-state",
                         headers=_hdr_ip(ip), timeout=15)
        assert r.status_code == 200
        zones = r.json().get("zones", [])
        assert len(zones) > 0
        # at least one zone has forecast field
        with_fc = [z for z in zones if "forecast" in z]
        assert len(with_fc) > 0, "no zones with 'forecast' field"
