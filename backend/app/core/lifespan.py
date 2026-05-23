"""app.core.lifespan — Sprint 21 C15 + C15.1 + C17: единая точка lifecycle.

C17 cleanup: runtime `from server import` удалены. bootstrap_side_effects и
shutdown_cleanup теперь живут в `app.core.bootstrap` (чистый модуль, нет
зависимостей от server.py).

Порядок startup:
  init_db → load_ml_models → bootstrap_side_effects → start_all_loops

Порядок shutdown:
  shutdown_cleanup (close mongo + kill NestJS subprocess)

Правила:
  1. `init_db` ДО `load_ml_models` — ML читает ml_models коллекцию.
  2. `load_ml_models` ДО `bootstrap_side_effects`/loops — чтобы warm-start
     модели были готовы до первого orchestrator tick.
  3. `start_all_loops` В ПОСЛЕДНЮЮ ОЧЕРЕДЬ — все loops делают await db.X,
     поэтому seed/indexes должны быть прошиты.
"""
from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from app.core.bootstrap import bootstrap_side_effects, shutdown_cleanup
from app.orchestrator.runner import start_all_loops

if TYPE_CHECKING:
    from fastapi import FastAPI


logger = logging.getLogger("server")


async def init_db() -> None:
    """Проверка что MongoDB доступна (ping). Idempotent."""
    from app.core.db import get_db
    try:
        db = get_db()
        await db.client.admin.command("ping")
        logger.info("C15 lifespan: MongoDB ping OK")
    except Exception as e:
        logger.error(f"C15 lifespan: MongoDB ping FAILED — {e}")
        raise


async def load_ml_models() -> int:
    """Warm-hydration GBM моделей из db.ml_models. Non-fatal на ошибке."""
    try:
        from app.ml.predictor import DemandPredictor
        loaded = await DemandPredictor.load_persisted()
        logger.info(f"C15 lifespan: DemandPredictor warm-hydrated {loaded} models")
        return loaded
    except Exception as e:
        logger.warning(f"C15 lifespan: load_ml_models failed (non-fatal): {e}")
        return 0


