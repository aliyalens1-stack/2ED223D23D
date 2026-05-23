"""customer_cognition.mapper — deterministic restrained interpreter.

Substrate inputs (READ-ONLY, structural signals only):
    draft_doc:
        contradictions:      list (LENGTH read; items NEVER read)
        missingEvidence:     list (LENGTH read; items NEVER read)
        topProblems:         list of {severity} (severities counted ONLY)
        recommendedActions:  list (LENGTH read; items NEVER read)
        input.severityDistribution: {critical, problem, warning, ok, info, not_checked}
        input.mediaCount:    int
    job_doc:
        status: str (gating signal — delivered / completed / report_delivered)
    reputation_doc:
        hardFloor: bool

Outputs (FROZEN copy, ASCII-only):
    Four section bodies — exactly one sentence each.
    All wording is built from a closed set of constants below.
    NO operational text is ever proxied. NO LLM is invoked.

Forbidden lexicon (verified by /tmp/test_cognition.py):
    ai, confidence, probability, score, rating, accuracy, expert,
    guaranteed, percent, %, system, algorithm, draft, flagged, queue,
    "risk score", "safe investment", "recommended purchase",
    "vehicle passed", "safe to buy", "expert-approved",
    "green light", "red flag", "yellow flag",
    digits adjacent to "%" or "out of 10/100".
"""
from __future__ import annotations
from typing import Any


# Job-status gate: cognition exists only after delivery.
DELIVERED_STATUSES: set[str] = {"delivered", "completed", "report_delivered"}

# Severity categorisation reused from intelligence/draft.py (problem/critical
# are the "structural" buckets; warning is the softer one). Read-only.
_HEAVY_SEVERITIES: set[str] = {"critical", "problem"}
_SOFT_SEVERITIES: set[str] = {"warning"}


# ─────────────────────────────────────────────────────────────────────
# Pure helpers — counts only. Nothing here reads `note` / `summary` /
# `reasoning` / item strings. If you find yourself wanting to read those,
# stop — the boundary is intentional.
# ─────────────────────────────────────────────────────────────────────

def _heavy_count(dist: dict[str, Any]) -> int:
    return sum(int(dist.get(k) or 0) for k in _HEAVY_SEVERITIES)


def _soft_count(dist: dict[str, Any]) -> int:
    return sum(int(dist.get(k) or 0) for k in _SOFT_SEVERITIES)


def _top_problem_heavy_count(top_problems: list[Any]) -> int:
    if not isinstance(top_problems, list):
        return 0
    n = 0
    for item in top_problems:
        if not isinstance(item, dict):
            continue
        sev = (item.get("severity") or "").lower()
        if sev in _HEAVY_SEVERITIES:
            n += 1
    return n


def _safe_len(value: Any) -> int:
    if isinstance(value, list):
        return len(value)
    return 0


# ─────────────────────────────────────────────────────────────────────
# Section 1 — WHAT STRUCTURALLY MATTERS
# ─────────────────────────────────────────────────────────────────────
_STRUCT_HEAVY = (
    "These inspection findings require the most restraint before purchase. "
    "Several structural concerns surfaced during inspection."
)
_STRUCT_SOFT = "Some inspection findings warrant restraint before purchase."
_STRUCT_NONE = "No structural concerns surfaced during inspection."


def section_structurally_matters(draft: dict[str, Any]) -> str:
    dist = (draft.get("input") or {}).get("severityDistribution") or {}
    heavy = _heavy_count(dist) + _top_problem_heavy_count(draft.get("topProblems") or [])
    soft = _soft_count(dist)
    if heavy >= 1:
        return _STRUCT_HEAVY
    if soft >= 2 or _safe_len(draft.get("topProblems")) >= 1:
        return _STRUCT_SOFT
    return _STRUCT_NONE


# ─────────────────────────────────────────────────────────────────────
# Section 2 — WHAT REMAINS UNCERTAIN
# Uncertainty is not failure. The mapper is allowed — and required — to
# say so plainly when substrate is incomplete or contradictory.
# ─────────────────────────────────────────────────────────────────────
_UNC_BOTH = (
    "Inspection continuity remains incomplete in several areas, "
    "and some findings remain unresolved against the inspection record."
)
_UNC_CONTRADICTIONS = (
    "Some inspection findings remain unresolved against the inspection record."
)
_UNC_MISSING = "Inspection continuity remains incomplete in several areas."
_UNC_NONE = "Inspection continuity is complete and internally consistent."


