"""customer_continuity.mapper — deterministic translation layer.

Operational substrate → customer-facing continuity events.

Hard rules enforced HERE (not the screen):
  • Allowlist over event.kind. Anything else is dropped.
  • Copy is produced by THIS module, never proxied from operational `text/title`.
  • Forbidden lexicon (AI / score / confidence / system / algorithm / draft /
    flagged / queue) is structurally impossible — we never read operational
    `text` into the customer surface.
  • No counts surfaced ("3 photos uploaded" forbidden → "Evidence accumulating").
  • Phone semantics scrubbed from contact_revealed → continuity-only.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Any

# Customer-visible event.kind allowlist (V1, from chat contract).
# Internal kinds NOT in this set are silently dropped.
CUSTOMER_VISIBLE_KINDS: set[str] = {
    "assignment_offered",
    "assignment_accepted",
    "assignment_claimed",   # legacy alias of accepted — same customer copy
    "inspector_assigned",
    "contact_revealed",
    "media_uploaded",
    "photo_uploaded",       # legacy alias
    "draft_generated",
    "draft_flagged",
    "report_submitted",
    "report_approved",
    "customer_accept_report",
    "customer_accepted",    # legacy alias
}

# kind → (title, text). Copy lives ONLY here. Operational `text` is never
# proxied — this guarantees forbidden lexicon stays out structurally.
_COPY: dict[str, tuple[str, str]] = {
    "assignment_offered": (
        "Inspection coordination started",
        "An inspector has been offered the inspection.",
    ),
    "assignment_accepted": (
        "Inspector confirmed",
        "An inspector has accepted the inspection.",
    ),
    "assignment_claimed": (
        "Inspector confirmed",
        "An inspector has accepted the inspection.",
    ),
    "inspector_assigned": (
        "Inspector confirmed",
        "An inspector has accepted the inspection.",
    ),
    "contact_revealed": (
        "Coordination opened",
        "Direct coordination between inspector and customer is now possible.",
    ),
    "media_uploaded": (
        "Evidence accumulating",
        "New inspection evidence has been recorded.",
    ),
    "photo_uploaded": (
        "Evidence accumulating",
        "New inspection evidence has been recorded.",
    ),
    "draft_generated": (
        "Interpretation forming",
        "The inspection is moving toward an interpretation.",
    ),
    "draft_flagged": (
        "Additional review currently active",
        "Additional review is currently active before delivery.",
    ),
    "report_submitted": (
        "Inspection report prepared",
        "The inspector has prepared the inspection report.",
    ),
    "report_approved": (
        "Inspection report delivered",
        "The inspection report is now delivered.",
    ),
    "customer_accept_report": (
        "Report acknowledged",
        "The inspection report has been acknowledged.",
    ),
    "customer_accepted": (
        "Report acknowledged",
        "The inspection report has been acknowledged.",
    ),
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def map_event(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Map one operational event → one customer continuity event.

    Returns None if the kind is not in the customer allowlist OR if copy
    cannot be safely produced for it.

    The output schema is intentionally narrow: only kind=`inspection_continuity`,
    a deterministic title/text, and a timestamp. NO operational metadata leaks.
    """
    kind = raw.get("kind")
    if not kind or kind not in CUSTOMER_VISIBLE_KINDS:
        return None
    copy = _COPY.get(kind)
    if not copy:
        return None
    title, text = copy
    return {
        "kind": "inspection_continuity",
        "title": title,
        "text": text,
        "timestamp": raw.get("timestamp") or _now_iso(),
    }


def derive_maturity(kinds_present: set[str], report_delivered: bool) -> str:
    """V1 heuristic — strictly deterministic, no counts.

    Buckets:
      delivered     — final report visible to customer
      established   — inspector finished, report submitted/approved internally
      accumulating  — evidence being recorded AND interpretation forming
      forming       — inspection only just coordinated
      insufficient  — no allowlisted events at all (caller emits honest empty)
    """
    if report_delivered:
        return "delivered"

    # If customer explicitly accepted, treat as delivered.
    if kinds_present & {"customer_accept_report", "customer_accepted"}:
        return "delivered"

    if kinds_present & {"report_approved", "report_submitted"}:
        return "established"

    if (
        kinds_present & {"media_uploaded", "photo_uploaded"}
        and kinds_present & {"draft_generated", "draft_flagged"}
    ):
        return "accumulating"

    if kinds_present & {
        "assignment_offered",
        "assignment_accepted",
        "assignment_claimed",
        "inspector_assigned",
        "contact_revealed",
        "media_uploaded",
        "photo_uploaded",
    }:
        return "forming"

    return "insufficient"


# Deterministic interpretation line per maturity. No metrics, no scores.
_MATURITY_INTERPRETATION: dict[str, str] = {
    "forming":
        "Inspection coordination is underway. Evidence has not yet accumulated.",
    "accumulating":
        "Evidence is accumulating and interpretation is forming. "
        "Final report is not yet delivered.",
    "established":
        "Inspection has concluded and is in final preparation before delivery.",
    "delivered":
        "Inspection report is delivered.",
}


def interpretation_for(maturity: str) -> str:
    return _MATURITY_INTERPRETATION.get(maturity, "Inspection continuity not yet established.")


# ─────────────────────────────────────────────────────────────────────
# Trust phrasing — internal reputation tier → customer-facing phrase.
#
# Hard rules:
#   • tier NEVER surfaced. raw score NEVER surfaced.
#   • hard-floor (open dispute / fraud freeze) overrides everything.
#   • forbidden lexicon (score/system/algorithm/AI) absent by construction.
#   • only one phrase returned, or None if substrate is too sparse to
#     speak honestly (caller omits the field — no theatre).
# ─────────────────────────────────────────────────────────────────────
_TRUST_BY_TIER: dict[str, str] = {
    "bronze":   "Inspection continuity still forming.",
    "silver":   "Inspection continuity still forming.",
    "gold":     "Inspection continuity established.",
    "platinum": "Extensive inspection continuity established.",
}

_TRUST_HARD_FLOOR = "Additional review currently active."


def trust_phrase_for(tier: str | None, hard_floor: bool) -> str | None:
    """Map internal reputation state → single customer-facing line.

    Returns None when there is no inspector tier yet — callers should
    OMIT the trust field rather than emit silence.

    Hard-floor wins over tier — when a dispute is open or fraud freeze is
    active, the customer sees only the restrained review-active line,
    never the tier phrasing underneath it.
    """
    if hard_floor:
        return _TRUST_HARD_FLOOR
    if not tier:
        return None
    return _TRUST_BY_TIER.get(tier.lower())
