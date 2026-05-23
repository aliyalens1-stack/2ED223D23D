"""Sprint 4 — Real-Time Communication Layer for Service Marketplace.

ОТДЕЛЬНЫЙ bounded context от `app/chat/` (тот для booking/support).
Этот живёт поверх service_marketplace + escrow:

  Collections:
    service_chats          — 1 chat = 1 request (создан при payment.paid)
    service_messages       — text / image / location / system / status / invoice
    request_timeline_events — append-only event log заявки (single source of truth)

  Transport: polling (5–10 s). Никаких websockets/socket.io/redis-streams.
  Anti-bypass: regex-scanner на каждом сообщении (телефоны, мейлы, ссылки,
               WhatsApp/Telegram keywords) → flag/shadow-hide/strike.
"""
from .router import service_chat_router
from .router_admin import admin_chats_router
from .timeline import timeline_router

__all__ = ["service_chat_router", "admin_chats_router", "timeline_router"]
