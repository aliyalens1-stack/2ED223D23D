"""Pydantic shapes for car-selection thread + notifications."""
from __future__ import annotations
from typing import Annotated, List, Literal, Optional
from pydantic import BaseModel, Field, field_validator


# A message author always carries one of these three roles. Stored as
# part of the message so downstream UIs can colour-code without
# re-fetching the actor's account.
AuthorRole = Literal["customer", "admin", "provider"]


# Visibility is a forward-looking knob — for now ALL messages are
# "shared" (visible to customer + provider + admin). Reserved values:
#   shared           — three-way conversation (default)
#   admin_internal   — admin-only side channel (NOT YET surfaced)
# Stored explicitly so future internal notes can land without a schema
# migration.
Visibility = Literal["shared", "admin_internal"]


class AttachmentIn(BaseModel):
    """Append-only attachment reference. The thread does NOT host
    binary uploads itself — clients pass URLs (e.g. signed storage
    links) plus minimal metadata. Once persisted, attachments are
    immutable.
    """
    url: Annotated[str, Field(min_length=1, max_length=2048)]
    type: Annotated[str, Field(min_length=1, max_length=64)]  # mime/short kind
    size: Optional[Annotated[int, Field(ge=0, le=200 * 1024 * 1024)]] = None
    name: Optional[Annotated[str, Field(max_length=200)]] = None


class MessageIn(BaseModel):
    """Body for `POST .../thread` — append a new operational message.

    `body` is required; `attachmentIds` are optional references to
    already-uploaded artifacts (see app/car_selection_thread/artifacts.py).
    We deliberately accept neither id nor createdAt — those are
    server-stamped to keep the timeline forensic-safe.

    Inline `attachments` were intentionally NOT exposed as input — clients
    must upload through the dedicated artifacts endpoints first and then
    reference the resulting ids. This keeps multipart upload logic out of
    the message validator and lets us reject cross-request smuggling
    centrally (see artifacts.resolve_attachment_ids).
    """
    body: Annotated[str, Field(min_length=1, max_length=4000)]
    attachmentIds: List[Annotated[str, Field(min_length=1, max_length=64)]] = (
        Field(default_factory=list, max_length=10)
    )
    visibility: Visibility = "shared"

    @field_validator("body")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("body must not be empty")
        return v


class MessageOut(BaseModel):
    id: str
    requestId: str
    authorId: str
    authorRole: AuthorRole
    body: str
    # Server-resolved on append from `attachmentIds` — stored as the
    # canonical projection of the artifact at attachment time. Artifacts
    # are immutable, so this projection never goes stale.
    attachments: List[dict]
    visibility: Visibility
    createdAt: str


# ── Notifications ────────────────────────────────────────────────────

# Why a separate event-type alphabet from the lifecycle one:
# notifications are PROJECTIONS — a recipient's inbox view of what
# happened. Lifecycle events use plain status strings; notifications
# add `message_*` events that the lifecycle doesn't know about.
NotificationEvent = Literal[
    "message",
    "lifecycle.assigned",
    "lifecycle.waiting_customer",
    "lifecycle.completed",
]


class NotificationOut(BaseModel):
    id: str
    recipientId: str
    recipientRole: AuthorRole
    requestId: str
    eventType: NotificationEvent
    messageId: Optional[str] = None   # set when eventType=="message"
    actorRole: Optional[AuthorRole] = None
    preview: Optional[str] = None     # first ~140 chars of message body
    createdAt: str
    readAt: Optional[str] = None


class MarkReadIn(BaseModel):
    """Body for `POST notifications/me/read`.

    Either `ids` (specific notification ids) or `all=True` (mark every
    unread notification for the caller). Exactly one MUST be provided.
    """
    ids: Optional[List[Annotated[str, Field(min_length=1, max_length=64)]]] = None
    all: bool = False

    @field_validator("ids")
    @classmethod
    def _trim(cls, v):
        if v is None:
            return v
        if not v:
            raise ValueError("ids must be a non-empty list when provided")
        if len(v) > 200:
            raise ValueError("at most 200 ids per call")
        return v


__all__ = [
    "AuthorRole", "Visibility", "AttachmentIn",
    "MessageIn", "MessageOut",
    "NotificationEvent", "NotificationOut", "MarkReadIn",
]
