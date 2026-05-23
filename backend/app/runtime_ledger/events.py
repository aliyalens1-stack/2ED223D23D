"""runtime_ledger/events.py — canonical event types + structural payload schemas.

These 7 event types are the ONLY events the ledger will accept. Adding
a new type is a doctrine decision (it expands the continuity topology
the system formally tracks). The bounded enum is the contract.

Every event has:
  • a frozen `EventType`,
  • a `SubjectType` (what kind of entity the event is about),
  • a `Continuity` value (which continuity branch this event participates in),
  • a STRUCTURAL payload — IDs / codes / counts. No prose, no
    interpretation, no recommendation, no rendered text.

The `payload_validator` for each type rejects any of the forbidden
keys (`message`, `summary`, `text`, `description`, `interpretation`,
`recommendation`, `userMessage`, `body`, `html`, `prose`). Layer 5
guardrail enforced at emit time.
"""
from __future__ import annotations

from enum import Enum
from typing import Any, Callable, Optional


# ── Subject taxonomy ────────────────────────────────────────────────
# The entity the event is "about". Bounded set; new subjects require
# doctrine review.

class SubjectType(str, Enum):
    REQUEST = "request"
    JOB = "job"
    REPORT = "report"
    VERIFICATION = "verification"


# ── Continuity branches ─────────────────────────────────────────────
# Which continuity topology this event belongs to. Used for grouped
# reads ("give me all events in the inspection continuity for request X").

class Continuity(str, Enum):
    INTAKE = "intake"
    ASSIGNMENT = "assignment"
    INSPECTION = "inspection"
    INTERPRETATION = "interpretation"
    VERIFICATION = "verification"


# ── Evidence segments (Pass 1C — closed enum) ──────────────────────
# The ONLY canonical continuity-segment values for
# `EVIDENCE_CONTINUITY_WIDENED`. Arbitrary uploader labels (damage,
# odometer, vin, other) are NOT continuity boundaries — they may
# co-occur within any segment and are intentionally invisible to the
# ledger. Adding a new value here is a doctrine decision; renaming or
# removing is forbidden (the ledger is append-only).

class EvidenceSegment(str, Enum):
    EXTERIOR = "exterior"
    CABIN = "cabin"
    MECHANICAL = "mechanical"
    ROADTEST = "roadtest"
    DOCUMENTATION = "documentation"


# ── Document kinds (Pass 1D-B — closed enum) ────────────────────────
# The ONLY canonical document-kind values for `verification_review_entered`
# payload. Mirrors `app.admin.verification_queue.VERIFICATION_KINDS` —
# divergence will fail at the storage boundary (forcing an explicit
# doctrine decision before reaching the ledger). Append-only.

class DocumentKind(str, Enum):
    PASSPORT = "passport"
    BUSINESS_REGISTRATION = "businessRegistration"
    INSURANCE = "insurance"
    TAX_ID = "taxId"
    TOOLS_PROOF = "toolsProof"
    TUV_CERTIFICATE = "tuvCertificate"


# ── Canonical event types ───────────────────────────────────────────
# 7 types. Names describe TOPOLOGY TRANSITIONS, not operational motion.
#
# Adding a new type is permissible; renaming or removing one is not
# (the ledger is append-only — historical events with the old name
# would still exist).

class EventType(str, Enum):
    # Pass 1 — intake continuity
    INSPECTION_CONTEXT_ESTABLISHED = "inspection_context_established"

    # Pass 1 — assignment continuity
    ASSIGNMENT_CONTINUITY_CLAIMED = "assignment_continuity_claimed"

    # Pass 1 — inspection continuity
    INSPECTION_CONTINUITY_ENTERED_ACCUMULATION = (
        "inspection_continuity_entered_accumulation"
    )
    EVIDENCE_CONTINUITY_WIDENED = "evidence_continuity_widened"
    INSPECTION_CONTINUITY_ESTABLISHED = "inspection_continuity_established"

    # Pass 1 — interpretation continuity
    REPORT_INTERPRETATION_DELIVERED = "report_interpretation_delivered"

    # Pass 1 — verification continuity
    VERIFICATION_REVIEW_ENTERED = "verification_review_entered"


def canonical_types() -> list[str]:
    """Frozen list of currently canonical event-type values."""
    return [e.value for e in EventType]


# ── Wording firewall (Rule 5) ───────────────────────────────────────
# Payload keys that NEVER belong in the ledger — they would let
# rendered customer-facing copy leak into substrate.