def section_remains_uncertain(draft: dict[str, Any]) -> str:
    has_contra = _safe_len(draft.get("contradictions")) > 0
    has_missing = _safe_len(draft.get("missingEvidence")) > 0
    if has_contra and has_missing:
        return _UNC_BOTH
    if has_contra:
        return _UNC_CONTRADICTIONS
    if has_missing:
        return _UNC_MISSING
    return _UNC_NONE


# ─────────────────────────────────────────────────────────────────────
# Section 3 — WHAT SUPPORTS THE INTERPRETATION
# Evidence maturity speaks structurally (media footprint + checked items).
# No counts surfaced; only continuity adjectives.
# ─────────────────────────────────────────────────────────────────────
_SUPP_STRONG = (
    "Interpretation continuity is supported by evidence gathered "
    "across multiple inspection areas."
)
_SUPP_PRESENT = (
    "Interpretation continuity is supported by recorded evidence "
    "across the inspection."
)
_SUPP_SPARSE = "Interpretation rests on a limited evidence footprint."


def section_supports_interpretation(draft: dict[str, Any]) -> str:
    inp = draft.get("input") or {}
    media = int(inp.get("mediaCount") or 0)
    dist = inp.get("severityDistribution") or {}
    ok_count = int(dist.get("ok") or 0)
    inspected = ok_count + _heavy_count(dist) + _soft_count(dist) + int(dist.get("info") or 0)

    if media >= 8 and ok_count >= 5 and inspected >= 8:
        return _SUPP_STRONG
    if media >= 3 or inspected >= 4:
        return _SUPP_PRESENT
    return _SUPP_SPARSE


# ─────────────────────────────────────────────────────────────────────
# Section 4 — WHAT MAY REQUIRE FURTHER REVIEW
# Hard-floor overrides recommendation count. No urgency theatre, no CTA.
# ─────────────────────────────────────────────────────────────────────
_REVIEW_HARDFLOOR = "Additional review is currently active for this inspection."
_REVIEW_RECOMMENDED = (
    "Further review is recommended on points raised during inspection."
)
_REVIEW_NONE = "No further review is currently indicated."


def section_may_require_review(draft: dict[str, Any], hard_floor: bool) -> str:
    if hard_floor:
        return _REVIEW_HARDFLOOR
    actions = _safe_len(draft.get("recommendedActions"))
    contradictions = _safe_len(draft.get("contradictions"))
    if actions >= 1 or contradictions >= 1:
        return _REVIEW_RECOMMENDED
    return _REVIEW_NONE


# ─────────────────────────────────────────────────────────────────────
# Top-level compose
# ─────────────────────────────────────────────────────────────────────

# Forming line — used when report is not delivered yet, or no draft persisted.
FORMING_LINE = "Interpretation continuity is still forming."


def is_delivered(job: dict[str, Any]) -> bool:
    status = (job.get("status") or "").lower()
    return status in DELIVERED_STATUSES


def build_cognition(
    *,
    draft: dict[str, Any] | None,
    job: dict[str, Any],
    hard_floor: bool,
) -> dict[str, Any]:
    """Deterministic top-level composer.

    Returns one of two shapes:
      {ok: False, reason: 'forming', interpretation: FORMING_LINE}
      {ok: True, sections: {
          structurally_matters, remains_uncertain,
          supports_interpretation, may_require_review,
      }}

    NEVER returns raw operational artifacts.
    """
    if not is_delivered(job):
        return {"ok": False, "reason": "forming", "interpretation": FORMING_LINE}
    if not draft:
        # Edge case: report delivered but draft missing/lost. We are honest:
        # interpretation is still forming, no theatre.
        return {"ok": False, "reason": "forming", "interpretation": FORMING_LINE}

    return {
        "ok": True,
        "sections": {
            "structurally_matters":     section_structurally_matters(draft),
            "remains_uncertain":        section_remains_uncertain(draft),
            "supports_interpretation":  section_supports_interpretation(draft),
            "may_require_review":       section_may_require_review(draft, hard_floor),
        },
        # Structural signal only — the timestamp at which interpretation
        # substrate (the latest draft) was produced. NOT a wording field;
        # the surface formats it as an absolute "Last interpreted" line.
        # Defensive: if absent (legacy drafts), we surface None — surface
        # treats None as "render nothing", never as a fabricated placeholder.
        "lastInterpretedAt": draft.get("generatedAt"),
    }


__all__ = [
    "DELIVERED_STATUSES",
    "FORMING_LINE",
    "is_delivered",
    "section_structurally_matters",
    "section_remains_uncertain",
    "section_supports_interpretation",
    "section_may_require_review",
    "build_cognition",
]
