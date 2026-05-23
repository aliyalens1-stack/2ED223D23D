"""Sprint 9 — Hot-path Mongo index audit.

Runs on startup. Idempotent. Ensures compound indexes for the queries we
actually run in production (escrow lookups, dispute queue, marketplace
filters, notification fanout).

Existing single-field indexes are not touched. Only ADDS.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


HOT_INDEXES = {
    # ──────── service_requests ──────── 
    # Marketplace listing (status + recency) + customer dashboard
    "service_requests": [
        ([("status", 1), ("createdAt", -1)], "status_createdAt"),
        ([("customerId", 1), ("status", 1)], "customer_status"),
        ([("providerId", 1), ("status", 1)], "provider_status"),
        ([("status", 1), ("releasedAt", -1)], "status_releasedAt"),
        ([("category", 1), ("status", 1), ("createdAt", -1)], "category_status_recent"),
    ],
    # ──────── service_payments ────────
    # Hot path: 12h-payout sweep (status + createdAt), customer/provider history
    "service_payments": [
        ([("status", 1), ("createdAt", -1)], "status_createdAt"),
        ([("customerId", 1), ("createdAt", -1)], "customer_recent"),
        ([("providerId", 1), ("createdAt", -1)], "provider_recent"),
        ([("requestId", 1)], "requestId"),
        ([("stripePaymentIntentId", 1)], "stripePaymentIntentId"),
    ],
    # ──────── disputes ────────
    # Already partly indexed in app/disputes/router.py — add compound for queue
    "disputes": [
        ([("status", 1), ("openedAt", -1)], "status_openedAt"),
        ([("resolution", 1), ("resolvedAt", -1)], "resolution_resolvedAt"),
    ],
    # ──────── provider_reviews ────────
    # Already indexed via app/provider_trust/engine.py — add public listing
    "provider_reviews": [
        ([("providerId", 1), ("targetRole", 1), ("visibility", 1), ("revealedAt", -1)], "public_listing"),
    ],
    # ──────── notifications ────────
    # User inbox + unread-count + since cursor
    "notifications": [
        ([("userId", 1), ("createdAt", -1)], "user_recent"),
        ([("userId", 1), ("readAt", 1), ("createdAt", -1)], "user_unread"),
    ],
    # ──────── push_device_tokens ────────
    "push_device_tokens": [
        ([("userId", 1), ("token", 1)], "user_token_unique"),
    ],
    # ──────── stripe_webhook_events ────────
    # _id IS the event_id (so dedup is automatic). Add type+time for ops
    "stripe_webhook_events": [
        ([("type", 1), ("receivedAt", -1)], "type_recent"),
    ],
    # ──────── service_chats / messages ────────
    # Chat scroll (request + recency)
    "service_chat_messages": [
        ([("requestId", 1), ("createdAt", -1)], "request_recent"),
    ],
    # ──────── platform_settings ────────
    # Single doc per type — used by escrow release gate
    "platform_settings": [
        ([("type", 1)], "type"),
    ],
}


async def ensure_hot_indexes(db) -> dict:
    """Create all compound indexes idempotently. Returns counts of created
    indexes per collection (skipped = 0 if already present).
    """
    summary = {}
    for collection, indexes in HOT_INDEXES.items():
        created = 0
        for keys, name in indexes:
            try:
                await db[collection].create_index(keys, name=name)
                created += 1
            except Exception as e:
                # Index may already exist with a different name — that's OK.
                logger.debug(f"[hot-indexes] {collection}.{name} skipped: {e}")
        summary[collection] = created
    logger.info(f"[hot-indexes] ensured: {summary}")
    return summary
