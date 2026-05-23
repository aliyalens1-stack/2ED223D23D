"""Pricing version registry — frozen calculator history.

CRITICAL INVARIANT:
  Once a version is committed (i.e. used to confirm any projection in
  production), its calculator MUST stay byte-identical. Forever.

  We do not "fix bugs" in v1. We add v2 and route NEW requests through it.
  Old confirmed quotes keep referring to v1 and must remain reproducible.

This module exists to make that invariant explicit and machine-checkable:
  - `KNOWN_VERSIONS` is the public allow-list.
  - `is_version_locked()` is what `save_projection` consults when it sees
    a projection whose version differs from the current calculator.

The actual calculator code lives in `app/pricing/projection.py` (v1).
When v2 lands it will live in a sibling module (e.g. `projection_v2.py`)
and be selected via a routing function.
"""
from __future__ import annotations
from typing import Dict, Any

# Every version that has EVER reached `confirmed` status in production
# must appear here. Add new versions, never remove.
KNOWN_VERSIONS: Dict[str, Dict[str, Any]] = {
    "v1": {
        "introduced": "2026-05-16",
        "description": (
            "Initial tier model. 0–100 km included, soft/standard/far remote "
            "tiers with min-fee floors. 85/15 payout split. Deterministic, "
            "no surge, no AI."
        ),
        # Locked: confirmed projections referencing this version MUST stay
        # immutable. The calculator may not be edited — only new versions
        # may be introduced.
        "locked": True,
    },
    "v2": {
        "introduced": "2026-05-17",
        "description": (
            "Density-aware modifier on top of v1 distance surcharge. "
            "Provider supply density per city → multiplier "
            "(high 1.00 / medium 1.05 / low 1.15 / scarce 1.30). "
            "Scarce forces manualReview. Frozen densitySnapshot embedded "
            "into every projection. NO surge, NO time-of-day, NO AI."
        ),
        "locked": True,
    },
}


# Which version the pipeline emits for NEW requests. Old confirmed
# projections keep their original version forever — see `is_version_locked`.
_CURRENT_VERSION = "v2"


def is_version_known(version: str) -> bool:
    return version in KNOWN_VERSIONS


def is_version_locked(version: str) -> bool:
    """Returns True for versions that have ever shipped. Mutating their
    output is a deploy-time bug."""
    return KNOWN_VERSIONS.get(version, {}).get("locked", False)


def current_version() -> str:
    """The version emitted by today's pricing pipeline."""
    return _CURRENT_VERSION
