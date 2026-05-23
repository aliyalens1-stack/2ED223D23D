"""seed_customer_engagement.py — P2 happy-path content for customer-UI.

Заполняет три коллекции для демонстрации customer engagement-флоу:

  • chat_threads    — два provider-чата (in-progress и completed job)
                       + один support-чат с админом
  • chat_messages   — реалистичные диалоги (3–6 реплик в каждом треде)
  • service_payments— три escrow-платежа в разных статусах:
                       pending (создан, ждёт оплаты)
                       paid    (в escrow, работа идёт)
                       released (выплачено провайдеру после completed)

Связки:
  - Все три провайдера/инспектора — из существующего seed (inspectors +
    organization "Berlin Auto-Check" для support fallback).
  - Привязка к `inspection_jobs` от `seed_customer_journey.py`:
      thread #1 → job со status='inspecting' (Hamburg)
      thread #2 → job со status='done'       (Cologne)
      payment #2 (paid) → completed job
      payment #3 (released) → completed job (другое requestId)

Идемпотентность: помечаем все доки `seedTag = 'customer-engagement-demo'`
и при повторном запуске чистим старые, переcоздаём новые.

Usage:
    python /app/backend/seed_customer_engagement.py
"""
from __future__ import annotations
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(ROOT, ".env"))

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ.get("DB_NAME", "test_database")
SEED_TAG = "customer-engagement-demo"
CUSTOMER_EMAIL = "customer@test.com"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _uid() -> str:
    return str(uuid.uuid4())


async def _wipe_previous(db) -> None:
    r1 = await db.chat_threads.delete_many({"seedTag": SEED_TAG})
    r2 = await db.chat_messages.delete_many({"seedTag": SEED_TAG})
    r3 = await db.service_payments.delete_many({"seedTag": SEED_TAG})
    print(f"[wipe] threads={r1.deleted_count} msgs={r2.deleted_count} payments={r3.deleted_count}")


async def _create_thread_with_messages(
    db, *, customer_id: str, provider_slug: str | None, ttype: str,
    title: str, booking_id: str | None, dialog: list[tuple[str, str, int]],
    last_unread_by_user: bool = False,
) -> None:
    """Create one chat_thread + its messages.

    `dialog` is list of (senderType, text, minutes_ago) tuples.
    """
    tid = _uid()
    base_dt = _now() - timedelta(hours=2)
    # Insert thread first (empty), then messages, then bump.
    last_text, _, last_minutes = dialog[-1]
    last_at = _now() - timedelta(minutes=last_minutes)
    thread_doc = {
        "id": tid,
        "type": ttype,
        "participantUserId": customer_id,
        "providerSlug": provider_slug,
        "bookingId": booking_id,
        "title": title,
        "lastMessage": dialog[-1][1][:140],
        "lastMessageAt": _iso(last_at),
        "unreadByUser": last_unread_by_user,
        "unreadByOther": False,
        "createdAt": _iso(base_dt),
        "seedTag": SEED_TAG,
    }
    await db.chat_threads.insert_one(thread_doc)

    for sender_type, text, mins_ago in dialog:
        msg_dt = _now() - timedelta(minutes=mins_ago)
        sender_id = customer_id if sender_type == "user" else (provider_slug or "admin")
        await db.chat_messages.insert_one({
            "id": _uid(),
            "threadId": tid,
            "senderType": sender_type,
            "senderId": sender_id,
            "text": text,
            "createdAt": _iso(msg_dt),
            "readAt": _iso(msg_dt + timedelta(minutes=1)) if sender_type == "user" or not last_unread_by_user else None,
            "seedTag": SEED_TAG,
        })


