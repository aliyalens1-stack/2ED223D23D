"""
backend/app/notifications/preferences.py — Sprint Notify-Pref-1 (2026-05-15).

Recipient-intent namespace for "the user does not want this notification".
APPEND-ONLY event log. NEVER mutated, NEVER deleted.

Roman 2026-05-15 invariant (the most important one):
    preference opt-out  NEVER  creates a suppression row
    suppression event   NEVER  creates a preference row

Even though the outcome may be identical ("we do not send"), the truth
is fundamentally different:

    preferences   =  recipient intent       (recipient says no)
    suppression   =  provider transport     (provider says no)
    lifecycle     =  what transport tried
    audit         =  what we intended

Each truth lives in its own namespace. The delivery gate consults both,
but neither namespace mutates the other.

──────────────────────────────────────────────────────────────────────
Scope lock — Notify-Pref-1 is INTENTIONALLY narrow:

    YES:
      • read path:  is_opted_out(user_id, channel, kind)
      • write path: append_preference_event(...)
      • customer self-toggle endpoint
      • admin observability + manual override
      • delivery gate: preference check BEFORE suppression check

    NO (deferred to future sprints):
      • quiet hours / time-of-day windows
      • digest / batching
      • per-surface routing
      • topic trees
      • marketing consent (GDPR layer)
      • escalation / priority overrides
      • channel-substitution ("if email opted-out, try push")

──────────────────────────────────────────────────────────────────────
Collection: `notification_preferences`
Row shape (immutable, append-only):
{
  id:              uuid hex
  recipientUserId: <string>           # required — preferences ARE keyed by identity
  channel:         "push" | "email" | "sms"
  kind:            str | None         # specific notification kind, or None = channel-wide
  effect:          "opt_out" | "opt_in"
  source:          "self" | "admin" | "system"
  reason:          short tag (≤128 chars)
  metadata:        dict (≤2 KB serialised)
  createdAt:       ISO8601 UTC — wall time of the append
}

Precedence (latest-row-wins, kind-specific beats channel-wide):
  1. Look for latest row for (user, channel, kind=<requested>).
     If found → its effect decides.
  2. Else look for latest row for (user, channel, kind=None).
     If found → its effect decides.
  3. Else → default opt_in (not opted-out).

Why precedence and not "newest of either":
  If a user opts out of channel-wide email, then opts IN to a specific
  kind (e.g. "report.ready") later, the kind-specific row must win
  regardless of which is newer. The opposite — toggle channel off,
  then explicit kind ON — is exactly the recipient-agency loop we
  must preserve.

  But — within the SAME granularity (kind-specific OR channel-wide),
  latest wins by createdAt. Reactivation (opt_in after opt_out) is
  just another row.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Validation alphabets
# ─────────────────────────────────────────────────────────────────────

VALID_CHANNELS = frozenset({"push", "email", "sms"})
VALID_EFFECTS = frozenset({"opt_out", "opt_in"})
VALID_SOURCES = frozenset({"self", "admin", "system"})


# ─────────────────────────────────────────────────────────────────────
# Index hook
# ─────────────────────────────────────────────────────────────────────

async def ensure_preference_indexes(db) -> None:
    """Idempotent. Indexes:
       1. read path: lookup latest row for (user, channel, kind).
          Compound (recipientUserId, channel, kind, createdAt desc) —
          the kind-specific lookup walks straight to the newest match;
          the channel-wide lookup uses the same index with kind:None.
       2. admin listing: createdAt desc.
       3. admin per-user listing: (recipientUserId, createdAt desc).

    Each index wrapped in its own try/except so a single failure does
    not stop later indexes (mirrors suppression.py)."""
    plans = [
        dict(keys=[("recipientUserId", 1), ("channel", 1),
                   ("kind", 1), ("createdAt", -1)],
             name="pref_user_channel_kind_createdAt"),
        dict(keys=[("createdAt", -1)], name="pref_createdAt_desc"),
        dict(keys=[("recipientUserId", 1), ("createdAt", -1)],
             name="pref_user_createdAt"),
    ]
    for p in plans:
        kwargs: Dict[str, Any] = {"background": True, "name": p["name"]}
        try:
            await db.notification_preferences.create_index(p["keys"], **kwargs)
        except Exception as e:  # pragma: no cover
            logger.warning(f"pref ensure_index({p['name']}) non-fatal: {e}")


# ─────────────────────────────────────────────────────────────────────
# WRITE — append only
# ─────────────────────────────────────────────────────────────────────

async def append_preference_event(
    db,
    *,
    recipient_user_id: str,
    channel: str,
    effect: str,
    kind: Optional[str] = None,
    source: str = "self",
    reason: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Append ONE preference row. Returns {ok, reason, rowId|None}.

    Append-only: every toggle creates a new row. The latest row by
    createdAt wins at read time. We do NOT compress, dedupe, or merge.
    Recipient agency means the full history is forensic-grade.

    Cross-namespace lock: this function NEVER touches
    `notification_suppressions` or `notification_delivery_lifecycle`.
    If the recipient's intent (opt_out) coincides with a provider-side
    suppression, those are two parallel rows in two parallel namespaces,
    each truthful in its own way."""
    if channel not in VALID_CHANNELS:
        return {"ok": False, "reason": f"bad_channel:{channel}"}
    if effect not in VALID_EFFECTS:
        return {"ok": False, "reason": f"bad_effect:{effect}"}
    if source not in VALID_SOURCES:
        return {"ok": False, "reason": f"bad_source:{source}"}
    user_id = str(recipient_user_id or "").strip()
    if not user_id:
        return {"ok": False, "reason": "empty_user_id"}
    # kind is optional but must be a non-empty string if provided.
    kind_n: Optional[str] = None
    if kind is not None:
        if not isinstance(kind, str) or not kind.strip():
            return {"ok": False, "reason": "bad_kind"}
        kind_n = kind.strip()[:128]

    meta_blob = None
    if metadata is not None:
        try:
            blob = json.dumps(metadata, default=str)
            meta_blob = metadata if len(blob) <= 2048 else {"_truncated": True}
        except Exception:
            meta_blob = {"_unserializable": True}

    now_iso = datetime.now(timezone.utc).isoformat()
    doc: Dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "recipientUserId": user_id,
        "channel": channel,
        "kind": kind_n,
        "effect": effect,
        "source": source,
        "reason": (reason or "")[:128] or None,
        "metadata": meta_blob,
        "createdAt": now_iso,
    }
    try:
        await db.notification_preferences.insert_one(doc)
        return {"ok": True, "reason": "appended", "rowId": doc["id"]}
    except Exception as e:
        logger.warning(f"pref append failed (non-fatal): {e}")
        return {"ok": False, "reason": f"insert_failed:{type(e).__name__}"}


