"""Stripe Settings — admin-managed runtime configuration.

Stored in MongoDB collection `stripe_settings` (single doc, id="global").

Source-of-truth precedence:
  1. DB doc (admin updates via Master Admin)
  2. ENV variables (STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY)
  3. Hard defaults (currency=eur, payment_methods=['card'])

Endpoints (all require admin token):
  GET  /api/admin/stripe/config           — current settings (secret key masked)
  POST /api/admin/stripe/config           — update settings
  GET  /api/admin/stripe/payment-methods  — catalog of all available Stripe pm types
  GET  /api/admin/stripe/currencies       — supported currency codes
  POST /api/admin/stripe/test-key         — validate provided secret_key with Stripe API
"""
from __future__ import annotations
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.utils import now_utc
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

router = APIRouter(prefix="/api/admin/stripe", tags=["admin-stripe"])
logger = logging.getLogger(__name__)

DOC_ID = "global"

# ── Catalogs (Stripe-supported as of 2026) ────────────────────────────────
SUPPORTED_PAYMENT_METHODS = [
    {"code": "card",                "name": "Card (Visa/MC/AmEx)", "category": "global",  "default": True},
    {"code": "link",                "name": "Stripe Link",          "category": "global",  "default": False},
    {"code": "apple_pay",           "name": "Apple Pay",            "category": "global",  "default": False, "auto_with_card": True},
    {"code": "google_pay",          "name": "Google Pay",           "category": "global",  "default": False, "auto_with_card": True},
    # Wallets
    {"code": "paypal",              "name": "PayPal",               "category": "wallet",  "default": False},
    {"code": "alipay",              "name": "Alipay",               "category": "wallet",  "default": False},
    {"code": "wechat_pay",          "name": "WeChat Pay",           "category": "wallet",  "default": False},
    {"code": "cashapp",             "name": "Cash App Pay",         "category": "wallet",  "default": False},
    # Bank debits
    {"code": "sepa_debit",          "name": "SEPA Direct Debit",    "category": "bank",    "default": False},
    {"code": "bacs_debit",          "name": "BACS Debit (UK)",      "category": "bank",    "default": False},
    {"code": "us_bank_account",     "name": "ACH / US Bank Account", "category": "bank",   "default": False},
    {"code": "acss_debit",          "name": "ACSS Debit (Canada)",  "category": "bank",    "default": False},
    # Bank redirects (Europe)
    {"code": "ideal",               "name": "iDEAL (Netherlands)",  "category": "redirect","default": False},
    {"code": "bancontact",          "name": "Bancontact (Belgium)", "category": "redirect","default": False},
    {"code": "giropay",             "name": "Giropay (Germany)",    "category": "redirect","default": False},
    {"code": "sofort",              "name": "Sofort (DE/AT)",       "category": "redirect","default": False},
    {"code": "eps",                 "name": "EPS (Austria)",        "category": "redirect","default": False},
    {"code": "p24",                 "name": "Przelewy24 (Poland)",  "category": "redirect","default": False},
    {"code": "blik",                "name": "BLIK (Poland)",        "category": "redirect","default": False},
    {"code": "twint",               "name": "TWINT (Switzerland)",  "category": "redirect","default": False},
    # BNPL
    {"code": "klarna",              "name": "Klarna (Pay Later)",   "category": "bnpl",    "default": False},
    {"code": "afterpay_clearpay",   "name": "Afterpay / Clearpay",  "category": "bnpl",    "default": False},
    {"code": "affirm",              "name": "Affirm",               "category": "bnpl",    "default": False},
    # Crypto
    {"code": "crypto",              "name": "Crypto (BTC/ETH/USDC)", "category": "crypto", "default": False},
]

SUPPORTED_CURRENCIES = [
    {"code": "eur", "name": "Euro", "symbol": "€"},
    {"code": "usd", "name": "US Dollar", "symbol": "$"},
    {"code": "gbp", "name": "British Pound", "symbol": "£"},
    {"code": "chf", "name": "Swiss Franc", "symbol": "CHF"},
    {"code": "pln", "name": "Polish Zloty", "symbol": "zł"},
    {"code": "czk", "name": "Czech Koruna", "symbol": "Kč"},
    {"code": "ron", "name": "Romanian Leu", "symbol": "lei"},
    {"code": "huf", "name": "Hungarian Forint", "symbol": "Ft"},
    {"code": "bgn", "name": "Bulgarian Lev", "symbol": "лв"},
    {"code": "dkk", "name": "Danish Krone", "symbol": "kr"},
    {"code": "nok", "name": "Norwegian Krone", "symbol": "kr"},
    {"code": "sek", "name": "Swedish Krona", "symbol": "kr"},
    {"code": "uah", "name": "Ukrainian Hryvnia", "symbol": "₴"},
    {"code": "cad", "name": "Canadian Dollar", "symbol": "CA$"},
    {"code": "aud", "name": "Australian Dollar", "symbol": "AU$"},
    {"code": "jpy", "name": "Japanese Yen", "symbol": "¥", "zero_decimal": True},
    {"code": "cny", "name": "Chinese Yuan", "symbol": "¥"},
    {"code": "brl", "name": "Brazilian Real", "symbol": "R$"},
    {"code": "mxn", "name": "Mexican Peso", "symbol": "MX$"},
    {"code": "inr", "name": "Indian Rupee", "symbol": "₹"},
    {"code": "sgd", "name": "Singapore Dollar", "symbol": "S$"},
    {"code": "hkd", "name": "Hong Kong Dollar", "symbol": "HK$"},
]