_FORBIDDEN_PAYLOAD_KEYS = frozenset(
    {
        "message", "summary", "text", "description", "interpretation",
        "recommendation", "userMessage", "user_message", "body", "html",
        "prose", "title", "subtitle", "label",
    }
)


def _payload_is_structural(payload: dict[str, Any]) -> Optional[str]:
    """Returns the first forbidden key found, or None if clean.

    Also rejects nested string values longer than 200 chars — a soft
    safeguard against accidental prose injection through generic keys.
    """
    for k, v in payload.items():
        if k in _FORBIDDEN_PAYLOAD_KEYS:
            return f"payload contains forbidden wording key {k!r}"
        if isinstance(v, str) and len(v) > 200:
            return (
                f"payload[{k!r}] is too long ({len(v)} chars). The ledger "
                "does not store prose — pass an ID/code instead."
            )
        if isinstance(v, dict):
            err = _payload_is_structural(v)
            if err:
                return err
    return None


# ── Per-type schema validators ──────────────────────────────────────
# Each validator returns None if payload is acceptable, or an error
# message string. Validators are intentionally MINIMAL — they only
# assert that required structural identifiers are present. Open-ended
# extension is forbidden (extra keys would normalise drift over time).

def _v_intake(payload: dict[str, Any]) -> Optional[str]:
    if "requestType" not in payload:
        return "intake payload requires 'requestType'"
    if payload["requestType"] not in ("inspection", "selection"):
        return "requestType must be one of: inspection, selection"
    return None


def _v_assignment(payload: dict[str, Any]) -> Optional[str]:
    if "inspectorId" not in payload:
        return "assignment payload requires 'inspectorId'"
    return None


def _v_accumulation(payload: dict[str, Any]) -> Optional[str]:
    # Structural marker that accumulation has begun — no operational
    # detail. The dedup key carries the session boundary.
    return None


def _v_evidence(payload: dict[str, Any]) -> Optional[str]:
    # Pass 1C tightening: the ledger does NOT count uploads. Continuity
    # widening is a boundary crossing (job entered a new evidence
    # segment), not a per-photo enumeration. Payload MUST be empty —
    # the dedup key (job_id + segment) carries the boundary. An
    # `evidenceCount` key (Pass 1 placeholder) is now explicitly
    # forbidden to prevent the ledger from drifting into media
    # telemetry.
    if "evidenceCount" in payload:
        return (
            "evidence payload must NOT carry counts — the dedup key "
            "(job_id + segment) IS the continuity boundary. Drop "
            "evidenceCount."
        )
    if payload:
        return (
            "evidence payload must be empty — segment is passed as the "
            "top-level `segment` arg to emit(), not as a payload key."
        )
    return None


def _v_inspection_established(payload: dict[str, Any]) -> Optional[str]:
    return None


def _v_interpretation(payload: dict[str, Any]) -> Optional[str]:
    # Pass 1D-A tightening: the ledger does NOT store the mapper's
    # section count. Customer-cognition section structure is frozen and
    # tested separately (4 sections — assertion lives there, not here).
    # Payload MUST be empty — the dedup key (one event per job) IS the
    # boundary. Any non-empty payload is forbidden to prevent the
    # ledger from drifting into cognition-surface metrics.
    if "sectionCount" in payload:
        return (
            "interpretation payload must NOT carry sectionCount — section "
            "structure is frozen at the mapper layer and tested there. "
            "Drop sectionCount; payload should be empty."
        )
    if payload:
        return (
            "interpretation payload must be empty — the dedup key (job_id) "
            "IS the continuity boundary."
        )
    return None


def _v_verification_review(payload: dict[str, Any]) -> Optional[str]:
    # Pass 1D-B: governance topology, not analytics. Payload MUST
    # contain exactly one key — `documentKind` — and nothing else.
    # No rejection reason, no severity, no admin note, no trust score,
    # no reviewer id (the top-level `emittedBy` field already carries
    # actor identity). The ledger marks WHICH document kind crossed
    # into review custody; the operational layer owns the rest.
    if "documentKind" not in payload:
        return (
            "verification payload requires `documentKind` (closed enum: "
            "passport | businessRegistration | insurance | taxId | "
            "toolsProof | tuvCertificate)"
        )
    extra = set(payload.keys()) - {"documentKind"}
    if extra:
        return (
            f"verification payload forbids extra keys {sorted(extra)} — "
            f"only `documentKind` is permitted. The ledger is governance "
            f"topology, not analytics."
        )
    kind = payload["documentKind"]
    allowed = {e.value for e in DocumentKind}
    if kind not in allowed:
        return (
            f"documentKind {kind!r} is not in the closed enum {sorted(allowed)}"
        )
    return None