# ─────────────────────────────────────────────────────────────────────
# READ — computed "is opted out?"
# ─────────────────────────────────────────────────────────────────────

async def _latest_row(
    db, *, user_id: str, channel: str, kind: Optional[str]
) -> Optional[Dict[str, Any]]:
    """Internal — fetch latest preference row at one granularity level.
    `kind=None` means "the channel-wide row". `kind="report.ready"`
    means "the kind-specific row"."""
    try:
        row = await db.notification_preferences.find_one(
            {"recipientUserId": user_id, "channel": channel, "kind": kind},
            {"_id": 0},
            sort=[("createdAt", -1)],
        )
        return row
    except Exception as e:
        logger.warning(f"pref _latest_row query failed (fail-open): {e}")
        return None


async def is_opted_out(
    db, *, user_id: str, channel: str, kind: Optional[str] = None,
) -> Tuple[bool, Optional[Dict[str, Any]]]:
    """Recipient-intent gate. Returns (opted_out, decidingRow).

    Precedence:
      1. kind-specific row (if `kind` is given)         → its effect decides
      2. else channel-wide row (kind=None)              → its effect decides
      3. else default opt_in (NOT opted out)            → (False, None)

    Fail-open: any DB error returns (False, None). Recipient agency
    must not be silently turned into "blocked" by an infrastructure
    hiccup.
    """
    if channel not in VALID_CHANNELS:
        return (False, None)
    user_id = str(user_id or "").strip()
    if not user_id:
        return (False, None)

    # Step 1: kind-specific (most precise wins).
    if isinstance(kind, str) and kind.strip():
        row = await _latest_row(db, user_id=user_id, channel=channel,
                                kind=kind.strip()[:128])
        if row is not None:
            return (row.get("effect") == "opt_out", row)

    # Step 2: channel-wide fallback.
    row = await _latest_row(db, user_id=user_id, channel=channel, kind=None)
    if row is not None:
        return (row.get("effect") == "opt_out", row)

    # Step 3: default opt-in.
    return (False, None)


