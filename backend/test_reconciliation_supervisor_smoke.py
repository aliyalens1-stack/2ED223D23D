#!/usr/bin/env python3
"""Sprint B4.3-A.3 — supervisor severity classifier smoke (pure).

Phase A: deterministic ``classify_severity`` over 8 synthetic inputs.
No DB. No I/O. No FS writes. No imports from ``reconciliation.py`` —
only from the supervisor module under test.

Run:
    cd /app/backend
    python test_reconciliation_supervisor_smoke.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# Make `scripts.*` importable when run from /app/backend.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scripts.reconciliation_supervisor import (  # noqa: E402
    HIGH_SEVERITY_CODES,
    classify_severity,
)


def main() -> int:
    asserted = 0

    def _eq(label: str, got: object, want: object) -> None:
        nonlocal asserted
        assert got == want, f"[{label}] got={got!r} want={want!r}"
        asserted += 1

    # 1. Empty mapping → NONE.
    _eq("empty", classify_severity({}), "NONE")

    # 2. None-ish empty defaults.
    _eq("falsy", classify_severity({} or {}), "NONE")

    # 3. WARN-only codes → WARN.
    _eq("warn.unknown_status",
        classify_severity({"UNKNOWN_STATUS": 1}), "WARN")
    _eq("warn.released_no_timestamp",
        classify_severity({"RELEASED_NO_TIMESTAMP": 7}), "WARN")
    _eq("warn.multiple_warn_codes",
        classify_severity({
            "UNKNOWN_STATUS": 2,
            "DISPUTED_NO_TIMESTAMP": 1,
            "PAID_HAS_RELEASE_FIELDS": 3,
            "MISSING_CUSTOMER": 1,
        }),
        "WARN")

    # 4. HIGH money-correctness codes → HIGH.
    _eq("high.negative_amount",
        classify_severity({"NEGATIVE_AMOUNT": 1}), "HIGH")
    _eq("high.drift",
        classify_severity({"GROSS_PAYOUT_REFUND_DRIFT": 1}), "HIGH")

    # 5. Any HIGH alongside WARN codes → still HIGH.
    _eq("high.mixed",
        classify_severity({
            "UNKNOWN_STATUS": 5,
            "RELEASED_NO_TIMESTAMP": 3,
            "GROSS_PAYOUT_REFUND_DRIFT": 1,
        }),
        "HIGH")

    # 6. Both HIGH codes together → HIGH (not "CRITICAL", not "HIGHER").
    _eq("high.both",
        classify_severity({
            "NEGATIVE_AMOUNT": 2,
            "GROSS_PAYOUT_REFUND_DRIFT": 1,
        }),
        "HIGH")

    # 7. HIGH_SEVERITY_CODES is frozen + exactly the two documented codes.
    _eq("high_codes.is_frozenset",
        isinstance(HIGH_SEVERITY_CODES, frozenset), True)
    _eq("high_codes.contents",
        HIGH_SEVERITY_CODES,
        frozenset({"NEGATIVE_AMOUNT", "GROSS_PAYOUT_REFUND_DRIFT"}))

    # 8. Sanity: classifier is pure — same input twice == same output.
    sample = {"UNKNOWN_STATUS": 1, "NEGATIVE_AMOUNT": 1}
    _eq("idempotent.first", classify_severity(sample), "HIGH")
    _eq("idempotent.second", classify_severity(sample), "HIGH")
    _eq("idempotent.input_unchanged", sample,
        {"UNKNOWN_STATUS": 1, "NEGATIVE_AMOUNT": 1})

    # 9. Codes outside both sets are silently WARN (forward-compat: a
    #    future new detector won't accidentally fire HIGH).
    _eq("warn.unknown_future_code",
        classify_severity({"SOME_FUTURE_CODE_42": 99}), "WARN")

    print(f"✅ reconciliation_supervisor smoke OK — {asserted} assertions green")
    return 0


if __name__ == "__main__":
    sys.exit(main())
