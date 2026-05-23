"""Sprint 3A — Service Payments router.

Endpoints:
  POST /api/service-payments/{id}/checkout        — создать checkout-сессию
  GET  /api/service-payments/me                    — мои платежи (customer)
  GET  /api/service-payments/{id}                  — детали платежа (customer/provider/admin)
  POST /api/service-payments/{id}/release          — провайдер/админ: release escrow
                                                      (когда заявка completed)
  POST /api/payments/webhook/stripe                — payment_intent.succeeded и др.

Helpers (used from service_marketplace.router_customer.accept-bid):
  create_payment_for_bid(req, bid)  — создаёт ServicePayment запись + возвращает doc
"""
from __future__ import annotations
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Request

from app.core.utils import now_utc, uid
from app.core.db import get_db
from app.core.security import verify_user_token
from .models import CheckoutBody, WebhookBody, ReleaseBody
from .gateway import get_gateway


logger = logging.getLogger(__name__)

customer_payments_router = APIRouter(tags=["escrow:payments"])
webhook_router = APIRouter(tags=["escrow:webhook"])


# ── Helpers (reused from service_marketplace.accept_bid) ─────────────────
async def create_payment_for_bid(
    *,
    request_doc: dict,
    bid_doc: dict,
    db,
) -> dict:
    """Создаёт запись service_payments в статусе pending.

    Структура соответствует spec из Sprint 3A:
      requestId, bidId, customerId, providerId, grossAmount, commissionPct,
      commissionAmount, providerPayout, currency, status='pending', ...
    """
    gross = int(bid_doc.get("price") or 0)
    commission_pct = float(request_doc.get("commissionPct") or 12)
    commission_amount = round(gross * commission_pct / 100, 2)
    provider_payout = round(gross - commission_amount, 2)
    currency = bid_doc.get("currency") or "EUR"

    now = now_utc().isoformat()
    pay_id = uid()
    doc = {
        "id": pay_id,
        "requestId": request_doc.get("id"),
        "bidId": bid_doc.get("id"),
        "customerId": request_doc.get("customerId"),
        "providerId": bid_doc.get("providerId"),
        "grossAmount": gross,
        "commissionPct": commission_pct,
        "commissionAmount": commission_amount,
        "providerPayout": provider_payout,
        "currency": currency,
        "status": "pending",
        "stripePaymentIntentId": None,
        "stripeSessionId": None,
        "stripeCheckoutUrl": None,
        "paidAt": None,
        "releasedAt": None,
        "refundedAt": None,
        "failureReason": None,
        "gateway": "mock",
        "createdAt": now,
        "updatedAt": now,
        # Категория и город копируются для удобства revenue dashboard
        "category": request_doc.get("category"),
        "city": request_doc.get("city"),
    }
    await db.service_payments.insert_one(dict(doc))
    doc.pop("_id", None)
    logger.info(
        f"[escrow] created payment {pay_id} for request={doc['requestId']} "
        f"gross=€{gross} commission=€{commission_amount} payout=€{provider_payout}"
    )
    return doc


def _public_payment(doc: dict) -> dict:
    """Очищаем _id и stale-поля перед отдачей наружу."""
    out = {k: v for k, v in doc.items() if k != "_id"}
    return out


async def _resolve_role(request: Request) -> dict:
    """Возвращает payload или 401."""
    return await verify_user_token(request)