# ─────────────────────────────────────────────────────────────────────
# Listing — projection helpers
# ─────────────────────────────────────────────────────────────────────

async def list_preference_events(
    db,
    *,
    user_id: Optional[str] = None,
    channel: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Admin / customer history read. Sorted by createdAt desc.
    Append-only stream — caller is responsible for collapsing into a
    "current state" snapshot if needed (use `current_preferences`)."""
    q: Dict[str, Any] = {}
    if user_id:
        q["recipientUserId"] = str(user_id)
    if channel:
        if channel not in VALID_CHANNELS:
            return []
        q["channel"] = channel
    try:
        cursor = db.notification_preferences.find(q, {"_id": 0}).sort(
            "createdAt", -1
        ).limit(max(1, min(int(limit), 1000)))
        return await cursor.to_list(length=1000)
    except Exception as e:
        logger.warning(f"pref list failed: {e}")
        return []


async def current_preferences(
    db, *, user_id: str,
) -> Dict[str, Any]:
    """Project the append-only stream into a stable snapshot per channel.

    Shape:
    {
      "channels": {
        "push":  { "effect": "opt_in", "kindOverrides": { "<kind>": "opt_out", ... } },
        "email": { ... },
        "sms":   { ... }
      },
      "asOf": "<iso>"
    }

    The snapshot is a derived view — never persisted. Callers that
    need to display "your current settings" use this; callers that
    need to make a delivery decision use `is_opted_out` directly so
    the precedence is enforced in one place."""
    user_id = str(user_id or "").strip()
    snapshot: Dict[str, Any] = {
        "channels": {ch: {"effect": "opt_in", "kindOverrides": {}}
                     for ch in VALID_CHANNELS},
        "asOf": datetime.now(timezone.utc).isoformat(),
    }
    if not user_id:
        return snapshot

    try:
        cursor = db.notification_preferences.find(
            {"recipientUserId": user_id},
            {"_id": 0, "channel": 1, "kind": 1, "effect": 1, "createdAt": 1},
        ).sort("createdAt", -1)
        rows = await cursor.to_list(length=5000)
    except Exception as e:
        logger.warning(f"pref current_preferences failed: {e}")
        return snapshot

    # Walk newest → oldest, take FIRST occurrence per (channel, kind).
    seen: set = set()
    for row in rows:
        ch = row.get("channel")
        if ch not in VALID_CHANNELS:
            continue
        kind = row.get("kind")  # None for channel-wide
        key = (ch, kind)
        if key in seen:
            continue
        seen.add(key)
        effect = row.get("effect", "opt_in")
        if kind is None:
            snapshot["channels"][ch]["effect"] = effect
        else:
            snapshot["channels"][ch]["kindOverrides"][kind] = effect
    return snapshot


__all__ = [
    "ensure_preference_indexes",
    "append_preference_event",
    "is_opted_out",
    "list_preference_events",
    "current_preferences",
    "VALID_CHANNELS", "VALID_EFFECTS", "VALID_SOURCES",
]
