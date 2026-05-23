"""Sprint 4 — Pydantic models + status constants for service chat.

Жёсткие enum'ы для type / role / event kind — чтобы UI/admin/backend
никогда не разъезжались на строковых литералах.
"""
from __future__ import annotations
from typing import Literal, Optional
from pydantic import BaseModel, Field, ConfigDict


# ── Chat lifecycle ────────────────────────────────────────────────────────
ChatStatus = Literal["active", "closed", "frozen"]
# active = живой; closed = после release (можно читать, нельзя писать);
# frozen = админ приостановил расследование

SenderRole = Literal["customer", "provider", "system", "admin"]

MessageType = Literal[
    "text",            # обычное сообщение
    "image",           # фото (base64)
    "location",        # координаты
    "system",          # автоматическое (типа «Bid accepted», «Payment received»)
    "invoice",         # ссылка на платёж / дополнительный invoice
    "status_change",   # «работа началась», «нужны запчасти»
]

QuickActionKind = Literal[
    "arriving",          # «Уже еду»
    "work_started",      # «Работа началась»
    "extra_parts",       # «Нужны запчасти»
    "completed",         # «Работа выполнена» (провайдер)
    "confirm_completed", # клиент подтверждает завершение
]


# ── Timeline events ───────────────────────────────────────────────────────
TimelineKind = Literal[
    "request_created",
    "provider_matched",
    "bid_accepted",
    "payment_secured",
    "chat_opened",
    "provider_en_route",
    "work_started",
    "extra_parts_requested",
    "work_completed",
    "release_confirmed",
    "escrow_released",
    "request_cancelled",
]


# ── Request bodies ────────────────────────────────────────────────────────
class SendMessageBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    type: MessageType = "text"
    body: Optional[str] = Field(None, max_length=4000)
    mediaBase64: Optional[str] = Field(None, max_length=2_000_000)  # ~1.5 MB raw
    location: Optional[dict] = None  # {lat, lng, label?}


class QuickActionBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    action: QuickActionKind
    note: Optional[str] = Field(None, max_length=500)


class ModerateBody(BaseModel):
    """Admin moderation action."""
    model_config = ConfigDict(extra="ignore")
    action: Literal["warn", "shadow_hide_message", "strike_provider", "freeze_chat", "unfreeze_chat"]
    messageId: Optional[str] = None
    reason: Optional[str] = Field(None, max_length=500)


# ── Anti-bypass severity levels ───────────────────────────────────────────
# `warn` → пользователь видит inline-warning, сообщение проходит
# `shadow_hide` → отправитель видит, получатель НЕ видит (тише репутации)
# `block` → сообщение не сохраняется, возвращается 400 с понятным error
BypassSeverity = Literal["clean", "warn", "shadow_hide", "block"]
