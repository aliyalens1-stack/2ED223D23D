"""
backend/app/notifications/providers/expo_push.py — Sprint Customer-Notify-3A.

DUMB provider adapter for Expo Push Notification Service.

    payload in  →  provider format out

That is the ENTIRE contract. The adapter MUST NOT:
  • select copy,
  • select locale,
  • select destination,
  • select urgency,
  • change prose,
  • access the grammar kernel,
  • access channel state.

It receives a fully-resolved transport payload and forwards it to
Expo's HTTP endpoint. Failure modes (network, HTTP non-2xx, ticket
error) are reported as lifecycle rows by the caller — the adapter
itself does no retry, no batching, no policy.

Reference: https://docs.expo.dev/push-notifications/sending-notifications/
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
NAME = "expo"


async def send_push(
    *,
    push_token: str,
    title: Optional[str],
    body: str,
    data: Optional[Dict[str, Any]] = None,
    timeout_s: float = 8.0,
) -> Dict[str, Any]:
    """
    Submit ONE push to Expo. Returns a normalised result:

        { "ok": bool, "providerMessageId": str|None,
          "providerStatus": str, "providerError": str|None }

    `ok=True` only when Expo returns status="ok" with a non-empty id.
    All transport errors (network, non-2xx, ticket error) are
    captured into `providerError` for the caller's lifecycle writer.
    """
    if not push_token or not isinstance(push_token, str):
        return {"ok": False, "providerMessageId": None,
                "providerStatus": "invalid_token", "providerError": "missing push token"}
    if not body:
        return {"ok": False, "providerMessageId": None,
                "providerStatus": "invalid_payload", "providerError": "missing body"}

    message: Dict[str, Any] = {
        "to": push_token,
        "body": body,
        "sound": "default",
    }
    if title:
        message["title"] = title
    if data is not None:
        message["data"] = data

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
    }
    # Optional access token for "secure send" (Expo Enhanced Security).
    # Not required for sandbox; if set, included.
    token = os.environ.get("EXPO_ACCESS_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.post(EXPO_PUSH_URL, json=message, headers=headers)
    except httpx.HTTPError as e:
        return {"ok": False, "providerMessageId": None,
                "providerStatus": "transport_error", "providerError": str(e)}

    if r.status_code // 100 != 2:
        return {"ok": False, "providerMessageId": None,
                "providerStatus": f"http_{r.status_code}",
                "providerError": r.text[:512]}

    try:
        body_json = r.json()
    except Exception as e:
        return {"ok": False, "providerMessageId": None,
                "providerStatus": "bad_response", "providerError": str(e)[:512]}

    # Expo wraps single results in `data` (object or list-of-one).
    data_field = body_json.get("data")
    ticket: Dict[str, Any]
    if isinstance(data_field, list):
        ticket = data_field[0] if data_field else {}
    elif isinstance(data_field, dict):
        ticket = data_field
    else:
        ticket = {}

    status = ticket.get("status")
    msg_id = ticket.get("id")
    if status == "ok" and msg_id:
        return {"ok": True, "providerMessageId": msg_id,
                "providerStatus": "ok", "providerError": None}
    return {"ok": False, "providerMessageId": msg_id,
            "providerStatus": status or "unknown",
            "providerError": (ticket.get("message") or "")[:512]}


__all__ = ["send_push", "NAME"]