def _mask(secret: str | None) -> str:
    if not secret:
        return ""
    if len(secret) < 12:
        return "***"
    return f"{secret[:7]}…{secret[-4:]}"


async def _load_doc() -> dict:
    """Load DB doc or empty dict if missing."""
    doc = await db.stripe_settings.find_one({"id": DOC_ID}, {"_id": 0})
    return doc or {}


async def get_active_config() -> dict:
    """Resolve full config: DB → ENV fallback → defaults.
    Used by app/payments/router.py at runtime — server-side source of truth.
    Returns plaintext secret (NOT masked)."""
    doc = await _load_doc()
    return {
        "secretKey":      doc.get("secretKey")      or os.getenv("STRIPE_API_KEY") or os.getenv("STRIPE_SECRET_KEY") or "",
        "publishableKey": doc.get("publishableKey") or os.getenv("STRIPE_PUBLISHABLE_KEY") or "",
        "webhookSecret":  doc.get("webhookSecret")  or os.getenv("STRIPE_WEBHOOK_SECRET") or "",
        "currency":       (doc.get("currency") or "eur").lower(),
        "paymentMethods": doc.get("paymentMethods") or ["card"],
        "mode":           doc.get("mode") or ("test" if (os.getenv("STRIPE_API_KEY") or "").startswith("sk_test_") else "live"),
        "automaticPaymentMethods": doc.get("automaticPaymentMethods", True),
        "captureMethod":  doc.get("captureMethod") or "automatic",
        "allowPromotionCodes": doc.get("allowPromotionCodes", False),
        "billingAddressCollection": doc.get("billingAddressCollection") or "auto",
    }


# ── Pydantic models ───────────────────────────────────────────────────────
class StripeConfigUpdate(BaseModel):
    secretKey:      Optional[str] = None
    publishableKey: Optional[str] = None
    webhookSecret:  Optional[str] = None
    currency:       Optional[str] = None
    paymentMethods: Optional[list[str]] = None
    mode:           Optional[str] = Field(None, pattern="^(test|live)$")
    automaticPaymentMethods: Optional[bool] = None
    captureMethod:  Optional[str] = Field(None, pattern="^(automatic|manual)$")
    allowPromotionCodes: Optional[bool] = None
    billingAddressCollection: Optional[str] = Field(None, pattern="^(auto|required)$")


# ── GET /api/admin/stripe/config ──────────────────────────────────────────
@router.get("/config", dependencies=[Depends(verify_admin_token)])
async def get_config():
    cfg = await get_active_config()
    doc = await _load_doc()
    # Don't leak full secret/webhook to UI — show masked + "isSet" boolean
    return {
        "secretKeyMasked":      _mask(cfg["secretKey"]),
        "secretKeyIsSet":       bool(cfg["secretKey"]),
        "publishableKey":       cfg["publishableKey"],   # publishable is safe to expose
        "webhookSecretMasked":  _mask(cfg["webhookSecret"]),
        "webhookSecretIsSet":   bool(cfg["webhookSecret"]),
        "currency":             cfg["currency"],
        "paymentMethods":       cfg["paymentMethods"],
        "mode":                 cfg["mode"],
        "automaticPaymentMethods": cfg["automaticPaymentMethods"],
        "captureMethod":        cfg["captureMethod"],
        "allowPromotionCodes":  cfg["allowPromotionCodes"],
        "billingAddressCollection": cfg["billingAddressCollection"],
        "source": {
            "secretKey":      "db" if doc.get("secretKey") else ("env" if os.getenv("STRIPE_API_KEY") else "none"),
            "webhookSecret":  "db" if doc.get("webhookSecret") else ("env" if os.getenv("STRIPE_WEBHOOK_SECRET") else "none"),
            "publishableKey": "db" if doc.get("publishableKey") else ("env" if os.getenv("STRIPE_PUBLISHABLE_KEY") else "none"),
        },
        "updatedAt": doc.get("updatedAt"),
        "updatedBy": doc.get("updatedBy"),
    }