@asynccontextmanager
async def lifespan(app: "FastAPI"):
    """FastAPI lifespan — единая точка lifecycle."""
    logger.info("C15 lifespan: startup phase begin")
    await init_db()
    await load_ml_models()

    # P4.1 — ensure per-vehicle linkage indexes. Idempotent.
    try:
        from app.vehicles.timeline import ensure_indexes as _p41_indexes
        await _p41_indexes()
        logger.info("P4.1 vehicle linkage: indexes ensured")
    except Exception as e:
        logger.warning(f"P4.1 vehicle linkage index ensure failed (non-fatal): {e}")

    # Sprint 2 Step 1 — Timeline Engine indexes. Idempotent.
    try:
        from app.inspector.timeline import ensure_timeline_indexes
        await ensure_timeline_indexes()
        logger.info("Sprint 2: timeline_events indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 2: timeline indexes ensure failed (non-fatal): {e}")

    # Sprint 2 Step 3 — MediaRepository indexes. Idempotent.
    try:
        from app.media.repository import ensure_media_indexes
        await ensure_media_indexes()
        logger.info("Sprint 2: inspection_media indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 2: media indexes ensure failed (non-fatal): {e}")

    # Sprint 2 Step 4 — Intelligence indexes. Idempotent.
    try:
        from app.intelligence.draft import ensure_intelligence_indexes
        await ensure_intelligence_indexes()
        logger.info("Sprint 2: inspection_drafts + ai_overrides_log indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 2: intelligence indexes ensure failed (non-fatal): {e}")

    # Sprint 2 Step 5 — Offline Replay audit log indexes. Idempotent.
    try:
        from app.inspector.offline_replay import _ensure_indexes as _ensure_replay_indexes
        from app.core.db import get_db as _get_db
        await _ensure_replay_indexes(_get_db())
        logger.info("Sprint 2: offline_replay_log indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 2: offline_replay_log indexes ensure failed (non-fatal): {e}")

    # Sprint 3 Step 1 — Verification Admin Queue indexes. Idempotent.
    try:
        from app.admin.verification_queue import ensure_indexes as _ensure_verif_indexes
        from app.core.db import get_db as _get_db
        await _ensure_verif_indexes(_get_db())
        logger.info("Sprint 3: inspector_verifications + verification_rejection_history indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 3: verification queue indexes ensure failed (non-fatal): {e}")

    # Sprint 3 Step 2 — Notification projector indexes. Idempotent.
    # Unique partial index on (userId, sourceTimelineId) — backbone of
    # idempotent projection.
    try:
        from app.notifications.projector import ensure_indexes as _ensure_notif_indexes
        from app.core.db import get_db as _get_db
        await _ensure_notif_indexes(_get_db())
        logger.info("Sprint 3: notifications projection indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 3: notifications indexes ensure failed (non-fatal): {e}")

    # Sprint Customer-Notify-2 — dry-run audit pipeline indexes.
    # Unique (sourceTimelineId, recipientUserId, channel) — idempotent
    # replay of the audit projector. Compound (recipient, createdAt) +
    # (kind, channel, createdAt) for the admin listing endpoint.
    try:
        from app.notifications.audit import ensure_audit_indexes as _ensure_cnotify_indexes
        from app.core.db import get_db as _get_db
        await _ensure_cnotify_indexes(_get_db())
        logger.info("Customer-Notify-2: audit indexes ensured")
    except Exception as e:
        logger.warning(f"Customer-Notify-2: audit indexes ensure failed (non-fatal): {e}")

    # Sprint Customer-Notify-3A — delivery lifecycle indexes.
    # Unique (auditRowId, deviceToken) — idempotent re-delivery.
    try:
        from app.notifications.delivery import ensure_lifecycle_indexes as _ensure_lc_indexes
        from app.core.db import get_db as _get_db
        await _ensure_lc_indexes(_get_db())
        logger.info("Customer-Notify-3A: delivery lifecycle indexes ensured")
    except Exception as e:
        logger.warning(f"Customer-Notify-3A: lifecycle indexes ensure failed (non-fatal): {e}")

    # Sprint Bounce-1 — suppression namespace indexes.
    # Append-only event log; unique (provider, providerEventId, kind).
    try:
        from app.notifications.suppression import ensure_suppression_indexes as _ensure_sup_indexes
        from app.core.db import get_db as _get_db
        await _ensure_sup_indexes(_get_db())
        logger.info("Bounce-1: suppression indexes ensured")
    except Exception as e:
        logger.warning(f"Bounce-1: suppression indexes ensure failed (non-fatal): {e}")

    # Sprint Notify-Pref-1 — preferences namespace indexes.
    # Append-only recipient-intent log. Latest-row-wins, kind-specific
    # beats channel-wide. Parallel-and-independent from suppression.
    try:
        from app.notifications.preferences import ensure_preference_indexes as _ensure_pref_indexes
        from app.core.db import get_db as _get_db
        await _ensure_pref_indexes(_get_db())
        logger.info("Notify-Pref-1: preferences indexes ensured")
    except Exception as e:
        logger.warning(f"Notify-Pref-1: preferences indexes ensure failed (non-fatal): {e}")

    # Sprint 3 Step 3 — Reputation engine indexes. Idempotent.
    try:
        from app.reputation.engine import ensure_indexes as _ensure_reputation_indexes
        from app.core.db import get_db as _get_db
        await _ensure_reputation_indexes(_get_db())
        logger.info("Sprint 3: reputation indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 3: reputation indexes ensure failed (non-fatal): {e}")

    # Sprint 3 Step 4 — Live assignments indexes. Idempotent.
    # Includes unique partial index enforcing one-accepted-per-job.
    try:
        from app.assignments.engine import ensure_indexes as _ensure_assignment_indexes
        from app.core.db import get_db as _get_db
        await _ensure_assignment_indexes(_get_db())
        logger.info("Sprint 3: assignments indexes ensured")
    except Exception as e:
        logger.warning(f"Sprint 3: assignments indexes ensure failed (non-fatal): {e}")

    # Vehicle Memory System — seed demo /vehicle/:id with rich history.
    # Idempotent (replace_one with upsert=True). Non-fatal on failure.
    try:
        from app.vehicles.public_memory import seed_demo_vehicle
        await seed_demo_vehicle()
        logger.info("VMS: demo vehicle seeded")
    except Exception as e:
        logger.warning(f"VMS: demo vehicle seed failed (non-fatal): {e}")

    # Temporal evolution layer — listing refresh worker + indexes.
    # Phase 3.4 C-2: vehicles_refresh promoted from PR-05 move-only
    # (Archetype A wrapper) to a true supervised worker. The supervisor
    # owns the while-loop, sleep, restart envelope, and telemetry.
    # `ensure_refresh_indexes()` stays adjacent (serves both worker and
    # /api/vms/* endpoints), called BEFORE worker start.
    try:
        from app.vehicles.refresh import ensure_refresh_indexes
        await ensure_refresh_indexes()
    except Exception as e:
        logger.warning(f"VMS: refresh indexes ensure failed (non-fatal): {e}")
    from app.workers.vehicles_refresh import register as _register_vehicles_refresh
    _register_vehicles_refresh(app)

    # Subscriptions / feed — indexes + demo watcher.
    try:
        from app.vehicles.watchlist import ensure_watchlist_indexes, seed_demo_watch
        await ensure_watchlist_indexes()
        await seed_demo_watch()
        logger.info("VMS: watchlist indexes ensured + demo watcher seeded")
    except Exception as e:
        logger.warning(f"VMS: watchlist init failed (non-fatal): {e}")

    # Saved searches / market subscriptions — indexes + demo search.
    try:
        from app.vehicles.market_searches import ensure_market_search_indexes, seed_demo_search
        await ensure_market_search_indexes()
        await seed_demo_search()
        logger.info("VMS: market_searches indexes ensured + demo search seeded")
    except Exception as e:
        logger.warning(f"VMS: market_searches init failed (non-fatal): {e}")

    # Geo-3 — demo provider_topology so Coverage projection is non-trivial.
    # Without this, every country tile shows providers=0 and the
    # operational observability surface loses its point.
    try:
        from app.geo.topology import seed_demo_topology
        await seed_demo_topology()
        logger.info("Geo-3: demo provider_topology seeded")
    except Exception as e:
        logger.warning(f"Geo-3: demo topology seed failed (non-fatal): {e}")

    # Car-Selection-1..5 — ensure indices on car_selection_requests,
    # car_selection_messages, car_selection_notifications, and
    # car_selection_artifacts. Without these, hot threads + inbox
    # list endpoints degrade quadratically as the data set grows.
    # All three calls are idempotent.
    try:
        from app.car_selection.repository import CarSelectionRepository
        from app.car_selection_thread.repository import ThreadRepository
        from app.car_selection_thread.artifacts import ArtifactRepository
        from app.core.db import get_db as _get_db
        _db = _get_db()
        await CarSelectionRepository(_db).ensure_indexes()
        await ThreadRepository(_db).ensure_indices()
        await ArtifactRepository(_db).ensure_indices()
        logger.info("Car-Selection: requests + thread + notifications + artifacts indices ensured")
    except Exception as e:
        logger.warning(f"Car-Selection: indices ensure failed (non-fatal): {e}")

    await bootstrap_side_effects()
    app.state.background_tasks = start_all_loops()
    # Sprint 28: Auto-bidding worker (every 15s)
    try:
        import asyncio
        from app.marketplace.auction import autobid_worker_loop
        app.state.autobid_task = asyncio.create_task(autobid_worker_loop(15))
        logger.info("C15 lifespan: autobid worker started")
    except Exception as e:
        logger.warning(f"C15 lifespan: autobid worker failed to start (non-fatal): {e}")

    # Phase 3 — Soft Marketplace: exposures lifecycle (B3 cluster siblings).
    # Phase 3D PR-02: `stats_recompute_loop` was extracted from this shared
    # block to `app.workers.exposures_stats` (registration below). The
    # remaining two siblings — `expire_loop` + `batching_loop` — stay
    # bundled here until PR-11 ships the B3 cluster extraction.
    try:
        import asyncio
        from app.auto_requests.exposures_cron import (
            ensure_exposure_indexes,
            expire_loop,
            batching_loop,
        )
        from app.auto_requests.feature_flags_helper import ensure_flags_seed
        await ensure_exposure_indexes()
        await ensure_flags_seed(default_use_exposures=True)
        app.state.exposures_expire_task = asyncio.create_task(expire_loop(60))
        app.state.exposures_batching_task = asyncio.create_task(batching_loop(60))
        logger.info("Phase 3: exposures loops started (expire=60s, batching=60s)")
    except Exception as e:
        logger.warning(f"Phase 3: exposures loops failed to start (non-fatal): {e}")

    # Phase 3D PR-02: stats recompute worker (Tier A carve-out).
    # Previously bundled in the B3 try-block above as the third
    # `asyncio.create_task` line. Now an independent registration.
    # Same task storage attribute (`app.state.exposures_stats_task`),
    # same cadence (300s), same worker self-emitted log line.
    from app.workers.exposures_stats import register as _register_exposures_stats
    _register_exposures_stats(app)

    # Sprint Customer-Notify-3A Phase B — delivery receipts poller.
    # Reconciles `notification_delivery_lifecycle` rows by enriching the
    # SAME row in place (deliveredAt | providerReceiptStatus). NEVER
    # inserts new rows. Invariant: one lifecycle row = one delivery attempt.
    #
    # Phase 3D PR-01: worker extracted to `app.workers.receipts_poll`.
    # Registration hook preserves the previous try/except envelope, the
    # `app.state.cnotify_receipts_task` storage attribute, the 180s
    # cadence, and the exact log line wording.
    from app.workers.receipts_poll import register as _register_receipts_poll
    _register_receipts_poll(app)

    # P6.C — Scheduled reconciliation snapshot worker.
    # Closes the doctrine asymmetry "human-triggered persistence" by
    # producing append-only `reconciliation_snapshots` rows on a fixed
    # cadence. NOT automation: the worker only writes evidence, never
    # acts on the divergence it observes. See
    # `memory/P6_C_reconciliation_cadence_closure_2026_05_22.md`.
    from app.workers.reconciliation_cadence import register as _register_reconciliation_cadence
    _register_reconciliation_cadence(app)

    logger.info("C15 lifespan: startup phase complete")

    # Phase 4 Sprint A — seed default integration credentials (idempotent).
    try:
        from app.integrations.seed import seed_defaults
        from app.core.db import db as _db
        await seed_defaults(db=_db)
    except Exception as e:
        logger.warning(f"integrations.seed failed (non-fatal): {e}")

    yield
    logger.info("C15 lifespan: shutdown phase begin")
    # Phase 3.4 C-2: graceful supervised-worker shutdown BEFORE the
    # generic shutdown_cleanup. Bounded wait_for in supervisor.stop() —
    # any worker that doesn't exit within timeout emits a pending-task
    # warning. Currently the only supervised worker is `vehicles_refresh`;
    # legacy `asyncio.create_task` workers (receipts_poll, exposures_stats,
    # etc.) are still cancelled by interpreter teardown.
    try:
        from app.core.worker_supervisor import supervisor as _supervisor
        await _supervisor.stop_all(timeout=5.0)
    except Exception as e:
        logger.warning(f"C15 lifespan: worker_supervisor stop_all error (non-fatal): {e}")
    try:
        await shutdown_cleanup()
    except Exception as e:
        logger.warning(f"C15 lifespan: shutdown_cleanup error (non-fatal): {e}")
    logger.info("C15 lifespan: shutdown phase complete")
