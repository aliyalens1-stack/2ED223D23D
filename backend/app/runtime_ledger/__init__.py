"""runtime_ledger — Phase D Pass 1.

Append-only continuity trace. NOT analytics, NOT telemetry, NOT BI
substrate. The ledger records meaningful continuity-topology transitions
across the cognition surfaces — events that change the SHAPE of a
customer's / inspector's / verifier's continuity, not operational motion.

Doctrine (chat contract, frozen before any code):

  1. Runtime events are NOT analytics.
     No clickstream, no monitoring feed, no observability exhaust, no BI
     source. If an event exists only because "may be useful later" — it
     does not exist.

  2. Event names describe continuity transitions, not operational motion.
     ✓ inspection_context_established
     ✗ photo_uploaded / button_clicked / api_called

  3. Append-only.
     Documents are NEVER mutated, enriched, replayed, or collapsed.
     Once written, an event document is immutable. Coalescing happens
     at EMIT time via a `dedupKey` unique index — a second emit with
     the same key is silently dropped (no mutation, no upsert).

  4. Low-cardinality by construction.
     14 photo uploads in one inspection session → ONE
     `evidence_continuity_widened` event, not 14. The dedupKey carries
     the continuity segment.

  5. Ledger NEVER owns wording.
     No user prose, no interpretation, no summary, no recommendation.
     Payloads are STRUCTURAL ONLY — keys/codes/numbers/ids. Mappers
     read from substrate (requests, reports, etc.) and produce copy;
     the ledger never substitutes for that path.

Scope of Pass 1 (frozen):
  - collection, emit helper, ~7 canonical event types,
  - append-only writes, indexes, tiny admin inspection endpoint,
  - tests for immutability + low-cardinality.

Explicitly NOT in Pass 1:
  - projections, analytics, dashboards, subscriptions,
  - websocket fanout, replay engines, aggregation jobs.
"""

from .events import (  # noqa: F401
    EventType,
    SubjectType,
    Continuity,
    EvidenceSegment,
    DocumentKind,
    EMITTABLE,
    canonical_types,
)
from .service import emit, get_events, get_events_for_subject  # noqa: F401
from .indexes import ensure_indexes  # noqa: F401
from .router import router  # noqa: F401

COLLECTION = "runtime_continuity_events"
