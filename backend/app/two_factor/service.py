"""app.two_factor.service — TOTP service primitives.

Pure functions for:
  - generate_secret      → random Base32 (pyotp)
  - build_provisioning_uri → otpauth:// URI (Google Authenticator compatible)
  - qr_code_base64       → base64-encoded PNG of the QR
  - verify_code          → verify a submitted TOTP with clock-skew window
  - encrypt_secret / decrypt_secret → Fernet at-rest encryption
  - generate_recovery_code_batch → 10 single-use codes (bcrypt-hashed)
  - verify_recovery_code → constant-time bcrypt compare
"""
from __future__ import annotations
import base64
import io
import os
import secrets
from datetime import datetime, timezone
from typing import List, Tuple

import bcrypt
import pyotp
import qrcode
from cryptography.fernet import Fernet


# ── encryption at rest ────────────────────────────────────────────────
_FERNET_KEY = os.getenv("TOTP_FERNET_KEY")
if not _FERNET_KEY:
    # Allow boot but every call will explicitly raise.
    _fernet = None
else:
    _fernet = Fernet(_FERNET_KEY.encode() if isinstance(_FERNET_KEY, str) else _FERNET_KEY)


def _require_fernet() -> Fernet:
    if _fernet is None:
        raise RuntimeError("TOTP_FERNET_KEY env var not set — 2FA disabled")
    return _fernet


def encrypt_secret(plain: str) -> str:
    return _require_fernet().encrypt(plain.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str:
    return _require_fernet().decrypt(token.encode("utf-8")).decode("utf-8")


# ── TOTP primitives ───────────────────────────────────────────────────
TOTP_PERIOD = 30
TOTP_DIGITS = 6
ISSUER_NAME = "Auto Search"


def generate_secret() -> str:
    return pyotp.random_base32()


def build_provisioning_uri(secret: str, account_label: str, issuer: str = ISSUER_NAME) -> str:
    totp = pyotp.TOTP(secret, interval=TOTP_PERIOD, digits=TOTP_DIGITS)
    return totp.provisioning_uri(name=account_label, issuer_name=issuer)


def qr_code_base64(data: str) -> str:
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def verify_code(encrypted_secret: str, code: str, window: int = 1) -> bool:
    """Verify a TOTP code. `window=1` allows ±30s clock drift."""
    if not code or not encrypted_secret:
        return False
    code = code.replace(" ", "").strip()
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return False
    try:
        secret = decrypt_secret(encrypted_secret)
    except Exception:
        return False
    totp = pyotp.TOTP(secret, interval=TOTP_PERIOD, digits=TOTP_DIGITS)
    return bool(totp.verify(code, valid_window=window))


# ── recovery codes ────────────────────────────────────────────────────
_RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no O, I, 0, 1
_RECOVERY_LEN = 10  # 10-char codes (≈49 bits entropy)
_RECOVERY_COUNT = 10  # generate 10 codes


def generate_recovery_code() -> str:
    return "".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(_RECOVERY_LEN))


def hash_recovery_code(code: str) -> str:
    # bcrypt for parity with password hashing
    return bcrypt.hashpw(code.upper().encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_recovery_code(code: str, code_hash: str) -> bool:
    try:
        return bcrypt.checkpw(code.upper().encode("utf-8"), code_hash.encode("utf-8"))
    except Exception:
        return False


def generate_recovery_code_batch() -> Tuple[List[str], List[dict]]:
    """Return (plain_codes, stored_docs). Plain codes shown to user ONCE."""
    plain: List[str] = []
    stored: List[dict] = []
    now = datetime.now(timezone.utc)
    for _ in range(_RECOVERY_COUNT):
        code = generate_recovery_code()
        plain.append(code)
        stored.append({
            "codeHash": hash_recovery_code(code),
            "used": False,
            "createdAt": now,
            "usedAt": None,
        })
    return plain, stored


# ── challenge token ────────────────────────────────────────────────────
def generate_challenge_token() -> str:
    return secrets.token_urlsafe(32)
