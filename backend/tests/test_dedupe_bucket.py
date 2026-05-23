"""tests/test_dedupe_bucket.py — Redis-Truthfulness pass safety net.

Integration tests against local MongoDB. Verifies:
  1. Same (scope, key) within the same time bucket → only first claim wins.
  2. Different (scope, key) within the same bucket → both win.
  3. Different keys map to independent claims.
  4. Index creation is idempotent (re-calling try_claim_bucket does not
     raise even after the first claim).
  5. TTL field is set so Mongo auto-cleanup engages.
  6. DuplicateKeyError is NOT bubbled up to the caller (must return False).

NO Redis required. NO orchestrator running required. Test runs against
the live local MongoDB (`mongodb://localhost:27017` per backend/.env).
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient


@pytest_asyncio.fixture(autouse=True)
async def _init_app_context():
    """Initialize ctx.db with a fresh motor client bound to the current
    event loop. Required because pytest-asyncio gives each test its own
    loop, and motor clients are loop-bound.
    """
    from app.core.context import ctx
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "test_database")
    client = AsyncIOMotorClient(mongo_url)
    ctx.mongo = client
    ctx.db = client[db_name]
    # Reset module-level index flag so each test exercises ensure_indexes().
    import app.core.dedupe_bucket as _db_mod
    _db_mod._indexes_ready = False
    yield
    client.close()


@pytest.mark.asyncio
async def test_same_key_same_bucket_only_first_wins():
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    scope = f"test-dedupe-{uuid.uuid4().hex[:8]}"
    key = "berlin-mitte:SURGE"
    window = 60  # 1-minute bucket

    first = await try_claim_bucket(scope, key, window)
    second = await try_claim_bucket(scope, key, window)
    third = await try_claim_bucket(scope, key, window)

    assert first is True, "first call must claim the bucket"
    assert second is False, "second call within window must lose the claim"
    assert third is False, "third call within window must also lose"

    # Cleanup
    await db.dedupe_buckets.delete_many({"scope": scope})


@pytest.mark.asyncio
async def test_different_keys_both_win():
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    scope = f"test-dedupe-{uuid.uuid4().hex[:8]}"

    a = await try_claim_bucket(scope, "zone-A", 60)
    b = await try_claim_bucket(scope, "zone-B", 60)

    assert a is True and b is True, "distinct keys must not collide"

    await db.dedupe_buckets.delete_many({"scope": scope})


@pytest.mark.asyncio
async def test_different_scopes_both_win():
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    suffix = uuid.uuid4().hex[:8]
    scope_a = f"test-orchestrator-{suffix}"
    scope_b = f"test-preengage-{suffix}"
    key = "berlin-mitte"

    a = await try_claim_bucket(scope_a, key, 60)
    b = await try_claim_bucket(scope_b, key, 60)

    assert a is True and b is True, "different scopes must not collide"

    await db.dedupe_buckets.delete_many({"scope": {"$in": [scope_a, scope_b]}})


@pytest.mark.asyncio
async def test_doc_has_expires_at_for_ttl_cleanup():
    """The inserted doc MUST carry `expiresAt` so the Mongo TTL index
    can auto-delete it after the window passes. Without this, claim
    docs would accumulate forever."""
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    scope = f"test-dedupe-{uuid.uuid4().hex[:8]}"
    key = "ttl-check"
    window = 30

    ok = await try_claim_bucket(scope, key, window)
    assert ok is True

    doc = await db.dedupe_buckets.find_one({"scope": scope, "key": key}, {"_id": 0})
    assert doc is not None
    assert "expiresAt" in doc, "claim doc MUST have expiresAt for TTL cleanup"
    assert doc.get("bucket") is not None

    await db.dedupe_buckets.delete_many({"scope": scope})


@pytest.mark.asyncio
async def test_duplicate_does_not_raise():
    """Caller contract: duplicate returns False, NEVER raises
    DuplicateKeyError to the caller."""
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    scope = f"test-dedupe-{uuid.uuid4().hex[:8]}"
    key = "no-raise-check"

    await try_claim_bucket(scope, key, 60)
    # If exception leaks, this line raises and the test fails:
    result = await try_claim_bucket(scope, key, 60)
    assert result is False

    await db.dedupe_buckets.delete_many({"scope": scope})


@pytest.mark.asyncio
async def test_compound_unique_index_present():
    """Verify the unique compound index was created. This is the only
    thing standing between Redis-down and orchestrator log amplification."""
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    # Force index creation by calling once
    await try_claim_bucket("test-index-warmup", "x", 60)

    indexes = await db.dedupe_buckets.index_information()
    # Compound unique index
    found_compound = False
    found_ttl = False
    for name, spec in indexes.items():
        keys = [k[0] for k in spec.get("key", [])]
        if keys == ["scope", "key", "bucket"] and spec.get("unique"):
            found_compound = True
        if keys == ["expiresAt"] and "expireAfterSeconds" in spec:
            found_ttl = True

    assert found_compound, "compound unique index on (scope, key, bucket) must exist"
    assert found_ttl, "TTL index on expiresAt must exist"

    await db.dedupe_buckets.delete_many({"scope": "test-index-warmup"})


@pytest.mark.asyncio
async def test_bucket_advances_with_time():
    """When clock advances past the window boundary, a new bucket starts
    and the next claim succeeds. We simulate by using a very short window
    and a real sleep."""
    from app.core.dedupe_bucket import try_claim_bucket
    from app.core.db import db

    scope = f"test-dedupe-{uuid.uuid4().hex[:8]}"
    key = "bucket-advance"
    window = 1  # 1-second bucket

    # First claim wins
    a = await try_claim_bucket(scope, key, window)
    assert a is True

    # Immediately within same second → loses
    b = await try_claim_bucket(scope, key, window)
    assert b is False

    # Wait for bucket to advance (sleep slightly more than 1s)
    await asyncio.sleep(1.3)
    c = await try_claim_bucket(scope, key, window)
    assert c is True, "new bucket should accept the next claim"

    await db.dedupe_buckets.delete_many({"scope": scope})
