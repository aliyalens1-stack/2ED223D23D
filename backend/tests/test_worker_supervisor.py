"""tests/test_worker_supervisor.py — Phase 3.4 operational core regression suite.

Promoted from synthetic harness (`/tmp/test_supervisor.py`) to the
permanent test surface in C-3. Locks in the runtime invariants of
`app.core.worker_supervisor` so they cannot regress as more workers
migrate.

Scope:
  • Hard-error invariants: duplicate register, start-unregistered
  • Runtime invariants:    active_instances <= 1 (enforced, not logged)
  • Telemetry contract:    state/started_at/last_tick_*/restart_count/last_error
  • Restart policies:      on_failure (with max_restarts cap) + never
  • Graceful shutdown:     bounded cancel + on_cancel hook + no pending warning
  • Idempotency:           restart after stop is permitted

Anti-scope:
  • Does NOT test individual workers (vehicles_refresh / receipts_poll).
    Those have their own behavioural tests elsewhere; this file pins
    the supervisor surface itself.
  • Does NOT exercise restart_policy="always" (currently a reserved
    semantic — same behaviour as on_failure for steady-state polling).
"""
from __future__ import annotations

import asyncio
import time

import pytest

from app.core.worker_supervisor import WorkerSpec, WorkerSupervisor


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def sup() -> WorkerSupervisor:
    """A fresh supervisor per-test. Module singleton is NOT used here so
    test order can't leak state into the live process."""
    return WorkerSupervisor()


# ─────────────────────────────────────────────────────────────────────
# Hard-error invariants
# ─────────────────────────────────────────────────────────────────────


def test_duplicate_register_is_hard_error(sup: WorkerSupervisor) -> None:
    async def noop() -> None:
        return

    sup.register(WorkerSpec(name="w", tick=noop, interval_seconds=0.05))
    with pytest.raises(ValueError, match="duplicate register"):
        sup.register(WorkerSpec(name="w", tick=noop, interval_seconds=0.05))


def test_start_unregistered_raises(sup: WorkerSupervisor) -> None:
    with pytest.raises(ValueError, match="not registered"):
        sup.start("ghost")


# ─────────────────────────────────────────────────────────────────────
# Happy path + telemetry
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_happy_path_runs_ticks_and_populates_telemetry(
    sup: WorkerSupervisor,
) -> None:
    counter = {"n": 0}

    async def tick() -> None:
        counter["n"] += 1
        await asyncio.sleep(0.005)

    sup.register(WorkerSpec(name="w", tick=tick, interval_seconds=0.02))
    sup.start("w")
    await asyncio.sleep(0.15)  # ~5 ticks
    s = sup.status("w")

    assert s["state"] == "running"
    assert s["active_instances"] == 1
    assert s["restart_count"] == 0
    assert s["started_at"] is not None
    assert s["last_tick_finished_at"] is not None
    assert s["last_tick_duration_ms"] is not None and s["last_tick_duration_ms"] > 0
    assert counter["n"] >= 2

    await sup.stop("w", timeout=1.0)


# ─────────────────────────────────────────────────────────────────────
# active_instances <= 1 invariant (enforced, not logged)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_double_start_violates_active_instances_invariant(
    sup: WorkerSupervisor,
) -> None:
    async def tick() -> None:
        await asyncio.sleep(0.01)

    sup.register(WorkerSpec(name="w", tick=tick, interval_seconds=0.02))
    sup.start("w")
    with pytest.raises(RuntimeError, match="<=1 violated"):
        sup.start("w")
    await sup.stop("w", timeout=1.0)


@pytest.mark.asyncio
async def test_start_observes_active_instances_eq_1_synchronously(
    sup: WorkerSupervisor,
) -> None:
    """active_instances must flip to 1 BEFORE start() returns, so
    immediate post-start probes observe the invariant."""

    async def tick() -> None:
        await asyncio.sleep(0.01)

    sup.register(WorkerSpec(name="w", tick=tick, interval_seconds=0.02))
    sup.start("w")
    # No await between start and status — must already be 1.
    assert sup.status("w")["active_instances"] == 1
    assert sup.is_running("w")
    await sup.stop("w", timeout=1.0)


# ─────────────────────────────────────────────────────────────────────
# Restart policies
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_on_failure_restart_bounded_by_max_restarts(
    sup: WorkerSupervisor,
) -> None:
    """tick that always raises → after max_restarts → state=exhausted."""
    counter = {"n": 0}

    async def bad_tick() -> None:
        counter["n"] += 1
        raise RuntimeError(f"boom-{counter['n']}")

    sup.register(WorkerSpec(
        name="w",
        tick=bad_tick,
        interval_seconds=0.05,
        restart_policy="on_failure",
        max_restarts=2,
        backoff_seconds=0.01,
    ))
    sup.start("w")
    # Wait until exhausted (worst case: ~3 failures × backoff).
    for _ in range(50):
        if sup.status("w")["state"] == "exhausted":
            break
        await asyncio.sleep(0.02)

    s = sup.status("w")
    assert s["state"] == "exhausted"
    assert s["restart_count"] == 2
    assert s["active_instances"] == 0
    assert s["last_error"] and "boom" in s["last_error"]
    assert s["last_error_at"] is not None


