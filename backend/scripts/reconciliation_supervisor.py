#!/usr/bin/env python3
"""Sprint B4.3-A.3 — Nightly reconciliation supervisor hook.

A *thin* orchestration layer above ``run_reconciliation_audit.py`` /
``app.payments.reconciliation.generate_report``:

  1. Runs the existing read-only audit.
  2. Writes the same JSON + MD artefacts to ``/app/audit/``.
  3. If ``divergenceCountsByCode`` is non-empty → emits ONE structured
     warning line (stdlib ``logging.warning``) carrying:
       - severity (HIGH if money-correctness codes triggered, else WARN)
       - total divergence count
       - breakdown by code
       - artefact paths
  4. Exits 0 always (this is detection-only; the operator decides).

Doctrine (held narrow, per closure doc § next pickable steps):

  * ❌ NO auto-fix         (no DB mutation anywhere)
  * ❌ NO dashboards       (no Mongo collection, no admin endpoint)
  * ❌ NO websocket / push (no realtime fanout)
  * ❌ NO alerting abstraction (uses stdlib ``logging`` only)
  * ❌ NO new event in ``structured_log.EVENTS`` (that whitelist is for
        money events; we stay out of it)
  * ❌ NO new collection / index / field
  * ❌ NO coupling to writer.py / realtime / webhooks

Usage:

    # one-shot (cron-style, supervisorctl start-and-exit)
    python /app/backend/scripts/reconciliation_supervisor.py

    # one-shot with sampling
    python /app/backend/scripts/reconciliation_supervisor.py --limit 10000

    # daemon-style (supervisor with autorestart). Runs once on start,
    # then every --interval-seconds (default 86400 = nightly).
    python /app/backend/scripts/reconciliation_supervisor.py --loop

    # daemon-style anchored to a daily clock hour (UTC):
    python /app/backend/scripts/reconciliation_supervisor.py --loop --hour 3

Sample supervisor program (NOT installed by default; opt-in):

    [program:reconciliation-supervisor]
    command=/root/.venv/bin/python /app/backend/scripts/reconciliation_supervisor.py --loop --hour 3
    directory=/app/backend
    autostart=false
    autorestart=true
    stderr_logfile=/var/log/supervisor/reconciliation.err.log
    stdout_logfile=/var/log/supervisor/reconciliation.out.log
    stopsignal=TERM
    stopwaitsecs=10

Operator opt-in:

    sudo cp /app/backend/scripts/reconciliation_supervisor.conf \
            /etc/supervisor/conf.d/
    sudo supervisorctl reread && sudo supervisorctl update
    sudo supervisorctl start reconciliation-supervisor

Output / grep cheat-sheet:

    grep '"event":"reconciliation.audit.completed"' \
         /var/log/supervisor/reconciliation.out.log

    grep '"severity":"HIGH"' \
         /var/log/supervisor/reconciliation.out.log
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, FrozenSet, Optional

# Allow running as ``python scripts/reconciliation_supervisor.py`` from
# /app/backend without env tweaks. Mirrors run_reconciliation_audit.py.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.payments.reconciliation import generate_report  # noqa: E402
# Re-use the markdown renderer from the existing CLI so the artefact
# format is byte-identical (no duplicated formatting code).
from scripts.run_reconciliation_audit import render_markdown  # noqa: E402


MONGO = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
AUDIT_DIR = Path(os.environ.get("RECONCILIATION_OUT_DIR", "/app/audit"))


# ────────────────────────────────────────────────────────────────────
# Severity classifier — pure function.
#
# HIGH-severity divergence codes are the ones that imply a real money
# correctness breach (not a stale field or a missing timestamp):
#
#   NEGATIVE_AMOUNT            → impossible monetary value present
#   GROSS_PAYOUT_REFUND_DRIFT  → conservation breach
#     (gross ≉ payout + refund + commission, tolerance 0.01)
#
# Everything else (UNKNOWN_STATUS, *_NO_TIMESTAMP, PAID_HAS_*, etc.)
# is WARN-severity — visible but not money-breaking on its own.
#
# Source of truth for code names is closure doc B4.3-A.1 §4.
# ────────────────────────────────────────────────────────────────────

HIGH_SEVERITY_CODES: FrozenSet[str] = frozenset(
    {"NEGATIVE_AMOUNT", "GROSS_PAYOUT_REFUND_DRIFT"}
)


def classify_severity(divergence_counts: Dict[str, int]) -> str:
    """Return ``"NONE"`` / ``"WARN"`` / ``"HIGH"``.

    Pure, deterministic, no side-effects. Empty mapping → ``"NONE"``.
    Any HIGH code present → ``"HIGH"`` regardless of other codes.
    Otherwise ``"WARN"``.
    """
    if not divergence_counts:
        return "NONE"
    for code in divergence_counts:
        if code in HIGH_SEVERITY_CODES:
            return "HIGH"
    return "WARN"


# ────────────────────────────────────────────────────────────────────
# One-shot runner.
# ────────────────────────────────────────────────────────────────────

_logger = logging.getLogger("reconciliation-supervisor")


async def _run_once(limit: Optional[int], out_dir: Path) -> int:
    """Run the audit once. Returns OS-style exit code (always 0)."""
    out_dir.mkdir(parents=True, exist_ok=True)

    client = AsyncIOMotorClient(MONGO)
    db = client[DB_NAME]
    try:
        report = await generate_report(db, limit=limit)
    finally:
        client.close()

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    json_path = out_dir / f"reconciliation_{stamp}.json"
    md_path = out_dir / f"reconciliation_{stamp}.md"

    with json_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    with md_path.open("w", encoding="utf-8") as f:
        f.write(render_markdown(report))

    divergence_counts: Dict[str, int] = report.get("divergenceCountsByCode") or {}
    severity = classify_severity(divergence_counts)
    total_divergences = sum(divergence_counts.values())

    # Always emit a "completed" envelope at INFO so a log scrape can
    # confirm the cadence ran. Single line. JSON. No prose.
    completed_envelope = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": "reconciliation.audit.completed",
        "level": "INFO",
        "scope": report.get("scope"),
        "totalDocs": report.get("totalDocs"),
        "limit": report.get("limit"),
        "severity": severity,
        "totalDivergences": total_divergences,
        "artefactJson": str(json_path),
        "artefactMd": str(md_path),
    }
    _logger.info(json.dumps(completed_envelope, ensure_ascii=False))

    # If there is anything to look at, emit ONE additional warning line
    # carrying severity + breakdown. WARN at logging.WARNING; HIGH at
    # logging.ERROR (still no stack trace — this is detection, not an
    # exception).
    if severity != "NONE":
        warn_envelope = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": "reconciliation.audit.divergences_detected",
            "level": "ERROR" if severity == "HIGH" else "WARN",
            "severity": severity,
            "totalDivergences": total_divergences,
            "countsByCode": divergence_counts,
            "highSeverityCodes": sorted(
                code for code in divergence_counts if code in HIGH_SEVERITY_CODES
            ),
            "artefactJson": str(json_path),
            "artefactMd": str(md_path),
        }
        line = json.dumps(warn_envelope, ensure_ascii=False)
        if severity == "HIGH":
            _logger.error(line)
        else:
            _logger.warning(line)

    return 0


# ────────────────────────────────────────────────────────────────────
# Loop runner (supervisor-friendly).
#
# Tiny scheduler: if --hour is set, sleep until next HH:00 UTC and run.
# Otherwise just run every --interval-seconds.
# Never crashes on audit failure (logs and waits for next slot).
# ────────────────────────────────────────────────────────────────────


def _seconds_until_next_hour(target_hour_utc: int) -> int:
    now = datetime.now(timezone.utc)
    target = now.replace(hour=target_hour_utc, minute=0, second=0, microsecond=0)
    if target <= now:
        target = target + timedelta(days=1)
    return int((target - now).total_seconds())


async def _run_loop(
    limit: Optional[int],
    out_dir: Path,
    interval_seconds: int,
    target_hour_utc: Optional[int],
) -> int:
    # Run once immediately on start so a fresh deploy always produces a
    # baseline artefact, then settle into the cadence.
    while True:
        try:
            await _run_once(limit=limit, out_dir=out_dir)
        except Exception as exc:  # pragma: no cover - operational guard
            _logger.error(json.dumps({
                "ts": datetime.now(timezone.utc).isoformat(),
                "event": "reconciliation.audit.failed",
                "level": "ERROR",
                "error": str(exc)[:500],
            }, ensure_ascii=False))

        if target_hour_utc is not None:
            wait_s = _seconds_until_next_hour(target_hour_utc)
        else:
            wait_s = interval_seconds

        _logger.info(json.dumps({
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": "reconciliation.audit.scheduled",
            "level": "INFO",
            "nextRunInSeconds": wait_s,
        }, ensure_ascii=False))

        await asyncio.sleep(wait_s)


# ────────────────────────────────────────────────────────────────────
# CLI
# ────────────────────────────────────────────────────────────────────


def _build_argparser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Nightly reconciliation supervisor hook (thin layer over "
                    "app.payments.reconciliation.generate_report). READ-ONLY.",
    )
    p.add_argument("--limit", type=int, default=None,
                   help="Sample limit (default: all rows)")
    p.add_argument("--out-dir", type=str, default=str(AUDIT_DIR),
                   help=f"Artefact directory (default: {AUDIT_DIR})")
    p.add_argument("--loop", action="store_true",
                   help="Stay alive and re-run on a cadence. Without this "
                        "flag the script does one audit and exits.")
    p.add_argument("--interval-seconds", type=int, default=86400,
                   help="Loop interval (default: 86400 = 24h). Ignored if "
                        "--hour is set.")
    p.add_argument("--hour", type=int, default=None,
                   help="Anchor loop to a daily UTC clock hour (0–23). "
                        "Overrides --interval-seconds.")
    return p


async def _async_main(argv: Optional[list] = None) -> int:
    args = _build_argparser().parse_args(argv)

    # Stdlib logging — JSON envelopes go to stdout, captured by
    # supervisor → /var/log/supervisor/<program>.out.log
    logging.basicConfig(
        level=logging.INFO,
        format="%(message)s",
        stream=sys.stdout,
    )

    if args.hour is not None and not (0 <= args.hour <= 23):
        print("--hour must be in [0, 23]", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)

    if args.loop:
        return await _run_loop(
            limit=args.limit,
            out_dir=out_dir,
            interval_seconds=args.interval_seconds,
            target_hour_utc=args.hour,
        )
    return await _run_once(limit=args.limit, out_dir=out_dir)


def main(argv: Optional[list] = None) -> int:
    return asyncio.run(_async_main(argv))


if __name__ == "__main__":
    sys.exit(main())