# ── POST /api/service-payments/{id}/checkout ──────────────────────────────
@customer_payments_router.post("/api/service-payments/{payment_id}/checkout")
async def create_checkout(
    payment_id: str,
    body: CheckoutBody,
    request: Request,
):
    """Создать checkout-сессию у gateway.

    Доступ: только владелец заявки (customer).

    Возвращает {checkoutUrl, sessionId, payment}. Idempotent: если URL уже
    создан и платёж pending — возвращает существующую сессию.
    """
    payload = await _resolve_role(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")
    if pay.get("customerId") != user_id:
        raise HTTPException(403, "Only payment owner can create checkout")
    if pay.get("status") not in ("pending", "failed"):
        # Если уже оплачено — возвращаем 409, чтобы клиент не пытался платить дважды.
        raise HTTPException(409, f"Payment is already {pay['status']}")

    # Idempotent: если уже есть валидный checkout URL — возвращаем его.
    if pay.get("stripeCheckoutUrl") and pay.get("status") == "pending":
        return {
            "payment": _public_payment(pay),
            "checkoutUrl": pay["stripeCheckoutUrl"],
            "sessionId": pay.get("stripeSessionId"),
            "reused": True,
        }

    gateway = get_gateway()
    session = gateway.create_checkout_session(
        payment_id=payment_id,
        amount_cents=int(pay["grossAmount"] * 100),
        currency=pay["currency"],
        description=f"Service request {pay['requestId']}",
        return_url=body.returnUrl,
        cancel_url=body.cancelUrl,
        metadata={
            "paymentId": payment_id,
            "requestId": pay["requestId"],
            "bidId": pay.get("bidId"),
        },
    )
    now = now_utc().isoformat()
    await db.service_payments.update_one(
        {"id": payment_id},
        {"$set": {
            "stripeSessionId": session["sessionId"],
            "stripePaymentIntentId": session["paymentIntentId"],
            "stripeCheckoutUrl": session["checkoutUrl"],
            "status": "pending",
            "updatedAt": now,
        }},
    )
    pay.update({
        "stripeSessionId": session["sessionId"],
        "stripePaymentIntentId": session["paymentIntentId"],
        "stripeCheckoutUrl": session["checkoutUrl"],
        "updatedAt": now,
    })
    return {
        "payment": _public_payment(pay),
        "checkoutUrl": session["checkoutUrl"],
        "sessionId": session["sessionId"],
        "reused": False,
    }


# ── GET /api/service-payments/me ──────────────────────────────────────────
@customer_payments_router.get("/api/service-payments/me")
async def my_payments(request: Request, limit: int = 50):
    """Список платежей текущего пользователя (как клиента ИЛИ как провайдера)."""
    payload = await _resolve_role(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    cursor = db.service_payments.find(
        {"$or": [{"customerId": user_id}, {"providerId": user_id}]},
        {"_id": 0},
    ).sort("createdAt", -1).limit(limit)
    items = await cursor.to_list(limit)
    return {"payments": items, "total": len(items)}


# ── GET /api/service-payments/{id} ────────────────────────────────────────
@customer_payments_router.get("/api/service-payments/{payment_id}")
async def get_payment(payment_id: str, request: Request):
    """Детали платежа. Доступ: customer-владелец, provider-получатель, admin."""
    payload = await _resolve_role(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")
    if role != "admin" and user_id not in (pay.get("customerId"), pay.get("providerId")):
        raise HTTPException(403, "Forbidden")
    return {"payment": _public_payment(pay)}


# ── POST /api/service-payments/{id}/release ───────────────────────────────
@customer_payments_router.post("/api/service-payments/{payment_id}/release")
async def release_escrow(
    payment_id: str,
    body: ReleaseBody,
    request: Request,
):
    """Освободить escrow для провайдера.

    Кто может: customer-владелец (когда заявка completed), provider (когда
    клиент отметил completed) или admin (override).

    Эффекты:
      payment.status: paid → released
      request.status: completed → released (если не админ-override)
    """
    payload = await _resolve_role(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")

    if role != "admin" and user_id not in (pay.get("customerId"), pay.get("providerId")):
        raise HTTPException(403, "Forbidden")

    # P0.b.C.g — chronology: record the release REQUEST attempt up-front.
    # Side-effect; never fails the request.
    try:
        from app.payments.chronology.writer import append_payment_event
        await append_payment_event(
            db, payment_id=payment_id, kind="escrow.release_requested",
            actor_id=str(user_id or "platform"),
            actor_role=("admin" if role == "admin"
                       else "customer" if user_id == pay.get("customerId")
                       else "provider" if user_id == pay.get("providerId")
                       else "platform"),
            meta={
                "amount": pay.get("providerPayout"),
                "currency": pay.get("currency", "EUR"),
            },
        )
    except Exception as e:
        logger.warning(f"[chronology] release_requested append failed: {e}")

    # Sprint 6 — block release if an open dispute exists for this request.
    # This must run BEFORE the paid-only check so a 'disputed' payment
    # surfaces the dispute (409 with disputeId) instead of a generic
    # "Cannot release" 400.
    open_dispute = await db.disputes.find_one(
        {"requestId": pay["requestId"], "status": {"$in": ["open", "in_review"]}},
        {"_id": 0, "id": 1},
    )
    if open_dispute and role != "admin":
        # P0.b.C.g — chronology: explicit rejection row with structured reason.
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="escrow.release_rejected",
                actor_id="platform", actor_role="platform",
                meta={"reason": "dispute_open", "disputeId": open_dispute["id"]},
            )
        except Exception as e:
            logger.warning(f"[chronology] release_rejected (dispute) append failed: {e}")
        raise HTTPException(
            409,
            f"Escrow locked: open dispute {open_dispute['id']}. Admin resolution required.",
        )

    if pay.get("status") != "paid":
        # P0.b.C.g — chronology: rejection on invalid payment state.
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="escrow.release_rejected",
                actor_id="platform", actor_role="platform",
                meta={"reason": "validation_failed",
                      "currentStatus": pay.get("status")},
            )
        except Exception as e:
            logger.warning(f"[chronology] release_rejected (state) append failed: {e}")
        raise HTTPException(400, f"Cannot release: payment status={pay['status']}")

    # Заявка должна быть completed (или админ-override).
    req = await db.service_requests.find_one({"id": pay["requestId"]}, {"_id": 0})
    if req and req.get("status") not in ("completed",) and role != "admin":
        # P0.b.C.g — chronology: rejection on incomplete request.
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="escrow.release_rejected",
                actor_id="platform", actor_role="platform",
                meta={"reason": "validation_failed",
                      "requestStatus": req.get("status")},
            )
        except Exception as e:
            logger.warning(f"[chronology] release_rejected (request) append failed: {e}")
        raise HTTPException(400, f"Request not completed yet: {req.get('status')}")

    now = now_utc().isoformat()
    # Sprint B4.3-A.2 — CAS-guarded status mutation. Only allow paid → released.
    from app.payments.status_cas import cas_set_payment_status
    outcome, current = await cas_set_payment_status(
        db,
        payment_id=payment_id,
        expected_from=["paid"],
        next_status="released",
        extra_fields={
            "releasedAt": now,
            "releasedBy": user_id,
            "releaseNote": body.note,
        },
    )
    if outcome == "idempotent":
        # Race: another release already won. Return the existing terminal
        # state without overwriting timestamps or emitting a second
        # `escrow.released` row. Side-effects below are skipped.
        logger.info(
            f"[escrow] release CAS idempotent: payment={payment_id} "
            f"already 'released'; suppressing second mutation"
        )
        updated = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
        return {"ok": True, "payment": _public_payment(updated)}
    if outcome == "forbidden":
        # Status drifted under us between read and write (e.g. concurrent
        # refund). Surface a structured rejection without mutating state.
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="escrow.release_rejected",
                actor_id="platform", actor_role="platform",
                meta={"reason": "concurrent_modification",
                      "currentStatus": current},
            )
        except Exception as e:
            logger.warning(f"[chronology] release_rejected (race) append failed: {e}")
        raise HTTPException(
            409,
            f"Cannot release: payment status changed concurrently to '{current}'. "
            f"Refresh and retry if appropriate.",
        )
    if outcome == "missing":
        raise HTTPException(409, "Payment row not found during release write")
    # P0.b.C.g — chronology: terminal escrow.released row.
    try:
        from app.payments.chronology.writer import append_payment_event
        await append_payment_event(
            db, payment_id=payment_id, kind="escrow.released",
            actor_id=str(user_id or "platform"),
            actor_role=("admin" if role == "admin"
                       else "customer" if user_id == pay.get("customerId")
                       else "provider" if user_id == pay.get("providerId")
                       else "platform"),
            meta={
                "amount": pay.get("providerPayout"),
                "currency": pay.get("currency", "EUR"),
            },
        )
    except Exception as e:
        logger.warning(f"[chronology] escrow.released append failed: {e}")
    # Запрос → released
    if req:
        await db.service_requests.update_one(
            {"id": pay["requestId"]},
            {"$set": {"status": "released", "updatedAt": now}},
        )
    # Sprint 4 — timeline event + UNIFIED notification (escrow released)
    try:
        from app.service_chat.timeline import append_event
        from app.notifications.emit import emit_notification
        await append_event(
            request_id=pay["requestId"], kind="escrow_released",
            actor_role=role or "system", actor_id=user_id,
            meta={"amount": pay.get("providerPayout")},
            db=db,
        )
        await emit_notification(
            db=db, user_id=pay.get("providerId"),
            kind="service_payout_ready",
            title="🎉 Выплата готова",
            body=f"€{pay.get('providerPayout')} переведено вам. Сделка закрыта.",
            severity="success",
            metadata={"requestId": pay["requestId"], "paymentId": pay["id"]},
            action_url=f"/service-marketplace/{pay['requestId']}",
        )
        # Sprint 5 — invite both parties to leave mutual review (blind reveal).
        try:
            await emit_notification(
                db=db, user_id=pay.get("customerId"),
                kind="review_invitation",
                title="⭐ Оцените исполнителя",
                body="Сделка закрыта. Оставьте отзыв — он откроется обоим после взаимной оценки.",
                severity="info",
                metadata={"requestId": pay["requestId"]},
                action_url=f"/review/post-escrow?requestId={pay['requestId']}",
            )
            await emit_notification(
                db=db, user_id=pay.get("providerId"),
                kind="review_invitation",
                title="⭐ Оцените клиента",
                body="Сделка закрыта. Оставьте отзыв о клиенте — оба отзыва откроются после взаимной оценки.",
                severity="info",
                metadata={"requestId": pay["requestId"]},
                action_url=f"/review/post-escrow?requestId={pay['requestId']}",
            )
        except Exception as _trust_err:
            logger.warning(f"[trust] review invite emit failed: {_trust_err}")
    except Exception as e:
        logger.warning(f"[escrow] release post-hooks failed: {e}")
    pay.update({"status": "released", "releasedAt": now})
    logger.info(
        f"[escrow] released payment {payment_id} payout=€{pay.get('providerPayout')} "
        f"to provider={pay.get('providerId')}"
    )
    return {"ok": True, "payment": _public_payment(pay)}


