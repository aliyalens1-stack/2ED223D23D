"""Sprint 5 — Pure badge derivation from aggregate metrics.

No I/O. Deterministic. Single function.
"""
from __future__ import annotations

from typing import List, Optional

from app.provider_trust.engine import BADGE_RULES


def derive_badges(
    *,
    avg_rating: Optional[float],
    total_reviews: int,
    completed_jobs: int,
    completion_rate: Optional[float],
    avg_response_minutes: Optional[int],
) -> List[str]:
    """Return list of earned badges given current aggregate metrics."""
    out: List[str] = []

    r = BADGE_RULES["top_rated"]
    if avg_rating is not None and avg_rating >= r["min_avg_rating"] and total_reviews >= r["min_reviews"]:
        out.append("top_rated")

    r = BADGE_RULES["fast_response"]
    if (
        avg_response_minutes is not None
        and avg_response_minutes <= r["max_avg_response_minutes"]
        and total_reviews >= r["min_reviews"]
    ):
        out.append("fast_response")

    r = BADGE_RULES["reliable"]
    if (
        completion_rate is not None
        and completion_rate >= r["min_completion_rate"]
        and completed_jobs >= r["min_jobs"]
    ):
        out.append("reliable")

    r = BADGE_RULES["rising_star"]
    if (
        avg_rating is not None
        and avg_rating >= r["min_avg_rating"]
        and r["min_reviews"] <= total_reviews <= r["max_reviews"]
    ):
        out.append("rising_star")

    r = BADGE_RULES["high_volume"]
    if completed_jobs >= r["min_jobs"]:
        out.append("high_volume")

    return out