# ── POST /api/admin/stripe/config ─────────────────────────────────────────
@router.post("/config", dependencies=[Depends(verify_admin_token)])
async def update_config(
    payload: StripeConfigUpdate,
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """Update Stripe runtime settings. Accepts only fields that are sent.
    To keep an existing secret unchanged, omit the field (or send empty string to clear)."""
    update_set: dict = {}

    if payload.secretKey is not None:
        sk = payload.secretKey.strip()
        if sk and not (sk.startswith("sk_test_") or sk.startswith("sk_live_") or sk.startswith("rk_test_") or sk.startswith("rk_live_")):
            raise HTTPException(400, "Secret key must start with sk_test_, sk_live_, rk_test_ or rk_live_")
        update_set["secretKey"] = sk

    if payload.publishableKey is not None:
        pk = payload.publishableKey.strip()
        if pk and not (pk.startswith("pk_test_") or pk.startswith("pk_live_")):
            raise HTTPException(400, "Publishable key must start with pk_test_ or pk_live_")
        update_set["publishableKey"] = pk

    if payload.webhookSecret is not None:
        ws = payload.webhookSecret.strip()
        if ws and not ws.startswith("whsec_"):
            raise HTTPException(400, "Webhook secret must start with whsec_")
        update_set["webhookSecret"] = ws

    if payload.currency is not None:
        cur = payload.currency.lower().strip()
        if cur not in {c["code"] for c in SUPPORTED_CURRENCIES}:
            raise HTTPException(400, f"Currency '{cur}' is not supported")
        update_set["currency"] = cur

    if payload.paymentMethods is not None:
        valid_codes = {pm["code"] for pm in SUPPORTED_PAYMENT_METHODS}
        invalid = [m for m in payload.paymentMethods if m not in valid_codes]
        if invalid:
            raise HTTPException(400, f"Invalid payment methods: {invalid}")
        if not payload.paymentMethods:
            raise HTTPException(400, "At least one payment method must be enabled")
        update_set["paymentMethods"] = list(dict.fromkeys(payload.paymentMethods))  # dedup, preserve order

    if payload.mode is not None:
        update_set["mode"] = payload.mode
    if payload.automaticPaymentMethods is not None:
        update_set["automaticPaymentMethods"] = payload.automaticPaymentMethods
    if payload.captureMethod is not None:
        update_set["captureMethod"] = payload.captureMethod
    if payload.allowPromotionCodes is not None:
        update_set["allowPromotionCodes"] = payload.allowPromotionCodes
    if payload.billingAddressCollection is not None:
        update_set["billingAddressCollection"] = payload.billingAddressCollection

    if not update_set:
        raise HTTPException(400, "No fields to update")

    update_set["updatedAt"] = now_utc().isoformat()
    update_set["updatedBy"] = "admin"

    await db.stripe_settings.update_one(
        {"id": DOC_ID},
        {"$set": update_set, "$setOnInsert": {"id": DOC_ID, "createdAt": now_utc().isoformat()}},
        upsert=True,
    )

    logger.info(f"[stripe-settings] updated by admin: keys={list(update_set.keys())}")

    # Return fresh config (masked)
    return await get_config()


# ── GET /api/admin/stripe/payment-methods ─────────────────────────────────
@router.get("/payment-methods", dependencies=[Depends(verify_admin_token)])
async def list_payment_methods():
    return {"paymentMethods": SUPPORTED_PAYMENT_METHODS}


# ── GET /api/admin/stripe/currencies ──────────────────────────────────────
@router.get("/currencies", dependencies=[Depends(verify_admin_token)])
async def list_currencies():
    return {"currencies": SUPPORTED_CURRENCIES}


# ── POST /api/admin/stripe/test-key ───────────────────────────────────────
class TestKeyRequest(BaseModel):
    secretKey: str = Field(..., min_length=10)


@router.post("/test-key", dependencies=[Depends(verify_admin_token)])
async def test_secret_key(payload: TestKeyRequest):
    """Validate a Stripe secret key by hitting Stripe's /v1/balance endpoint.
    Returns {ok: true, mode: 'test'|'live', accountId} or 400 with reason."""
    import asyncio
    import stripe as stripe_sdk
    sk = payload.secretKey.strip()
    if not (sk.startswith("sk_test_") or sk.startswith("sk_live_") or sk.startswith("rk_test_") or sk.startswith("rk_live_")):
        raise HTTPException(400, "Invalid key format")
    stripe_sdk.api_key = sk
    try:
        loop = asyncio.get_running_loop()
        bal = await loop.run_in_executor(None, lambda: stripe_sdk.Balance.retrieve())
        # Try to fetch account too
        try:
            acc = await loop.run_in_executor(None, lambda: stripe_sdk.Account.retrieve())
            account_id = acc.get("id") if hasattr(acc, "get") else getattr(acc, "id", None)
            account_country = acc.get("country") if hasattr(acc, "get") else getattr(acc, "country", None)
        except Exception:
            account_id = None
            account_country = None
        livemode = bal.get("livemode") if hasattr(bal, "get") else getattr(bal, "livemode", False)
        return {
            "ok": True,
            "mode": "live" if livemode else "test",
            "accountId": account_id,
            "country": account_country,
        }
    except Exception as e:
        logger.warning(f"[stripe-test-key] failed: {e}")
        raise HTTPException(400, f"Stripe rejected key: {str(e)[:200]}")
