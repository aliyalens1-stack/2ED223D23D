"""Pytest fixtures shared across the entire backend test suite.

Sprint 1D.T — Test Infrastructure Stabilization.

What this gives every test file:
  • `BYPASS_HEADERS`   — dict to merge into requests so the auth rate
                         limiter (5/60s on /login & /register) lets us through.
  • `client`           — async httpx.AsyncClient fixture (session-scoped,
                         not function — saves one TCP setup per test).
  • `admin_token`      — a single login per test session for the admin user.
  • `provider_token`   — a single registration + login per session.
  • `customer_token`   — a single registration + login per session.
  • `provider_account` / `customer_account` — full AccountView dicts.
  • `issue_test_jwt`   — convenience wrapper around
                         `identity_runtime.issue_account_jwt`. Avoids hitting
                         /auth/login for unit-style tests that only need a
                         valid token.

Tests must NOT login or register on their own when these fixtures cover the
case — that is the source of cross-suite 429s. New tests should reuse these
fixtures or document a one-off reason for fresh registration.
"""
from __future__ import annotations
import os
import time
import uuid
import asyncio
from typing import AsyncIterator

import httpx
import pytest
import pytest_asyncio


# ─────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8001")

# Rate-limiter bypass — same secret as backend `.env` `TEST_BYPASS_TOKEN`.
# When the env var isn't set in this process, the header is empty and the
# bypass simply doesn't engage (production-safe default).
_BYPASS_TOKEN = os.environ.get("TEST_BYPASS_TOKEN", "").strip()
BYPASS_HEADERS: dict[str, str] = {"X-Test-Bypass": _BYPASS_TOKEN} if _BYPASS_TOKEN else {}

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


# ─────────────────────────────────────────────────────────────────────
# httpx client — function-scoped (avoids "Event loop is closed" between
# tests when fixtures of different scopes interact). The bypass headers
# carry the rate-limit secret so we never need to thread it manually.
# ─────────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(
        base_url=BACKEND_URL,
        timeout=15.0,
        headers=BYPASS_HEADERS,
    ) as c:
        yield c


# ─────────────────────────────────────────────────────────────────────
# Tokens are plain strings — safe to cache module-level after one
# warm-up call. We use a tiny synchronous httpx client for the warm-up
# so we don't bind to any event loop. This is the cleanest way to share
# auth state across async tests without scope conflicts.
# ─────────────────────────────────────────────────────────────────────

def _sync_post(path: str, payload: dict) -> dict:
    """Synchronous POST that does NOT bind to any event loop."""
    with httpx.Client(base_url=BACKEND_URL, timeout=15.0, headers=BYPASS_HEADERS) as c:
        r = c.post(path, json=payload)
    if r.status_code >= 400:
        raise RuntimeError(f"warmup {path} failed: {r.status_code} {r.text}")
    return r.json()


_admin_login_cache: dict | None = None
_provider_signup_cache: dict | None = None
_customer_signup_cache: dict | None = None


def _unique_email(prefix: str) -> str:
    return f"{prefix}-{int(time.time()*1000)}-{uuid.uuid4().hex[:6]}@test.local"


def _ensure_admin_login() -> dict:
    global _admin_login_cache
    if _admin_login_cache is None:
        _admin_login_cache = _sync_post(
            "/api/auth/login",
            {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        )
    return _admin_login_cache


def _ensure_provider_signup() -> dict:
    global _provider_signup_cache
    if _provider_signup_cache is None:
        email = _unique_email("provider")
        body = _sync_post(
            "/api/auth/register",
            {
                "email": email,
                "password": "test1234",
                "firstName": "TestSession",
                "lastName": "Provider",
                "role": "provider_owner",
            },
        )
        body["_email"] = email
        _provider_signup_cache = body
    return _provider_signup_cache


def _ensure_customer_signup() -> dict:
    global _customer_signup_cache
    if _customer_signup_cache is None:
        email = _unique_email("customer")
        body = _sync_post(
            "/api/auth/register",
            {
                "email": email,
                "password": "test1234",
                "firstName": "TestSession",
                "lastName": "Customer",
                "role": "customer",
            },
        )
        body["_email"] = email
        _customer_signup_cache = body
    return _customer_signup_cache


# ─────────────────────────────────────────────────────────────────────
# Public fixtures — backed by sync warm-up cache (no loop binding)
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def admin_login() -> dict:
    return _ensure_admin_login()


@pytest.fixture
def admin_token(admin_login: dict) -> str:
    return admin_login["accessToken"]


@pytest.fixture
def admin_account(admin_login: dict) -> dict:
    return admin_login["activeAccount"]


@pytest.fixture
def provider_signup() -> dict:
    return _ensure_provider_signup()


@pytest.fixture
def provider_token(provider_signup: dict) -> str:
    return provider_signup["accessToken"]


@pytest.fixture
def provider_account(provider_signup: dict) -> dict:
    return provider_signup["activeAccount"]


@pytest.fixture
def provider_user_id(provider_signup: dict) -> str:
    return provider_signup["user"]["id"]


@pytest.fixture
def customer_signup() -> dict:
    return _ensure_customer_signup()


@pytest.fixture
def customer_token(customer_signup: dict) -> str:
    return customer_signup["accessToken"]


@pytest.fixture
def customer_account(customer_signup: dict) -> dict:
    return customer_signup["activeAccount"]


@pytest.fixture
def customer_user_id(customer_signup: dict) -> str:
    return customer_signup["user"]["id"]


# ─────────────────────────────────────────────────────────────────────
# Auth-header helper — stays usable both with fixtures and with raw tokens
# ─────────────────────────────────────────────────────────────────────

def auth_headers(token: str, *, extra: dict | None = None) -> dict:
    """Build a Bearer-auth header dict that already carries the rate-limit
    bypass. Use this in every test that hits a rate-limited endpoint."""
    h = {"Authorization": f"Bearer {token}"}
    if BYPASS_HEADERS:
        h.update(BYPASS_HEADERS)
    if extra:
        h.update(extra)
    return h


# ─────────────────────────────────────────────────────────────────────
# Direct-JWT helper — bypasses /login entirely
# ─────────────────────────────────────────────────────────────────────

def issue_test_jwt(
    user_id: str,
    user_email: str,
    legacy_role: str,
    account: dict,
    days_valid: int = 7,
) -> str:
    """Mint a JWT in-process without hitting /auth/login. Useful for unit
    tests that only need a valid token shape and don't care about the full
    register/login flow.

    `account` accepts a plain dict (e.g. the AccountView.to_json() output
    returned by /auth/me) — we wrap it back into the AccountView class
    expected by `issue_account_jwt`.
    """
    # Imported lazily so importing conftest doesn't pay backend init cost
    # for tests that don't touch identity at all.
    from app.core.identity_runtime import AccountView, issue_account_jwt

    av = AccountView(
        id=account["id"],
        userId=account.get("userId", user_id),
        kind=account.get("kind", "customer"),
        status=account.get("status", "active"),
        displayName=account.get("displayName", ""),
        avatar=account.get("avatar"),
        publicSlug=account.get("publicSlug"),
        organizationId=account.get("organizationId"),
        legacyRole=account.get("legacyRole", legacy_role),
        isPrimary=bool(account.get("isPrimary", True)),
        isLegacyShim=bool(account.get("isLegacy", False)),
        stats=account.get("stats") or {},
        capabilities=list(account.get("capabilities") or []),
    )
    return issue_account_jwt(
        user_id=user_id,
        user_email=user_email,
        legacy_role=legacy_role,
        account=av,
        days_valid=days_valid,
    )