async def _create_payment(
    db, *, customer_id: str, provider_id: str, request_id: str,
    booking_id: str, status: str, gross: int, currency: str = "EUR",
    city: str = "Berlin", category: str = "inspection",
    paid_minutes_ago: int | None = None,
    released_minutes_ago: int | None = None,
) -> str:
    """Create one service_payments row. Returns payment id."""
    commission_pct = 12.0
    commission_amount = round(gross * commission_pct / 100, 2)
    provider_payout = round(gross - commission_amount, 2)
    pay_id = _uid()
    now = _now()
    created_at = now - timedelta(hours=6)
    doc = {
        "id": pay_id,
        "requestId": request_id,
        "bidId": _uid(),
        "customerId": customer_id,
        "providerId": provider_id,
        "grossAmount": gross,
        "commissionPct": commission_pct,
        "commissionAmount": commission_amount,
        "providerPayout": provider_payout,
        "currency": currency,
        "status": status,
        "stripePaymentIntentId": f"pi_mock_{pay_id[:8]}" if status != "pending" else None,
        "stripeSessionId": f"cs_mock_{pay_id[:8]}",
        "stripeCheckoutUrl": f"https://checkout.stripe.com/mock/{pay_id[:8]}",
        "paidAt": _iso(now - timedelta(minutes=paid_minutes_ago)) if paid_minutes_ago is not None else None,
        "releasedAt": _iso(now - timedelta(minutes=released_minutes_ago)) if released_minutes_ago is not None else None,
        "refundedAt": None,
        "failureReason": None,
        "gateway": "mock",
        "createdAt": _iso(created_at),
        "updatedAt": _iso(now),
        "category": category,
        "city": city,
        "bookingId": booking_id,
        "seedTag": SEED_TAG,
    }
    await db.service_payments.insert_one(doc)
    return pay_id


