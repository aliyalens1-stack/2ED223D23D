"""Sprint 3A — Payment Gateway abstraction.

Production-ready дизайн: вся работа с платежами идёт через единый
интерфейс `PaymentGateway`. Сейчас используется `MockGateway`, который
эмулирует поведение Stripe Checkout + webhook. Когда у нас будут реальные
ключи, мы добавляем `StripeGateway(PaymentGateway)` и одну строку в
`get_gateway()` — роутеры не меняются.

Контракт:
  create_checkout_session(payment) -> {checkoutUrl, sessionId}
  verify_webhook(headers, body)    -> verified event dict (или RuntimeError)
  refund(payment)                   -> {refundId, status}

Реализация Mock:
  - URL вида https://checkout.stripe.com/mock/cs_<uid>
  - sessionId генерируется как `cs_mock_<uuid>` — совместимо с Stripe pattern
  - verify_webhook принимает любой payload (для теста)
"""
from __future__ import annotations
import os
import uuid
import logging
from typing import Protocol


logger = logging.getLogger(__name__)


class PaymentGateway(Protocol):
    """Контракт gateway. Любой реальный платёжный провайдер должен
    реализовать эти 3 метода."""

    name: str

    def create_checkout_session(
        self,
        *,
        payment_id: str,
        amount_cents: int,
        currency: str,
        description: str,
        return_url: str | None = None,
        cancel_url: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        ...

    def verify_webhook(self, *, headers: dict, raw_body: bytes) -> dict:
        ...

    def refund(self, *, charge_id: str, amount_cents: int | None = None) -> dict:
        ...


class MockGateway:
    """Эмуляция Stripe Checkout + webhook. Не делает реальных HTTP-вызовов.

    Зачем такой mock:
      - детерминирован, тестируется без сети
      - возвращает поля совместимые со Stripe (paymentIntentId, sessionId)
      - позволяет фронту нормально пройти flow accept-bid → checkout → success
    """

    name = "mock"

    def create_checkout_session(
        self,
        *,
        payment_id: str,
        amount_cents: int,
        currency: str,
        description: str,
        return_url: str | None = None,
        cancel_url: str | None = None,
        metadata: dict | None = None,
    ) -> dict:
        session_id = f"cs_mock_{uuid.uuid4().hex[:24]}"
        intent_id = f"pi_mock_{uuid.uuid4().hex[:24]}"
        checkout_url = f"https://checkout.stripe.com/mock/{session_id}?payment={payment_id}"
        if return_url:
            checkout_url += f"&return_url={return_url}"
        logger.info(
            f"[mock_gateway] created session {session_id} for payment={payment_id} "
            f"amount={amount_cents}cents {currency}"
        )
        return {
            "sessionId": session_id,
            "paymentIntentId": intent_id,
            "checkoutUrl": checkout_url,
            "amountCents": amount_cents,
            "currency": currency,
            "metadata": metadata or {},
        }

    def verify_webhook(self, *, headers: dict, raw_body: bytes) -> dict:
        """Mock verify — в production здесь Stripe.Webhook.construct_event(...).

        В mock-режиме мы доверяем payload'у, но фиксируем источник, чтобы
        в будущем заменить на реальную HMAC-проверку, не меняя callsite.
        """
        # Признак unsafe-verification (когда подключим Stripe — выкинем).
        result = {"verified": True, "gateway": "mock"}
        sig = headers.get("stripe-signature") or headers.get("Stripe-Signature")
        if sig:
            result["signature"] = sig
        return result

    def refund(self, *, charge_id: str, amount_cents: int | None = None) -> dict:
        refund_id = f"re_mock_{uuid.uuid4().hex[:24]}"
        logger.info(f"[mock_gateway] refund {refund_id} for charge={charge_id} amount={amount_cents}")
        return {
            "refundId": refund_id,
            "chargeId": charge_id,
            "amountCents": amount_cents,
            "status": "succeeded",
        }


# Глобальный синглтон gateway.
# В будущем для prod: переключаем по env var STRIPE_SECRET_KEY.
_gateway: PaymentGateway | None = None


def get_gateway() -> PaymentGateway:
    """Возвращает активный gateway. Сейчас всегда MockGateway.

    Когда у нас будут реальные ключи, тут добавим:
      if os.getenv("STRIPE_SECRET_KEY"):
          return StripeGateway(api_key=os.getenv("STRIPE_SECRET_KEY"))
    """
    global _gateway
    if _gateway is None:
        # Hook для будущего: live Stripe gateway.
        # if os.getenv("STRIPE_SECRET_KEY"):
        #     from .stripe_gateway import StripeGateway
        #     _gateway = StripeGateway(api_key=os.environ["STRIPE_SECRET_KEY"])
        # else:
        _gateway = MockGateway()
        logger.info(f"[escrow] active gateway: {_gateway.name}")
    return _gateway