# ── POST /api/payments/webhook/stripe ─────────────────────────────────────
@webhook_router.post("/api/payments/webhook/stripe")
async def stripe_webhook(body: WebhookBody, request: Request):
    """Webhook от Stripe (или mock-симулятора).

    Обрабатываемые события:
      payment_intent.succeeded      → payment.status: pending → paid
                                       service_requests.status: awaiting_payment → paid
      payment_intent.payment_failed → payment.status → failed
      charge.refunded               → payment.status → refunded

    В mock-режиме verification пропускается. В prod нужно подключить
    `stripe.Webhook.construct_event` через STRIPE_WEBHOOK_SECRET (см. gateway.py).
    """
    raw = await request.body()
    gateway = get_gateway()
    try:
        gateway.verify_webhook(headers=dict(request.headers), raw_body=raw)
    except Exception as e:
        logger.warning(f"[escrow] webhook verify failed: {e}")
        raise HTTPException(400, "Webhook verification failed")

    db = get_db()
    event_type = body.type
    data = body.data or {}
    obj = data.get("object") or {}

    # Источник данных: paymentIntentId или sessionId или metadata.paymentId
    intent_id = obj.get("id") or obj.get("payment_intent")
    session_id = obj.get("checkout_session") or obj.get("session_id")
    metadata = obj.get("metadata") or {}
    payment_id = metadata.get("paymentId")

    # Найти платёж: сначала по paymentId из metadata (надёжно),
    # потом по intent/session id.
    pay = None
    if payment_id:
        pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay and intent_id:
        pay = await db.service_payments.find_one({"stripePaymentIntentId": intent_id}, {"_id": 0})
    if not pay and session_id:
        pay = await db.service_payments.find_one({"stripeSessionId": session_id}, {"_id": 0})

    if not pay:
        logger.warning(
            f"[escrow] webhook: cannot resolve payment from event "
            f"type={event_type} intent={intent_id} session={session_id} metadata={metadata}"
        )
        # Возвращаем 200, чтобы Stripe не ретраил бесконечно (no-op).
        return {"received": True, "matched": False}

    now = now_utc().isoformat()
    new_status: Optional[str] = None
    extra_fields: dict = {}

    if event_type == "payment_intent.succeeded":
        new_status = "paid"
        extra_fields["paidAt"] = now
    elif event_type == "payment_intent.payment_failed":
        new_status = "failed"
        extra_fields["failureReason"] = (obj.get("last_payment_error") or {}).get("message", "unknown")
    elif event_type == "charge.refunded":
        new_status = "refunded"
        extra_fields["refundedAt"] = now

    if new_status:
        # Sprint B4.3-A.2 — CAS-guarded webhook transition.
        # Closed transition table for the mock-gateway webhook handler
        # (mirrors what Stripe Connect webhook does in router_connect.py).
        # We deliberately don't widen the set — a duplicate webhook is
        # an idempotent no-op; an out-of-order webhook gets `forbidden`.
        from app.payments.status_cas import cas_set_payment_status
        WEBHOOK_VALID_FROM = {
            "paid":     ["pending", "failed", "requires_payment_method"],
            "failed":   ["pending", "requires_payment_method"],
            "refunded": ["paid", "released", "resolved_partial"],
        }
        expected_from = WEBHOOK_VALID_FROM.get(new_status, [])
        outcome, current = await cas_set_payment_status(
            db,
            payment_id=pay["id"],
            expected_from=expected_from,
            next_status=new_status,
            extra_fields=extra_fields,
        )
        if outcome == "modified":
            logger.info(
                f"[escrow] webhook {event_type} → payment {pay['id']} → {new_status}"
            )
        elif outcome == "idempotent":
            logger.info(
                f"[escrow] webhook {event_type} no-op: payment {pay['id']} "
                f"already '{new_status}' (duplicate webhook delivery)"
            )
            # Stripe webhook redelivery: post-paid hooks already ran on
            # the first delivery. Skip side-effects, return 200 so Stripe
            # stops retrying.
            return {"received": True, "matched": True,
                    "paymentId": pay["id"], "newStatus": new_status,
                    "idempotent": True}
        else:  # forbidden / missing
            logger.warning(
                f"[escrow] webhook {event_type} REJECTED for payment {pay['id']}: "
                f"current status '{current}' not in allowed set {expected_from}"
            )
            # Out-of-order webhook (e.g. succeeded after refunded). Don't
            # overwrite a terminal state. Return 200 so Stripe doesn't retry.
            return {"received": True, "matched": True,
                    "paymentId": pay["id"], "newStatus": current,
                    "skippedStatus": new_status,
                    "reason": "status_drift_terminal"}

        # Side-effects ONLY fire on a fresh transition. This makes
        # webhook redelivery safe — no duplicate notifications, no
        # duplicate chat-marker append, no duplicate chronology row.
        if event_type == "payment_intent.succeeded":
            # Обновляем запись заявки
            await db.service_requests.update_one(
                {"id": pay["requestId"]},
                {"$set": {"status": "paid", "paidAt": now, "updatedAt": now}},
            )
            # Sprint 4 — открыть чат + timeline event (idempotent)
            try:
                from app.service_chat.router import ensure_chat_for_request
                from app.service_chat.timeline import append_event
                from app.notifications.emit import emit_notification
                req_doc = await db.service_requests.find_one({"id": pay["requestId"]}, {"_id": 0})
                if req_doc:
                    await ensure_chat_for_request(request_doc=req_doc, db=db)
                    await append_event(
                        request_id=pay["requestId"], kind="payment_secured",
                        actor_role="system", meta={"paymentId": pay["id"], "amount": pay.get("grossAmount")},
                        db=db,
                    )
                    # UNIFIED notifications в bell-колокольчик
                    gross = pay.get("grossAmount")
                    await emit_notification(
                        db=db, user_id=req_doc.get("customerId"),
                        kind="service_payment_secured",
                        title=f"✅ Оплата прошла",
                        body=f"€{gross} в защищённом escrow. Чат с исполнителем открыт.",
                        severity="success",
                        metadata={"requestId": pay["requestId"], "paymentId": pay["id"]},
                        action_url=f"/service-marketplace/{pay['requestId']}",
                    )
                    await emit_notification(
                        db=db, user_id=req_doc.get("assignedProviderId"),
                        kind="service_payment_received",
                        title=f"💰 Клиент оплатил",
                        body=f"€{gross} в escrow. Можно начинать работу — контакты открыты в чате.",
                        severity="success",
                        metadata={"requestId": pay["requestId"], "paymentId": pay["id"]},
                        action_url=f"/service-marketplace/{pay['requestId']}",
                    )
            except Exception as e:
                logger.warning(f"[escrow] post-paid hooks failed: {e}")

    return {"received": True, "matched": True, "paymentId": pay["id"], "newStatus": new_status}


