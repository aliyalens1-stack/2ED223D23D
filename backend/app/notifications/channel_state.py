"""
backend/app/notifications/channel_state.py — Sprint Customer-Notify-3A.

Channel-flip policy. The single point of truth for which channels are
permitted to perform real provider delivery. `dryRun` is ALWAYS true
(forensic asset, not a temporary mode); `liveEnabled` is the toggle
that allows the dumb provider adapter to be called.

Roman, 2026-05-14:
  • dry-run + liveRun coexist
  • flip one channel at a time
  • change requires a deploy (this is policy, not configuration)

Notify-3A: push live, email/sms still dry-run.
Notify-3B: email live (Postmark sandbox, 2026-05-15).
Notify-3C: sms live (later).
"""
from __future__ import annotations

from typing import Dict


# Hard policy — change requires a deploy. Not loaded from env, not
# overridable at runtime, not in the database. This IS the kill switch.
CHANNEL_STATE: Dict[str, Dict[str, object]] = {
    "push":  {"dryRun": True, "liveEnabled": True,  "provider": "expo"},
    "email": {"dryRun": True, "liveEnabled": True,  "provider": "postmark"},
    "sms":   {"dryRun": True, "liveEnabled": False, "provider": None},
}


def channel_state(channel: str) -> Dict[str, object]:
    """Return the policy block for `channel`, or a closed default."""
    return CHANNEL_STATE.get(channel) or {
        "dryRun": True,
        "liveEnabled": False,
        "provider": None,
    }


def is_live(channel: str) -> bool:
    """True iff the channel is allowed to call a real provider."""
    return bool(CHANNEL_STATE.get(channel, {}).get("liveEnabled"))


def provider_for(channel: str) -> str:
    """Provider key (`expo`, `sendgrid`, `twilio`, …) or empty string."""
    p = CHANNEL_STATE.get(channel, {}).get("provider")
    return str(p) if p else ""


__all__ = ["CHANNEL_STATE", "channel_state", "is_live", "provider_for"]