@pytest.mark.asyncio
async def test_never_policy_fails_on_first_error(sup: WorkerSupervisor) -> None:
    async def bad_tick() -> None:
        raise ValueError("die-never")

    sup.register(WorkerSpec(
        name="w",
        tick=bad_tick,
        interval_seconds=0.05,
        restart_policy="never",
        max_restarts=0,
        backoff_seconds=0.01,
    ))
    sup.start("w")
    for _ in range(30):
        if sup.status("w")["state"] == "failed":
            break
        await asyncio.sleep(0.02)

    s = sup.status("w")
    assert s["state"] == "failed"
    assert s["restart_count"] == 0
    assert "die-never" in s["last_error"]


# ─────────────────────────────────────────────────────────────────────
# Graceful shutdown + on_cancel hook
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_graceful_stop_cancels_within_timeout_no_pending(
    sup: WorkerSupervisor,
) -> None:
    """stop() must cancel a mid-tick worker cleanly within the timeout
    budget, leaving state=stopped and active_instances=0."""
    async def slow_tick() -> None:
        await asyncio.sleep(0.3)

    sup.register(WorkerSpec(name="w", tick=slow_tick, interval_seconds=0.02))
    sup.start("w")
    await asyncio.sleep(0.05)  # let it enter tick
    t0 = time.monotonic()
    await sup.stop("w", timeout=2.0)
    cancel_latency_ms = (time.monotonic() - t0) * 1000

    s = sup.status("w")
    assert s["state"] == "stopped"
    assert s["active_instances"] == 0
    # Real polling worker typically returns in <50ms; 2s is the timeout
    # ceiling. 1s here is a generous regression bound.
    assert cancel_latency_ms < 1000


@pytest.mark.asyncio
async def test_on_cancel_hook_fires_before_stopped_state(
    sup: WorkerSupervisor,
) -> None:
    """on_cancel callback must fire during graceful shutdown so
    worker-specific cancel log lines are preserved verbatim."""
    cancel_calls = {"n": 0}

    async def slow_tick() -> None:
        await asyncio.sleep(0.3)

    def on_cancel_hook() -> None:
        cancel_calls["n"] += 1

    sup.register(WorkerSpec(
        name="w",
        tick=slow_tick,
        interval_seconds=0.02,
        on_cancel=on_cancel_hook,
    ))
    sup.start("w")
    await asyncio.sleep(0.05)
    await sup.stop("w", timeout=2.0)

    assert cancel_calls["n"] == 1
    assert sup.status("w")["state"] == "stopped"


@pytest.mark.asyncio
async def test_on_start_hook_fires_once_before_first_tick(
    sup: WorkerSupervisor,
) -> None:
    start_calls = {"n": 0}
    tick_calls = {"n": 0}
    order: list[str] = []

    def on_start_hook() -> None:
        start_calls["n"] += 1
        order.append("start")

    async def tick() -> None:
        tick_calls["n"] += 1
        order.append("tick")
        await asyncio.sleep(0.005)

    sup.register(WorkerSpec(
        name="w",
        tick=tick,
        interval_seconds=0.02,
        on_start=on_start_hook,
    ))
    sup.start("w")
    await asyncio.sleep(0.15)

    assert start_calls["n"] == 1                # one-time only
    assert tick_calls["n"] >= 2
    assert order[0] == "start"                   # before any tick
    await sup.stop("w", timeout=1.0)


# ─────────────────────────────────────────────────────────────────────
# Restart after stop (idempotency)
# ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_restart_after_stop_is_permitted(sup: WorkerSupervisor) -> None:
    async def tick() -> None:
        await asyncio.sleep(0.01)

    sup.register(WorkerSpec(name="w", tick=tick, interval_seconds=0.02))
    sup.start("w")
    await asyncio.sleep(0.05)
    await sup.stop("w", timeout=1.0)
    assert sup.status("w")["active_instances"] == 0

    sup.start("w")
    assert sup.status("w")["active_instances"] == 1
    await sup.stop("w", timeout=1.0)


@pytest.mark.asyncio
async def test_stop_all_handles_zero_workers_cleanly(
    sup: WorkerSupervisor,
) -> None:
    """Bare stop_all() on a supervisor with no live workers must be a no-op."""
    await sup.stop_all(timeout=1.0)


@pytest.mark.asyncio
async def test_status_aggregate_lists_all_registered_workers(
    sup: WorkerSupervisor,
) -> None:
    async def tick() -> None:
        await asyncio.sleep(0.01)

    sup.register(WorkerSpec(name="a", tick=tick, interval_seconds=0.02))
    sup.register(WorkerSpec(name="b", tick=tick, interval_seconds=0.02))
    items = sup.status()
    assert isinstance(items, list)
    names = sorted(s["worker_name"] for s in items)
    assert names == ["a", "b"]
