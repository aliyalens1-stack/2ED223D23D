"""Booking lifecycle — actor-scoped semantic projections.

Same truth, different vocabulary per actor. This module is purely
read-side: it never mutates state.

The canonical state lives on the booking doc (`status` field).
For each actor we expose:

  * label        — human label in this actor's domain language
  * stage        — coarse stage (queue | active | finished)
  * description  — one-sentence narrative
  * canSee       — what facts about the booking this actor is permitted to see
                   (this is informational; gating happens in the endpoint layer)

We deliberately DO NOT expose `legalActions` per actor here. Action
authorization lives in the endpoint guards; the projection answers only
"what does this state mean for me".
"""
from __future__ import annotations
from typing import Dict, Literal


ActorRole = Literal["customer", "provider", "inspector", "admin", "system"]


_STAGE_BY_STATE: Dict[str, str] = {
    "requested":    "queue",
    "matched":      "queue",
    "confirmed":    "active",
    "on_route":     "active",
    "arrived":      "active",
    "in_progress":  "active",
    "completed":    "finished",
    "cancelled":    "finished",
    "disputed":     "active",
    "resolved":     "finished",
}


# Customer-facing labels — the "what should I do / wait for" narrative.
_CUSTOMER: Dict[str, Dict[str, str]] = {
    "requested":   {"label": "Ожидает подбора",       "description": "Мы ищем исполнителя под ваш запрос."},
    "matched":     {"label": "Исполнитель назначен",  "description": "Назначен исполнитель. Подтверждение в работу скоро."},
    "confirmed":   {"label": "Подтверждено",           "description": "Исполнитель подтвердил выезд."},
    "on_route":    {"label": "В пути",                 "description": "Исполнитель направляется к вам."},
    "arrived":     {"label": "Прибыл",                 "description": "Исполнитель на месте."},
    "in_progress": {"label": "Работа идёт",            "description": "Работа выполняется. Дождитесь отчёта."},
    "completed":   {"label": "Завершено",              "description": "Работа завершена. Можно оставить отзыв."},
    "cancelled":   {"label": "Отменено",               "description": "Заявка отменена."},
    "disputed":    {"label": "Спор открыт",            "description": "Открыт спор. Команда поддержки разбирается."},
    "resolved":    {"label": "Спор закрыт",            "description": "Спор разрешён."},
}

# Provider-facing labels — operational narrative.
_PROVIDER: Dict[str, Dict[str, str]] = {
    "requested":   {"label": "В очереди матчинга",     "description": "Системный матчинг подбирает исполнителя."},
    "matched":     {"label": "Назначено вам",          "description": "Вы получили запрос. Подтвердите выезд."},
    "confirmed":   {"label": "Подтверждено",            "description": "Готовьтесь к выезду."},
    "on_route":    {"label": "Вы в пути",               "description": "Двигайтесь к клиенту."},
    "arrived":     {"label": "Вы на месте",             "description": "Начинайте работу."},
    "in_progress": {"label": "Работа идёт",             "description": "Завершите по протоколу."},
    "completed":   {"label": "Завершено",               "description": "Заказ закрыт. Ожидайте payout."},
    "cancelled":   {"label": "Отменено",                "description": "Заявка отменена."},
    "disputed":    {"label": "Открыт спор",             "description": "Подайте доказательства в течение SLA."},
    "resolved":    {"label": "Спор закрыт",             "description": "Решение администрации в силе."},
}

# Inspector — same vocabulary as provider with terminology specifics.
_INSPECTOR: Dict[str, Dict[str, str]] = {
    "requested":   {"label": "Ожидает назначения",      "description": "Будете уведомлены при назначении."},
    "matched":     {"label": "Назначено вам",           "description": "Подтвердите выезд на осмотр."},
    "confirmed":   {"label": "Выезд подтверждён",        "description": "Прибудьте в согласованное время."},
    "on_route":    {"label": "В пути",                   "description": "Двигайтесь на объект."},
    "arrived":     {"label": "На объекте",               "description": "Начните осмотр."},
    "in_progress": {"label": "Осмотр идёт",              "description": "Завершите чек-лист и отправьте отчёт."},
    "completed":   {"label": "Осмотр завершён",          "description": "Отчёт отправлен. Ожидайте payout."},
    "cancelled":   {"label": "Отменено",                  "description": "Осмотр отменён."},
    "disputed":    {"label": "Спор по отчёту",            "description": "Ответьте на запрос команды поддержки."},
    "resolved":    {"label": "Спор закрыт",                "description": "Решение администрации в силе."},
}

# Admin — full truth, neutral language.
_ADMIN: Dict[str, Dict[str, str]] = {
    s: {"label": s, "description": ""} for s in _STAGE_BY_STATE
}


_TABLES: Dict[ActorRole, Dict[str, Dict[str, str]]] = {
    "customer":  _CUSTOMER,
    "provider":  _PROVIDER,
    "inspector": _INSPECTOR,
    "admin":     _ADMIN,
    "system":    _ADMIN,
}


# Visibility rules — what each actor can see. Booleans, no graph.
_CAN_SEE = {
    "customer":  {"otherPartyId": False, "internalNotes": False, "providerCost": False, "platformCut": False},
    "provider":  {"otherPartyId": True,  "internalNotes": False, "providerCost": True,  "platformCut": False},
    "inspector": {"otherPartyId": True,  "internalNotes": False, "providerCost": True,  "platformCut": False},
    "admin":     {"otherPartyId": True,  "internalNotes": True,  "providerCost": True,  "platformCut": True},
    "system":    {"otherPartyId": True,  "internalNotes": True,  "providerCost": True,  "platformCut": True},
}


def project_for_actor(state: str, actor_role: ActorRole) -> Dict[str, object]:
    """Return narrowed projection of a booking state for the given actor."""
    table = _TABLES.get(actor_role, _ADMIN)
    cell = table.get(state, {"label": state, "description": ""})
    return {
        "state": state,
        "stage": _STAGE_BY_STATE.get(state, "active"),
        "label": cell["label"],
        "description": cell["description"],
        "canSee": _CAN_SEE.get(actor_role, _CAN_SEE["customer"]),
    }
