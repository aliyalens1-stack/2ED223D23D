"""Helper для опциональной аутентификации: если пользователь авторизован — вернуть sub; иначе None."""
from __future__ import annotations
from typing import Optional

import jwt
from fastapi import Request
from app.core.config import JWT_SECRET, JWT_ALGO


def get_user_id_optional(request: Request):
    """Возвращает user id (sub) из Bearer-токена если он валиден, иначе None."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("sub") or payload.get("userId") or payload.get("email")
    except jwt.PyJWTError:
        return None


def get_user_kind_optional(request: Request) -> Optional[str]:
    """Sprint 1D.3: возвращает `account.kind` из JWT (claim установлен 1C
    `issue_account_jwt` из `account.kind`). Использовать для admin-checks
    вместо легаси `role == "admin"` — `kind` отражает АКТИВНЫЙ аккаунт,
    а не статичный legacy role, и переключится корректно после 1E
    (account-switcher)."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return None
    try:
        payload = jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
        return payload.get("kind")
    except jwt.PyJWTError:
        return None


def get_user_id_required(request: Request):
    """Как required, но поднимает 401 если токена нет."""
    uid = get_user_id_optional(request)
    if not uid:
        from fastapi import HTTPException
        raise HTTPException(status_code=401, detail="authentication required")
    return uid
