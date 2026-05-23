"""app.core.worker_supervisor — Phase 3.4 C-2 runtime supervision layer.

First true supervised polling worker abstraction. Explicit, NOT a generic
framework. The supervisor owns the while-loop, sleep, restart envelope, and
telemetry for each registered worker; the worker owns only one tick body.

Scope (deliberately narrow):
  • register(spec) / start(name) / stop(name) / stop_all() / status(name?)
  • Restart policies: never | on_failure | always (bounded by max_restarts)
  • Bounded fixed backoff (no exponential sophistication)
  • Invariants enforced (NOT logged):
      - active_instances <= 1 per worker (hard runtime check on start)
      - duplicate register(name) -> ValueError
  • Telemetry per worker (in-memory only):
      worker_name, state, restart_count, started_at,
      last_tick_started_at, last_tick_finished_at, last_tick_duration_ms,
      last_error, last_error_at, active_instances
  • Graceful shutdown: cancel + bounded wait_for + warning on timeout,
    no pending-task leak
  • Structured logs for state transitions; per-tick stats stay in memory

Anti-scope (intentionally absent):
  • No decorators, DI, auto-discovery, plugins, metaclasses, dynamic registries
  • No admin endpoint surface (deferred)
  • No Prometheus, histograms, tracing
  • No generic supervision base class beyond this module

Rollout: only `vehicles_refresh` migrates in C-2. Archetype A wrappers
(receipts_poll, exposures_stats, etc.) remain move-only. Subsequent workers
migrate one-at-a-time in later phases.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Awaitable, Callable, Literal, Optional, Union


logger = logging.getLogger("worker_supervisor")

RestartPolicy = Literal["never", "on_failure", "always"]
WorkerState = Literal[
    "pending", "starting", "running", "stopping", "stopped", "failed", "exhausted"
]


# ─────────────────────────────────────────────────────────────────────
# Spec & status
# ─────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class WorkerSpec:
    """Describes a supervised polling worker.

    `tick` is a coroutine factory invoked ONCE per cycle by the supervisor.
    The supervisor owns the while-loop + sleep + restart envelope; the
    worker owns only the body of a single tick (one batch / one poll).
    """
    name: str
    tick: Callable[[], Awaitable[None]]
    interval_seconds: float
    restart_policy: RestartPolicy = "on_failure"
    max_restarts: int = 5
    backoff_seconds: float = 5.0
    # Called once before the first tick. Use to emit worker-specific
    # startup log lines that must remain verbatim across the C-2 migration.
    on_start: Optional[Callable[[], None]] = None
    # Called inside the supervisor's CancelledError handler, BEFORE re-raise.
    # Use to emit worker-specific shutdown/cancellation log lines that
    # originally lived inside the worker's own loop body.
    on_cancel: Optional[Callable[[], None]] = None


@dataclass
class WorkerStatus:
    worker_name: str
    state: WorkerState = "pending"
    restart_count: int = 0
    started_at: Optional[datetime] = None
    last_tick_started_at: Optional[datetime] = None
    last_tick_finished_at: Optional[datetime] = None
    last_tick_duration_ms: Optional[float] = None
    last_error: Optional[str] = None
    last_error_at: Optional[datetime] = None
    active_instances: int = 0


# ─────────────────────────────────────────────────────────────────────
# Supervisor
# ─────────────────────────────────────────────────────────────────────

class WorkerSupervisor:
    """Explicit supervisor — register / start / stop / status only.

    Singleton instance lives at module level: `supervisor`.
    No factory, no lazy init.
    """

    def __init__(self) -> None:
        self._specs: dict[str, WorkerSpec] = {}
        self._status: dict[str, WorkerStatus] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    # --- Registration --------------------------------------------------

    def register(self, spec: WorkerSpec) -> None:
        """Register a worker. Hard error on duplicate name."""
        if spec.name in self._specs:
            raise ValueError(
                f"worker_supervisor: duplicate register('{spec.name}') "
                "— hard error"
            )
        self._specs[spec.name] = spec
        self._status[spec.name] = WorkerStatus(worker_name=spec.name, state="pending")
        logger.info(
            f"worker_supervisor: registered worker={spec.name} "
            f"interval={spec.interval_seconds}s policy={spec.restart_policy} "
            f"max_restarts={spec.max_restarts}"
        )

    # --- Lifecycle -----------------------------------------------------

    def start(self, name: str) -> None:
        """Start a registered worker. Enforces active_instances <= 1."""
        if name not in self._specs:
            raise ValueError(
                f"worker_supervisor: start('{name}') — not registered"
            )
        st = self._status[name]
        if st.active_instances >= 1:
            raise RuntimeError(
                f"worker_supervisor: start('{name}') — "
                f"active_instances={st.active_instances}, invariant <=1 violated"
            )
        st.state = "starting"
        st.started_at = datetime.now(timezone.utc)
        # Set active_instances=1 SYNCHRONOUSLY so a caller that probes
        # status() immediately after start() observes the invariant.
        # Idempotent in _run() (held at 1 until finally-block exits).
        st.active_instances = 1
        task = asyncio.create_task(self._run(name), name=f"worker:{name}")
        self._tasks[name] = task

    async def stop(self, name: str, timeout: float = 5.0) -> None:
        """Stop a running worker. Bounded cancellation; no pending-task leak."""
        if name not in self._tasks:
            return
        task = self._tasks[name]
        st = self._status[name]
        if task.done():
            self._tasks.pop(name, None)
            st.active_instances = 0
            return
        st.state = "stopping"
        cancel_started = datetime.now(timezone.utc)
        task.cancel()
        try:
            await asyncio.wait_for(self._await_silent(task), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning(
                f"worker_supervisor: worker={name} did not exit within "
                f"{timeout}s — task.done={task.done()} (pending-task warning)"
            )
        cancel_latency_ms = (
            datetime.now(timezone.utc) - cancel_started
        ).total_seconds() * 1000.0
        logger.info(
            f"worker_supervisor: stopped worker={name} "
            f"cancel_latency_ms={cancel_latency_ms:.1f}"
        )
        st.state = "stopped"
        st.active_instances = 0
        self._tasks.pop(name, None)

    async def stop_all(self, timeout: float = 5.0) -> None:
        """Stop all workers in parallel; per-worker timeout."""
        names = list(self._tasks.keys())
        if not names:
            return
        logger.info(
            f"worker_supervisor: stop_all begin (workers={len(names)} "
            f"timeout={timeout}s)"
        )
        await asyncio.gather(
            *(self.stop(n, timeout=timeout) for n in names),
            return_exceptions=True,
        )
        logger.info("worker_supervisor: stop_all complete")

    # --- Inspection ----------------------------------------------------

    def status(self, name: Optional[str] = None) -> Union[dict, list[dict]]:
        if name is not None:
            if name not in self._status:
                raise KeyError(f"worker_supervisor: unknown worker '{name}'")
            return self._dump(self._status[name])
        return [self._dump(s) for s in self._status.values()]

    def is_running(self, name: str) -> bool:
        st = self._status.get(name)
        return bool(st and st.active_instances >= 1)

    def get_task(self, name: str) -> Optional[asyncio.Task]:
        """Read-only handle to the underlying task (e.g. for app.state compat)."""
        return self._tasks.get(name)

    def registered(self, name: str) -> bool:
        return name in self._specs

    # --- Internals -----------------------------------------------------

    @staticmethod
    async def _await_silent(task: asyncio.Task) -> None:
        """Await a task, swallowing CancelledError and final exceptions.

        Logging is done inside _run(); the caller of stop() just needs
        a clean awaitable.
        """
        try:
            await task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            return

    @staticmethod
    def _dump(s: WorkerStatus) -> dict:
        return {
            "worker_name": s.worker_name,
            "state": s.state,
            "restart_count": s.restart_count,
            "started_at": s.started_at.isoformat() if s.started_at else None,
            "last_tick_started_at": (
                s.last_tick_started_at.isoformat() if s.last_tick_started_at else None
            ),
            "last_tick_finished_at": (
                s.last_tick_finished_at.isoformat() if s.last_tick_finished_at else None
            ),
            "last_tick_duration_ms": s.last_tick_duration_ms,
            "last_error": s.last_error,
            "last_error_at": s.last_error_at.isoformat() if s.last_error_at else None,
            "active_instances": s.active_instances,
        }

    async def _run(self, name: str) -> None:
        """Supervisor envelope for a single worker.

        Owns: while-loop, sleep, telemetry, restart bookkeeping, backoff.
        Delegates: one tick body via spec.tick().
        """
        spec = self._specs[name]
        st = self._status[name]
        st.active_instances = 1
        st.state = "running"

        # One-time worker-emitted start hook (preserves original log wording).
        if spec.on_start is not None:
            try:
                spec.on_start()
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    f"worker_supervisor: on_start({name}) raised (non-fatal): {e}"
                )

        try:
            while True:
                tick_started = datetime.now(timezone.utc)
                st.last_tick_started_at = tick_started
                try:
                    await spec.tick()
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    tick_finished = datetime.now(timezone.utc)
                    st.last_tick_finished_at = tick_finished
                    st.last_tick_duration_ms = (
                        tick_finished - tick_started
                    ).total_seconds() * 1000.0
                    st.last_error = f"{type(e).__name__}: {e}"
                    st.last_error_at = tick_finished

                    if spec.restart_policy == "never":
                        st.state = "failed"
                        logger.warning(
                            f"worker_supervisor: worker={name} failed "
                            f"(restart_policy=never) — {st.last_error}"
                        )
                        return
                    if st.restart_count >= spec.max_restarts:
                        st.state = "exhausted"
                        logger.warning(
                            f"worker_supervisor: worker={name} exhausted "
                            f"restart_count={st.restart_count} "
                            f"max_restarts={spec.max_restarts} — {st.last_error}"
                        )
                        return
                    st.restart_count += 1
                    logger.warning(
                        f"worker_supervisor: worker={name} tick failed "
                        f"restart={st.restart_count}/{spec.max_restarts} "
                        f"backoff={spec.backoff_seconds}s — {st.last_error}"
                    )
                    await asyncio.sleep(spec.backoff_seconds)
                    continue
                else:
                    tick_finished = datetime.now(timezone.utc)
                    st.last_tick_finished_at = tick_finished
                    st.last_tick_duration_ms = (
                        tick_finished - tick_started
                    ).total_seconds() * 1000.0

                # restart_policy "always" — same semantics as on_failure for
                # steady-state polling (no forced crash-loop). Documented; no
                # behavioural difference until/unless we add forced-restart.
                await asyncio.sleep(spec.interval_seconds)
        except asyncio.CancelledError:
            # Worker-specific cancel hook (e.g. preserves a verbatim log
            # line that previously lived inside the worker's own loop body).
            if spec.on_cancel is not None:
                try:
                    spec.on_cancel()
                except Exception as e:  # noqa: BLE001
                    logger.warning(
                        f"worker_supervisor: on_cancel({name}) raised "
                        f"(non-fatal): {e}"
                    )
            st.state = "stopped"
            raise
        finally:
            st.active_instances = 0


# Module-level singleton — explicit (no factory, no lazy init).
supervisor = WorkerSupervisor()


__all__ = ["WorkerSpec", "WorkerStatus", "WorkerSupervisor", "supervisor"]