async def main() -> None:
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]

    # ── Resolve actors ────────────────────────────────────────────────
    customer = await db.users.find_one({"email": CUSTOMER_EMAIL})
    if not customer:
        print(f"[ERROR] customer {CUSTOMER_EMAIL} not found. Run seed_customer_journey.py first.")
        client.close()
        return
    customer_id = str(customer.get("id") or customer.get("_id"))
    print(f"customer: {CUSTOMER_EMAIL} (id={customer_id})")

    inspectors = await db.users.find({"role": "inspector"}, {"_id": 0}).to_list(5)
    if len(inspectors) < 2:
        print(f"[ERROR] need ≥2 inspectors, found {len(inspectors)}. Run seed_customer_journey.py.")
        client.close()
        return

    # Find org slugs to use as providerSlug for provider-chat threads.
    berlin_org = await db.organizations.find_one({"city": "berlin"}, {"_id": 0, "slug": 1, "name": 1})
    cologne_org = await db.organizations.find_one({"city": "cologne"}, {"_id": 0, "slug": 1, "name": 1})
    provider_slug_1 = (berlin_org or {}).get("slug") or "berlin-auto-check"
    provider_name_1 = (berlin_org or {}).get("name") or "Berlin Auto-Check"
    provider_slug_2 = (cologne_org or {}).get("slug") or "cologne-inspector-1"
    provider_name_2 = (cologne_org or {}).get("name") or "Cologne Inspector"

    # Find seeded customer-journey jobs for binding payments.
    jobs = await db.inspection_jobs.find(
        {"customerId": customer_id, "seedTag": "customer-journey-demo"}, {"_id": 0}
    ).to_list(20)
    job_by_status = {}
    for j in jobs:
        job_by_status.setdefault(j.get("status"), j)
    in_progress_job = job_by_status.get("inspecting")
    completed_job = job_by_status.get("done")

    # ── Wipe previous run ─────────────────────────────────────────────
    await _wipe_previous(db)

    # ── Chat thread #1: provider chat, in-progress inspection ─────────
    await _create_thread_with_messages(
        db,
        customer_id=customer_id,
        provider_slug=provider_slug_1,
        ttype="provider",
        title=provider_name_1,
        booking_id=(in_progress_job or {}).get("id"),
        dialog=[
            ("user",     "Hallo, wann starten Sie die Inspektion?", 240),
            ("provider", "Guten Tag! Ich bin bereits beim Auto. Beginn in 10 Min.", 235),
            ("user",     "Super, danke! Können Sie auch die Reifen checken?", 220),
            ("provider", "Klar — Profiltiefe + Verschleiß ist Teil des 60-Punkte-Checks.", 215),
            ("user",     "Perfekt. Wie lange dauert der Check?", 60),
            ("provider", "Ca. 90 Min. Ich schicke Ihnen den Bericht direkt in die App.", 45),
        ],
        last_unread_by_user=True,
    )

    # ── Chat thread #2: provider chat, completed job (review request) ─
    await _create_thread_with_messages(
        db,
        customer_id=customer_id,
        provider_slug=provider_slug_2,
        ttype="provider",
        title=provider_name_2,
        booking_id=(completed_job or {}).get("id"),
        dialog=[
            ("provider", "Bericht ist hochgeladen. Score 8.3/10 — solid.", 4320),
            ("user",     "Vielen Dank! Sehr detailliert.", 4200),
            ("provider", "Bremsbeläge bei ~60% — in 5.000 km tauschen. Sonst alles OK.", 4180),
            ("user",     "Klar. Hatten Sie auch das Servicebuch?", 1440),
            ("provider", "Ja, vollständig. Alle Inspektionen bei Mercedes-Vertragspartner.", 1430),
        ],
        last_unread_by_user=False,
    )

    # ── Chat thread #3: support chat with admin ───────────────────────
    await _create_thread_with_messages(
        db,
        customer_id=customer_id,
        provider_slug=None,
        ttype="support",
        title="AutoSearch Support",
        booking_id=None,
        dialog=[
            ("user",  "Hi, ich kann meine Quittung nicht herunterladen. Hilfe?", 1500),
            ("admin", "Hallo Max! Wir prüfen das. Welcher Auftrag (ID oder Stadt)?", 1490),
            ("user",  "Auftrag in Cologne, completed letzte Woche.", 1480),
            ("admin", "Gefunden. Quittung als PDF wurde gerade an Ihre E-Mail gesendet.", 30),
        ],
        last_unread_by_user=True,
    )

    # ── Payment #1: pending (created, awaiting checkout) ──────────────
    p1 = await _create_payment(
        db,
        customer_id=customer_id,
        provider_id=str(inspectors[0].get("id")),
        request_id=(in_progress_job or {}).get("requestId") or _uid(),
        booking_id=(in_progress_job or {}).get("id") or _uid(),
        status="pending", gross=149, city="Hamburg",
    )

    # ── Payment #2: paid (in escrow, work in progress) ────────────────
    p2 = await _create_payment(
        db,
        customer_id=customer_id,
        provider_id=str(inspectors[0].get("id")),
        request_id=(in_progress_job or {}).get("requestId") or _uid(),
        booking_id=(in_progress_job or {}).get("id") or _uid(),
        status="paid", gross=189, city="Hamburg",
        paid_minutes_ago=120,
    )

    # ── Payment #3: released (completed + payout) ─────────────────────
    p3 = await _create_payment(
        db,
        customer_id=customer_id,
        provider_id=str(inspectors[1].get("id")) if len(inspectors) > 1 else str(inspectors[0].get("id")),
        request_id=(completed_job or {}).get("requestId") or _uid(),
        booking_id=(completed_job or {}).get("id") or _uid(),
        status="released", gross=229, city="Cologne",
        paid_minutes_ago=4200,
        released_minutes_ago=4100,
    )

    # ── Summary ───────────────────────────────────────────────────────
    threads = await db.chat_threads.count_documents({"participantUserId": customer_id, "seedTag": SEED_TAG})
    msgs = await db.chat_messages.count_documents({"seedTag": SEED_TAG})
    pays = await db.service_payments.count_documents({"customerId": customer_id, "seedTag": SEED_TAG})

    print()
    print("[seed_customer_engagement] ✅ done")
    print(f"  customer:        {CUSTOMER_EMAIL} (id={customer_id})")
    print(f"  chat_threads:    {threads}  (in-progress provider · completed provider · support)")
    print(f"  chat_messages:   {msgs}")
    print(f"  service_payments:{pays}  (pending €149 · paid €189 · released €229)")
    print(f"    p1 pending:    {p1}")
    print(f"    p2 paid:       {p2}")
    print(f"    p3 released:   {p3}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
