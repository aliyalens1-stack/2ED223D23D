"""Service Marketplace — модели и константы.

Pydantic-схемы для service_requests и service_bids.
Жёсткий enum категорий и статусов, чтобы исключить рассинхрон между
mobile / admin / backend.
"""
from __future__ import annotations
from typing import Optional, Literal
from pydantic import BaseModel, Field, ConfigDict


# ── Категории услуг ───────────────────────────────────────────────────────
# 9 категорий, покрывающих весь автомобильный сервис.
ServiceCategory = Literal[
    "repair",          # ремонт / диагностика
    "tow",             # эвакуатор
    "wash",            # мойка
    "detailing",       # детейлинг
    "battery",         # замена аккумулятора, выезд на запуск
    "parts",           # запчасти
    "delivery",        # пригон / доставка авто
    "inspection",      # предпокупочный осмотр
    "car_selection",   # подбор авто
]

CATEGORY_LIST: list[str] = list(ServiceCategory.__args__)  # type: ignore[attr-defined]

# Метаданные категорий для UI + ценообразование (минимальный бюджет).
CATEGORY_META: dict[str, dict] = {
    "repair":        {"emoji": "🔧", "title_ru": "Ремонт",          "title_en": "Repair",           "title_de": "Reparatur",         "min_budget": 50,  "default_commission_pct": 12},
    "tow":           {"emoji": "🚛", "title_ru": "Эвакуатор",       "title_en": "Tow truck",         "title_de": "Abschleppdienst",   "min_budget": 60,  "default_commission_pct": 10},
    "wash":          {"emoji": "🚿", "title_ru": "Мойка",           "title_en": "Wash",              "title_de": "Autowäsche",        "min_budget": 15,  "default_commission_pct": 15, "default_lead_fee": 3},
    "detailing":     {"emoji": "✨", "title_ru": "Детейлинг",       "title_en": "Detailing",         "title_de": "Detailing",         "min_budget": 80,  "default_commission_pct": 12},
    "battery":       {"emoji": "🔋", "title_ru": "Аккумулятор",     "title_en": "Battery",           "title_de": "Batterie",          "min_budget": 80,  "default_commission_pct": 12},
    "parts":         {"emoji": "🔩", "title_ru": "Запчасти",        "title_en": "Parts",             "title_de": "Ersatzteile",       "min_budget": 20,  "default_commission_pct": 10},
    "delivery":      {"emoji": "🚚", "title_ru": "Пригон авто",     "title_en": "Car delivery",      "title_de": "Fahrzeugüberführung", "min_budget": 200, "default_commission_pct": 8},
    "inspection":    {"emoji": "🛡", "title_ru": "Осмотр перед покупкой", "title_en": "Pre-purchase inspection", "title_de": "Vorkaufprüfung", "min_budget": 120, "default_commission_pct": 15},
    "car_selection": {"emoji": "🎯", "title_ru": "Подбор авто",     "title_en": "Car selection",     "title_de": "Fahrzeugauswahl",   "min_budget": 150, "default_commission_pct": 12},
}

# ── Статусы заявки ────────────────────────────────────────────────────────
# Sprint 3A — добавлены escrow-статусы: awaiting_payment / paid / released.
# Жизненный цикл:
#   open → bidding → awaiting_payment → paid → in_progress → completed → released
#                                  ↘ failed → cancelled
RequestStatus = Literal[
    "open",              # опубликована, ждёт откликов
    "bidding",           # есть один или больше bid'ов
    "awaiting_payment",  # Sprint 3A: bid accepted, ждём оплаты клиентом
    "paid",              # Sprint 3A: оплачено, деньги в escrow
    "assigned",          # legacy alias: до Sprint 3A — после accept-bid
    "in_progress",       # работа началась
    "completed",         # работа завершена клиентом/провайдером
    "released",          # Sprint 3A: escrow освобождён, payout исполнителю ready
    "cancelled",         # отменена клиентом или админом
    "expired",           # никто не откликнулся в срок (TTL)
    "disputed",          # спор — на ручной обработке у админа
]

BidStatus = Literal[
    "submitted",     # ставка подана
    "accepted",      # клиент принял
    "rejected",      # клиент отклонил
    "withdrawn",     # исполнитель отозвал
    "expired",       # заявка ушла другому → ставка истекла
]

Urgency = Literal["normal", "urgent", "emergency"]


# ── Модели запросов / ответов ─────────────────────────────────────────────
class GeoPoint(BaseModel):
    lat: float
    lng: float
    address: Optional[str] = None


class Budget(BaseModel):
    min: Optional[int] = None
    max: Optional[int] = None
    currency: str = "EUR"


class CreateRequestBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    category: ServiceCategory
    title: Optional[str] = Field(None, max_length=120)
    description: str = Field(..., min_length=3, max_length=2000)
    city: str = Field(..., min_length=2, max_length=64)
    location: Optional[GeoPoint] = None
    urgency: Urgency = "normal"
    budget: Optional[Budget] = None
    photos: list[str] = Field(default_factory=list, max_length=10)   # base64 или URL
    contactPhone: Optional[str] = Field(None, max_length=32)  # хранится скрыто, открывается после accept


class CreateBidBody(BaseModel):
    model_config = ConfigDict(extra="ignore")

    price: int = Field(..., ge=1, le=100000)
    currency: str = "EUR"
    message: str = Field(..., min_length=1, max_length=1000)
    etaMinutes: Optional[int] = Field(None, ge=5, le=10080)  # ETA в минутах (до 7 дней)


class AssignBody(BaseModel):
    providerId: str
    note: Optional[str] = Field(None, max_length=500)


class UpdateStatusBody(BaseModel):
    status: RequestStatus
    note: Optional[str] = Field(None, max_length=500)


# ── Хелперы для проекций ──────────────────────────────────────────────────
PUBLIC_REQUEST_FIELDS = {
    "_id": 0,
    "id": 1, "category": 1, "title": 1, "description": 1,
    "city": 1, "location": 1, "urgency": 1, "budget": 1,
    "photos": 1, "status": 1, "createdAt": 1, "updatedAt": 1,
    "bidsCount": 1, "acceptedBidId": 1, "expiresAt": 1,
    # ВАЖНО: customerId / customerName / contactPhone не открываем публично
}

OWNER_REQUEST_FIELDS = {**PUBLIC_REQUEST_FIELDS, "customerId": 1, "customerName": 1, "contactPhone": 1, "assignedProviderId": 1}

BID_PUBLIC_FIELDS = {
    "_id": 0,
    "id": 1, "requestId": 1, "providerId": 1, "providerName": 1, "providerRating": 1,
    "price": 1, "currency": 1, "message": 1, "etaMinutes": 1,
    "status": 1, "createdAt": 1,
    # ВАЖНО: providerPhone / providerEmail скрыты до accept
}
