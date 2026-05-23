"""app.integrations.credentials_service — Mongo-backed credential store.

Single source of truth for all third-party provider credentials.
Encryption at rest via Fernet (symmetric, key from INTEGRATIONS_FERNET_KEY
env var; auto-generated on first boot and persisted to backend/.env if missing).
Hot-reload via per-provider TTL cache, invalidated on upsert.

Collection schema (`integration_credentials`):
  {
    "_id": "<provider>",            # e.g. "stripe", "paypal", "firebase_push"
    "mode": "test" | "live",
    "enabled": bool,
    "encrypted_payload": <bytes>,   # Fernet-encrypted JSON
    "updated_at": iso8601,
    "updated_by": "<user_id or 'seed'>",
  }
"""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger(__name__)

_COLLECTION = "integration_credentials"
_CACHE_TTL_SECONDS = 30  # short — admin updates take effect ~immediately

# In-memory cache: provider -> (record, expires_at)
_cache: dict[str, tuple[dict, float]] = {}


# ─────────────────────────────────────────────────────────────────────
# Fernet key bootstrap
# ─────────────────────────────────────────────────────────────────────

def _get_fernet() -> Fernet:
    """Load or bootstrap the symmetric encryption key."""
    key = os.environ.get("INTEGRATIONS_FERNET_KEY")
    if not key:
        # Bootstrap: generate a key, write to backend/.env, set in environ
        key_bytes = Fernet.generate_key()
        key = key_bytes.decode("ascii")
        env_path = "/app/backend/.env"
        try:
            with open(env_path, "a", encoding="utf-8") as fh:
                fh.write(f"\nINTEGRATIONS_FERNET_KEY={key}\n")
            logger.info("integrations: generated Fernet key, persisted to backend/.env")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"integrations: could not persist Fernet key (non-fatal): {e}")
        os.environ["INTEGRATIONS_FERNET_KEY"] = key
    return Fernet(key.encode("ascii") if isinstance(key, str) else key)


# ─────────────────────────────────────────────────────────────────────
# Mask helpers
# ─────────────────────────────────────────────────────────────────────

def _mask_value(v: str) -> str:
    """Mask a secret-looking value for admin GET responses."""
    if not isinstance(v, str) or len(v) <= 8:
        return "***"
    return f"{v[:4]}...{v[-4:]}"


def mask_payload(payload: dict) -> dict:
    """Return a copy of the payload with secret-like fields masked."""
    secret_keys = {
        "secret_key", "restricted_key", "webhook_secret", "client_secret",
        "api_key", "private_key", "password", "service_account_json",
        "access_token", "refresh_token",
    }
    return {
        k: (_mask_value(v) if (k in secret_keys and isinstance(v, str)) else v)
        for k, v in payload.items()
    }


# ─────────────────────────────────────────────────────────────────────
# Encrypt / decrypt
# ─────────────────────────────────────────────────────────────────────

def _encrypt_payload(payload: dict) -> bytes:
    fernet = _get_fernet()
    raw = json.dumps(payload, default=str).encode("utf-8")
    return fernet.encrypt(raw)


def _decrypt_payload(blob: bytes) -> dict:
    fernet = _get_fernet()
    try:
        raw = fernet.decrypt(blob if isinstance(blob, bytes) else bytes(blob))
        return json.loads(raw.decode("utf-8"))
    except InvalidToken:
        logger.error("integrations: Fernet decryption failed — key mismatch or corruption")
        return {}


# ─────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────

async def get(provider: str, *, db) -> Optional[dict]:
    """Return decrypted record for provider, using cache. None if absent.

    Returned shape:
      {
        "provider": "stripe",
        "mode": "test",
        "enabled": True,
        "payload": {<decrypted dict>},
        "updated_at": "...",
        "updated_by": "...",
      }
    """
    import time
    now = time.monotonic()
    cached = _cache.get(provider)
    if cached and cached[1] > now:
        return cached[0]

    doc = await db[_COLLECTION].find_one({"_id": provider}, {"_id": 0,
                                                              "mode": 1,
                                                              "enabled": 1,
                                                              "encrypted_payload": 1,
                                                              "updated_at": 1,
                                                              "updated_by": 1})
    if not doc:
        return None
    payload = _decrypt_payload(doc.get("encrypted_payload", b""))
    record = {
        "provider": provider,
        "mode": doc.get("mode", "test"),
        "enabled": bool(doc.get("enabled", False)),
        "payload": payload,
        "updated_at": doc.get("updated_at"),
        "updated_by": doc.get("updated_by"),
    }
    _cache[provider] = (record, now + _CACHE_TTL_SECONDS)
    return record


async def list_summaries(*, db) -> list[dict]:
    """List ALL providers with MASKED payloads for admin UI."""
    out = []
    async for doc in db[_COLLECTION].find({}, {"encrypted_payload": 1,
                                                 "mode": 1,
                                                 "enabled": 1,
                                                 "updated_at": 1,
                                                 "updated_by": 1}):
        provider = doc.get("_id")
        payload = _decrypt_payload(doc.get("encrypted_payload", b""))
        out.append({
            "provider": provider,
            "mode": doc.get("mode", "test"),
            "enabled": bool(doc.get("enabled", False)),
            "payload": mask_payload(payload),
            "updated_at": doc.get("updated_at"),
            "updated_by": doc.get("updated_by"),
        })
    return sorted(out, key=lambda r: r["provider"])


async def upsert(
    provider: str,
    payload: dict,
    *,
    mode: str = "test",
    enabled: bool = True,
    actor: str = "admin",
    db,
) -> dict:
    """Upsert credentials for a provider. Returns the masked record."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a dict")
    encrypted = _encrypt_payload(payload)
    updated_at = datetime.now(timezone.utc).isoformat()
    await db[_COLLECTION].update_one(
        {"_id": provider},
        {"$set": {
            "mode": mode,
            "enabled": bool(enabled),
            "encrypted_payload": encrypted,
            "updated_at": updated_at,
            "updated_by": actor,
        }},
        upsert=True,
    )
    _cache.pop(provider, None)
    logger.info(f"integrations: upserted provider={provider} mode={mode} enabled={enabled} actor={actor}")
    return {
        "provider": provider,
        "mode": mode,
        "enabled": enabled,
        "payload": mask_payload(payload),
        "updated_at": updated_at,
        "updated_by": actor,
    }


async def set_enabled(provider: str, enabled: bool, *, actor: str, db) -> bool:
    """Toggle enabled flag without rotating keys. Returns new state."""
    res = await db[_COLLECTION].update_one(
        {"_id": provider},
        {"$set": {
            "enabled": bool(enabled),
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "updated_by": actor,
        }},
    )
    if res.matched_count == 0:
        raise KeyError(f"provider '{provider}' not configured")
    _cache.pop(provider, None)
    logger.info(f"integrations: toggle provider={provider} enabled={enabled} actor={actor}")
    return bool(enabled)


def invalidate_cache(provider: Optional[str] = None) -> None:
    if provider is None:
        _cache.clear()
    else:
        _cache.pop(provider, None)


__all__ = [
    "get",
    "list_summaries",
    "upsert",
    "set_enabled",
    "invalidate_cache",
    "mask_payload",
]
