"""app.workers.receipts_poll.contracts — cadence + provider constants.

PR-01 (Phase 3D) move-only extraction. Values are LITERALLY copied from
the previous location at `app/notifications/receipts.py`. No tuning, no
renaming, no defaulting changes.

Cadence reference: https://docs.expo.dev/push-notifications/sending-notifications/#push-receipts
"""
from __future__ import annotations

# ── Provider transport
EXPO_RECEIPTS_URL: str = "https://exp.host/--/api/v2/push/getReceipts"
PROVIDER: str = "expo"
CHANNEL: str = "push"

# ── Receipt polling cadence
# Receipts are available shortly after send. Expo recommends polling
# 15 minutes after send and discarding tickets after 24h.
RECEIPT_MIN_AGE_SECONDS: int = 15 * 60          # don't check until at least 15 min old
RECEIPT_MAX_AGE_SECONDS: int = 24 * 3600        # don't check older than 24h
RECEIPT_RECHECK_BACKOFF_SECONDS: int = 5 * 60   # re-poll a single row no more than every 5 min
BATCH_SIZE: int = 100                           # Expo limit per request

# ── Worker loop cadence (registration default; previously hard-coded
# at the lifespan call site as `receipts_poll_loop(_get_db(), 180.0)`).
# Move-only: same numeric value, just lifted to a named constant so
# the registry hook can reference it without changing call semantics.
DEFAULT_INTERVAL_S: float = 180.0
