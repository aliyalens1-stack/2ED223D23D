"""Package catalog & credit / payment schemas."""
from __future__ import annotations
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


# Static catalog — source of truth. Server MUST compute price from here.
PACKAGE_CATALOG = [
    {
        "id": "single",
        "title": "Single inspection",
        "credits": 1,
        "price": 120,
        "currency": "EUR",
        "savings": 0,
        "badge": None,
    },
    {
        "id": "bundle_3",
        "title": "Smart bundle",
        "credits": 3,
        "price": 300,
        "currency": "EUR",
        "savings": 60,  # vs 3 × €120
        "badge": "MOST POPULAR",
    },
    {
        "id": "bundle_5",
        "title": "Buyer bundle",
        "credits": 5,
        "price": 450,
        "currency": "EUR",
        "savings": 150,  # vs 5 × €120
        "badge": "BEST VALUE",
    },
]


def get_package(package_id: str) -> Optional[dict]:
    for p in PACKAGE_CATALOG:
        if p["id"] == package_id:
            return p
    return None


class PackageOut(BaseModel):
    id: str
    title: str
    credits: int
    price: int
    currency: str
    savings: int
    badge: Optional[str] = None


class CreateCheckout(BaseModel):
    packageId: str
    provider: Literal["stripe", "paypal"]
    origin: Optional[str] = Field(default=None, description="Frontend origin for success/cancel URLs")


class CheckoutResponse(BaseModel):
    paymentId: str
    checkoutUrl: str
    provider: str


class CreditBalanceOut(BaseModel):
    userId: Optional[str] = None
    balance: int
    reserved: int
    used: int
    available: int  # balance - reserved


class LedgerEntryOut(BaseModel):
    id: str
    userId: Optional[str] = None
    type: str  # purchase | reserve | release | consume | admin_adjust
    delta: int
    requestId: Optional[str] = None
    jobId: Optional[str] = None
    paymentId: Optional[str] = None
    note: Optional[str] = None
    createdAt: str


class AdminAdjustCredits(BaseModel):
    userId: str
    delta: int
    note: Optional[str] = None


class PaymentOut(BaseModel):
    id: str
    userId: Optional[str] = None
    packageId: str
    credits: int
    amount: int
    currency: str
    provider: str
    status: str  # pending | paid | failed | canceled
    sessionId: Optional[str] = None
    createdAt: str
    paidAt: Optional[str] = None