# ── Mock dev helper: симулировать оплату ──────────────────────────────────
@customer_payments_router.post("/api/service-payments/{payment_id}/_mock-pay")
async def mock_pay(payment_id: str, request: Request):
    """DEV-only: эмулирует оплату без реального gateway. Используется в
    mobile-checkout-экране (mock-кнопка "Оплатить") и в e2e-тестах.

    В prod-режиме эндпоинт остаётся, но возвращает 410 (Gone).
    Текущий gateway = mock → разрешено.
    """
    payload = await _resolve_role(request)
    user_id = payload.get("sub") or payload.get("userId")
    gateway = get_gateway()
    if gateway.name != "mock":
        raise HTTPException(410, "Mock-pay disabled in production gateway")
    db = get_db()
    pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not pay:
        raise HTTPException(404, "Payment not found")
    if pay.get("customerId") and pay["customerId"] != user_id:
        raise HTTPException(403, "Forbidden")
    if pay.get("status") not in ("pending", "failed"):
        raise HTTPException(409, f"Payment already {pay['status']}")

    # Прокидываем "succeeded" event через webhook путь
    fake_event = {
        "type": "payment_intent.succeeded",
        "data": {"object": {
            "id": pay.get("stripePaymentIntentId") or f"pi_mock_{payment_id}",
            "metadata": {"paymentId": payment_id},
        }},
    }
    body = WebhookBody(**fake_event)
    return await stripe_webhook(body, request)