# ── Emit table ──────────────────────────────────────────────────────
# For each event type:
#   subject     — the subject taxonomy the event is about
#   continuity  — which continuity branch the event sits in
#   validator   — structural-payload check (per-type)
#   coalesces   — whether the dedupKey strategy ensures one event per
#                 (subject, segment) — Rule 4 (low-cardinality)
#
# Adding a row here is a doctrine decision. Removing/renaming a row
# is forbidden (the ledger is append-only and historical events with
# the old wiring would still exist).

EMITTABLE: dict[EventType, dict[str, Any]] = {
    EventType.INSPECTION_CONTEXT_ESTABLISHED: {
        "subject": SubjectType.REQUEST,
        "continuity": Continuity.INTAKE,
        "validator": _v_intake,
        "coalesces": True,
    },
    EventType.ASSIGNMENT_CONTINUITY_CLAIMED: {
        "subject": SubjectType.JOB,
        "continuity": Continuity.ASSIGNMENT,
        "validator": _v_assignment,
        "coalesces": True,
    },
    EventType.INSPECTION_CONTINUITY_ENTERED_ACCUMULATION: {
        "subject": SubjectType.JOB,
        "continuity": Continuity.INSPECTION,
        "validator": _v_accumulation,
        "coalesces": True,
    },
    EventType.EVIDENCE_CONTINUITY_WIDENED: {
        "subject": SubjectType.JOB,
        "continuity": Continuity.INSPECTION,
        "validator": _v_evidence,
        "coalesces": True,
        # Pass 1C — segment is a CLOSED enum, not arbitrary uploader
        # labels. emit() enforces this at the storage boundary; any
        # value outside `EvidenceSegment` raises ValueError. Mapping
        # operational categories (e.g. "damage", "odometer", "vin",
        # "other") to a continuity segment is a deliberate decision
        # made at the wiring point — if it doesn't map cleanly, the
        # ledger does not see the upload at all.
        "segment_enum": EvidenceSegment,
    },
    EventType.INSPECTION_CONTINUITY_ESTABLISHED: {
        "subject": SubjectType.JOB,
        "continuity": Continuity.INSPECTION,
        "validator": _v_inspection_established,
        "coalesces": True,
        # Pass 1C — topology-order invariant. An "established"
        # inspection cannot exist without prior "entered_accumulation"
        # for the same subject. emit() enforces this with an async
        # pre-check; missing predecessor → ValueError. This is the
        # storage-layer guard against future wiring drift (e.g. an
        # admin endpoint that flips a job to `done` directly).
        "requires_predecessor": "INSPECTION_CONTINUITY_ENTERED_ACCUMULATION",
    },
    EventType.REPORT_INTERPRETATION_DELIVERED: {
        # Pass 1D-A: subject is JOB (not REPORT) because the continuity
        # boundary is per-job — the customer-facing interpretation
        # crystallises once per inspection job, regardless of any
        # internal report-versioning operational layer may carry.
        # Dedup key resolves to `report_interpretation_delivered:{job_id}:{job_id}`
        # → one event per job, ever.
        "subject": SubjectType.JOB,
        "continuity": Continuity.INTERPRETATION,
        "validator": _v_interpretation,
        "coalesces": True,
        # Pass 1D-A: predecessor invariant. A customer-facing
        # interpretation cannot exist for a job that has not reached
        # its established inspection state. emit() refuses this event
        # unless `INSPECTION_CONTINUITY_ESTABLISHED` already exists
        # for the same subject. This is the storage-layer guard
        # against cognition-surface drift (e.g. a future endpoint that
        # tries to render interpretation copy from a draft).
        "requires_predecessor": "INSPECTION_CONTINUITY_ESTABLISHED",
    },
    EventType.VERIFICATION_REVIEW_ENTERED: {
        "subject": SubjectType.VERIFICATION,
        "continuity": Continuity.VERIFICATION,
        "validator": _v_verification_review,
        "coalesces": True,
    },
}


def validate_payload(event_type: EventType, payload: dict[str, Any]) -> Optional[str]:
    """Wording firewall + per-type structural check. Returns the first
    error message found, or None if the payload is acceptable."""
    if not isinstance(payload, dict):
        return "payload must be a dict"
    err = _payload_is_structural(payload)
    if err:
        return err
    cfg = EMITTABLE.get(event_type)
    if cfg is None:
        return f"unknown event type: {event_type!r}"
    validator: Callable[[dict[str, Any]], Optional[str]] = cfg["validator"]
    return validator(payload)
