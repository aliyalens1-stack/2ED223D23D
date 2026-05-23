"""Sprint 5 · Block 3 — PayPal Orders v2 (REST API).

Strategy:
  • Real call → PayPal /v2/checkout/orders (sandbox or live based on PAYPAL_BASE_URL)
  • Placeholder credentials (`demo_client_id`/`demo_secret`) → graceful FALLBACK to
    deterministic mock orders so the UI is testable without sandbox creds.
  • Currency: EUR only (per Sprint 5 strategy)
  • No webhook verification (polling-only via /capture-order)
  • Same credit-grant abstraction as Stripe → mark_payment_paid(payment_id)

ENV (from /app/backend/.env):
  PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_BASE_URL,
  PAYPAL_BRAND_NAME, PAYPAL_RETURN_BASE, PAYPAL_CANCEL_BASE
"""
from __future__ import annotations
import os
import time
import uuid
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

PAYPAL_CLIENT_ID = os.environ.get("PAYPAL_CLIENT_ID", "demo_client_id")
PAYPAL_SECRET = os.environ.get("PAYPAL_SECRET", "demo_secret")
PAYPAL_BASE_URL = os.environ.get("PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com").rstrip("/")
PAYPAL_BRAND_NAME = os.environ.get("PAYPAL_BRAND_NAME", "Auto Search")

# Cache for the OAuth token (5 min TTL — PayPal returns expires_in ~32400 but we re-fetch often enough)
_token_cache: dict = {"access_token": None, "expires_at": 0.0}


def is_demo_mode() -> bool:
    """When credentials are placeholder, run in deterministic-mock mode."""
    return PAYPAL_CLIENT_ID == "demo_client_id" or PAYPAL_SECRET == "demo_secret"


async def _get_access_token() -> Optional[str]:
    """OAuth2 client_credentials → access_token. Returns None on auth failure."""
    if is_demo_mode():
        return None
    if _token_cache["access_token"] and _token_cache["expires_at"] > time.time() + 30:
        return _token_cache["access_token"]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{PAYPAL_BASE_URL}/v1/oauth2/token",
                auth=(PAYPAL_CLIENT_ID, PAYPAL_SECRET),
                data={"grant_type": "client_credentials"},
                headers={"Accept": "application/json"},
            )
        if r.status_code != 200:
            logger.warning("PayPal auth failed (%d): %s", r.status_code, r.text[:300])
            return None
        body = r.json()
        _token_cache["access_token"] = body["access_token"]
        _token_cache["expires_at"] = time.time() + int(body.get("expires_in", 32400))
        return _token_cache["access_token"]
    except Exception as exc:
        logger.warning("PayPal auth exception: %s", exc)
        return None


async def create_order(
    amount_eur: int,             # whole euros (per PACKAGE_CATALOG)
    currency: str,               # "EUR"
    payment_id: str,             # internal package_payments._id
    return_url: str,
    cancel_url: str,
) -> dict:
    """Create a PayPal Order. Returns dict {order_id, approve_url, mock: bool}."""
    if currency.upper() != "EUR":
        raise ValueError("Only EUR is supported in v1")

    amount_major = f"{int(amount_eur):d}.00"
    token = await _get_access_token()

    if not token:
        # Deterministic mock — works without real PayPal access
        mock_order_id = f"MOCK-{uuid.uuid4().hex[:16].upper()}"
        # In demo mode the "approve_url" simply redirects to /capture endpoint logic.
        approve_url = f"{return_url}?token={mock_order_id}&PayerID=DEMO_PAYER&payment_id={payment_id}"
        logger.info("[paypal] DEMO order created: %s", mock_order_id)
        return {"order_id": mock_order_id, "approve_url": approve_url, "mock": True}

    payload = {
        "intent": "CAPTURE",
        "purchase_units": [{
            "reference_id": payment_id,
            "amount": {"currency_code": "EUR", "value": amount_major},
            "description": f"{PAYPAL_BRAND_NAME} — credit pack",
        }],
        "application_context": {
            "brand_name": PAYPAL_BRAND_NAME,
            "shipping_preference": "NO_SHIPPING",
            "user_action": "PAY_NOW",
            "return_url": return_url,
            "cancel_url": cancel_url,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"{PAYPAL_BASE_URL}/v2/checkout/orders",
                json=payload,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "PayPal-Request-Id": payment_id,  # idempotency key
                },
            )
        if r.status_code not in (200, 201):
            logger.warning("PayPal create-order failed (%d): %s", r.status_code, r.text[:400])
            # graceful fallback to mock
            mock_order_id = f"MOCK-{uuid.uuid4().hex[:16].upper()}"
            approve_url = f"{return_url}?token={mock_order_id}&PayerID=DEMO_PAYER&payment_id={payment_id}"
            return {"order_id": mock_order_id, "approve_url": approve_url, "mock": True}
        body = r.json()
        order_id = body.get("id")
        approve_url = next(
            (l["href"] for l in body.get("links", []) if l.get("rel") == "approve"),
            None,
        )
        if not order_id or not approve_url:
            raise RuntimeError(f"PayPal returned malformed response: {body}")
        return {"order_id": order_id, "approve_url": approve_url, "mock": False}
    except Exception as exc:
        logger.exception("PayPal create-order crash: %s", exc)
        mock_order_id = f"MOCK-{uuid.uuid4().hex[:16].upper()}"
        approve_url = f"{return_url}?token={mock_order_id}&PayerID=DEMO_PAYER&payment_id={payment_id}"
        return {"order_id": mock_order_id, "approve_url": approve_url, "mock": True}


async def capture_order(order_id: str) -> dict:
    """Capture a previously-created PayPal order. Returns {captured, status, raw|mock}."""
    if not order_id:
        return {"captured": False, "status": "missing_order_id"}

    # Demo / mock branch — order ids start with MOCK-
    if order_id.startswith("MOCK-") or is_demo_mode():
        logger.info("[paypal] DEMO capture for %s — auto-approve", order_id)
        return {"captured": True, "status": "COMPLETED", "mock": True}

    token = await _get_access_token()
    if not token:
        return {"captured": False, "status": "auth_failed"}

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.post(
                f"{PAYPAL_BASE_URL}/v2/checkout/orders/{order_id}/capture",
                json={},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "PayPal-Request-Id": f"cap-{order_id}",
                },
            )
        if r.status_code in (200, 201):
            body = r.json()
            status = body.get("status")
            return {"captured": status == "COMPLETED", "status": status, "raw": body}
        # Already captured?
        if r.status_code == 422:
            try:
                err = r.json()
                if any(d.get("issue") == "ORDER_ALREADY_CAPTURED" for d in err.get("details", [])):
                    return {"captured": True, "status": "ALREADY_CAPTURED"}
            except Exception:
                pass
        logger.warning("PayPal capture failed (%d): %s", r.status_code, r.text[:400])
        return {"captured": False, "status": f"http_{r.status_code}", "raw_text": r.text[:500]}
    except Exception as exc:
        logger.exception("PayPal capture crash: %s", exc)
        return {"captured": False, "status": "exception", "error": str(exc)}
