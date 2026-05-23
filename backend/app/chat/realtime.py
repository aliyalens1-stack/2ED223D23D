"""Sprint B5 — Realtime transport layer (WebSocket).

Doctrine (per B5 spec):

  - WS is **acceleration over polling substrate**, never replacement.
    Losing the socket NEVER loses state: clients fall back to polling.
  - REST is the **source of truth**. WS does NOT mutate DB, ever.
    All mutations stay POST/DELETE on REST. The hub is read-side only.
  - Wire-format is byte-compatible with REST canonical envelopes.
    `new_message.payload == { message, thread }` matches the REST
    response of `POST /threads/{id}/messages`. `reaction_update.payload`
    matches `_project_reactions(...)`. No "socket-only entities" exist
    in B5.
  - In-process broadcaster ONLY. No Redis streams, no Kafka, no NATS.
    Single-runtime semantics; transport stays as simple as the
    business model currently demands.
  - No typing / presence / read-receipts / online-indicators / edit-delete
    in B5. Strictly the four allowed event types:
      `new_message`, `reaction_update`, `thread_update`, `unread_update`.

Subscription model: one WebSocket per (viewer, tab/device). The hub
fans out every event to every subscriber whose JWT identity is a
participant of the affected thread (via the same `_viewer_kind`
gate that protects REST endpoints). Projection happens per viewer
inside the hub so `isMine` / `reactedByMe` / `unreadByMe` remain
viewer-relative — exactly as REST projects them.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

log = logging.getLogger(__name__)


class _Hub:
    """Lock-protected, in-process registry of WebSocket subscribers.

    A subscriber is `(ws, ctx)` where `ctx` carries a decoded JWT and
    its derived viewer identity (user_id / provider slug). The hub
    publishes by iterating snapshots — never holding the lock during
    fanout — so a slow consumer can't stall other subscribers.
    """

    def __init__(self) -> None:
        self._subs: list[tuple[WebSocket, dict]] = []
        self._lock = asyncio.Lock()

    async def add(self, ws: WebSocket, ctx: dict) -> None:
        async with self._lock:
            self._subs.append((ws, ctx))

    async def remove(self, ws: WebSocket) -> None:
        async with self._lock:
            self._subs = [(w, c) for (w, c) in self._subs if w is not ws]

    async def snapshot(self) -> list[tuple[WebSocket, dict]]:
        async with self._lock:
            return list(self._subs)

    async def size(self) -> int:
        async with self._lock:
            return len(self._subs)


HUB = _Hub()


async def _safe_send(ws: WebSocket, envelope: dict) -> bool:
    """Single-shot best-effort send. A dropped frame is silently lost —
    the polling substrate is the recovery path. We never raise so a
    misbehaving consumer can't blow up the publishing mutation.
    """
    try:
        await ws.send_text(json.dumps(envelope, ensure_ascii=False))
        return True
    except Exception as exc:  # pragma: no cover - WS edge transport
        log.debug("chat ws send failed: %s", exc)
        return False


# ─────────────────────────────────────────────────────────────────
# Publishers — one per canonical mutation point.
# Every publisher imports projection helpers lazily to avoid a
# circular dependency with `canonical.py` at module-load time.
# ─────────────────────────────────────────────────────────────────


async def publish_new_message(thread: dict, msg_doc: dict) -> None:
    """Fanout for newly-inserted messages.

    Envelope mirrors `POST /threads/{id}/messages` REST response:
        { type: "new_message", payload: { message, thread } }
    Each subscriber receives the message + thread projected for
    their own viewer perspective (so `isMine` etc. are correct).
    """
    from .canonical import (
        _project_message,
        _project_thread,
        _viewer_kind,
        _build_sender_name_map,
    )
    snap = await HUB.snapshot()
    if not snap:
        return
    sender_map = await _build_sender_name_map([msg_doc])
    for ws, ctx in snap:
        try:
            vk = _viewer_kind(ctx.get("payload") or {}, thread)
        except Exception:
            continue
        if vk is None:
            # Non-participants get nothing — same gate as REST.
            continue
        envelope = {
            "type": "new_message",
            "payload": {
                "message": _project_message(
                    msg_doc, vk, ctx["user_id"], ctx["slug"], sender_map,
                ),
                "thread": await _project_thread(thread, vk),
            },
        }
        await _safe_send(ws, envelope)


async def publish_thread_update(thread: dict) -> None:
    """Fanout for thread metadata changes (admin join, dispute open, …).

    Envelope: `{ type: "thread_update", payload: { thread } }`.
    Same shape as a REST list/get response, just for one thread.
    """
    from .canonical import _project_thread, _viewer_kind
    snap = await HUB.snapshot()
    if not snap:
        return
    for ws, ctx in snap:
        try:
            vk = _viewer_kind(ctx.get("payload") or {}, thread)
        except Exception:
            continue
        if vk is None:
            continue
        envelope = {
            "type": "thread_update",
            "payload": {"thread": await _project_thread(thread, vk)},
        }
        await _safe_send(ws, envelope)


async def publish_unread_update(thread: dict) -> None:
    """Fanout for unread-count changes (mark-read events).

    Conceptually a thread_update, but named separately so consumers
    can take a cheaper code path (e.g. only update the unread badge,
    not re-render the full thread list row).
    """
    from .canonical import _project_thread, _viewer_kind
    snap = await HUB.snapshot()
    if not snap:
        return
    for ws, ctx in snap:
        try:
            vk = _viewer_kind(ctx.get("payload") or {}, thread)
        except Exception:
            continue
        if vk is None:
            continue
        envelope = {
            "type": "unread_update",
            "payload": {"thread": await _project_thread(thread, vk)},
        }
        await _safe_send(ws, envelope)


async def publish_reaction_update(thread: dict, message: dict) -> None:
    """Fanout for reactions (add/remove). Envelope mirrors the REST
    `POST /messages/{id}/reactions` response: `{ messageId, reactions }`
    with thread context added so the client can route the update
    without a thread-scan.
    """
    from .canonical import _project_reactions, _viewer_kind
    snap = await HUB.snapshot()
    if not snap:
        return
    for ws, ctx in snap:
        try:
            vk = _viewer_kind(ctx.get("payload") or {}, thread)
        except Exception:
            continue
        if vk is None:
            continue
        reactions = _project_reactions(
            message.get("reactions") or {}, vk, ctx["user_id"], ctx["slug"],
        )
        envelope = {
            "type": "reaction_update",
            "payload": {
                "messageId": message["id"],
                "threadId": thread["id"],
                "reactions": reactions,
            },
        }
        await _safe_send(ws, envelope)


# ─────────────────────────────────────────────────────────────────
# WebSocket endpoint — `/api/chat/v1/ws`
# ─────────────────────────────────────────────────────────────────


async def chat_ws_handler(ws: WebSocket, token: str | None) -> None:
    """Authenticate, register with hub, hold the connection.

    Auth: `?token=<jwt>` — same dual-transport convention as chat
    media serve endpoints. Authorization headers can't be set on
    browser WS upgrade requests, so query-string is the universal
    path.

    Client→server frames are treated as pings; we echo `{"type":"pong"}`
    so heartbeat-style clients have a confirmation. We DON'T accept
    any mutation frames — that would split semantics off REST and
    is explicitly out of B5 scope.

    The server emits `{"type":"ping"}` every 25 s of inactivity as a
    proactive liveness probe. A failing send → break + cleanup → the
    client polling substrate carries state until reconnect.
    """
    if not token:
        # Close before accept — RFC-compliant rejection. 4401 = custom
        # "missing auth" outside the IANA range to avoid clashes.
        await ws.close(code=4401)
        return
    try:
        import jwt as _jwt
        from app.core.security import JWT_SECRET, JWT_ALGO
        payload = _jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        await ws.close(code=4401)
        return

    from .canonical import _user_id_from, _provider_slug_from
    ctx = {
        "payload": payload,
        "user_id": _user_id_from(payload),
        "slug": _provider_slug_from(payload),
        "role": payload.get("role"),
    }

    await ws.accept()
    await HUB.add(ws, ctx)
    try:
        # Hello frame so the client knows it's authenticated and can
        # safely transition the UI out of "connecting".
        await _safe_send(ws, {"type": "hello", "payload": {"role": ctx["role"]}})
        while True:
            try:
                _ = await asyncio.wait_for(ws.receive_text(), timeout=25.0)
                # Any frame counts as a client ping — keep it cheap.
                ok = await _safe_send(ws, {"type": "pong"})
                if not ok:
                    break
            except asyncio.TimeoutError:
                # Periodic server-initiated keepalive — also the only
                # way we detect a half-open connection without packets.
                ok = await _safe_send(ws, {"type": "ping"})
                if not ok:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # pragma: no cover - defensive
        log.debug("chat ws session ended: %s", exc)
    finally:
        await HUB.remove(ws)
