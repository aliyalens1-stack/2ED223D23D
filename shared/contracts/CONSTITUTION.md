# Platform Constitution

> **Status:** doctrinal — frozen 2026-02-22 at P4/P5 boundary.
> **Authority:** This file overrides any individual sprint doc in `/app/memory/` if they conflict on the points below.
> **Audience:** every engineer, agent, or operator who proposes a change to the platform.

---

## Preamble

The platform exists to make a transactional marketplace economically correct, operationally inspectable, and forensically reconstructable. Every layer must serve those three properties. Pretty UIs without operational truth, ledgers without divergence-detection, and automation without attribution are explicitly out of scope.

This document captures four invariants that became doctrinal during the P1.2 → P5 sequence. They are no longer up for negotiation in any individual PR.

---

## Article I — Surface Truth

> **No visible surface without operational truth.**

If a page, route, or button appears in the admin shell or the customer/provider apps, it must correspond to a backend operation that does what the surface promises. Placeholder pages, "coming soon" panels, and visible-but-disabled controls are forbidden.

Practical consequences:
- A page that depends on a backend route which is not in `/openapi.json` is a doctrine violation.
- A page with mocked or hardcoded data instead of a real API call is a doctrine violation.
- A button whose handler does nothing is a doctrine violation. If the action is not implemented, the button does not exist.

Enforcement: `/app/ops/smoke-api-contracts.sh` (P2.4) for the catalogue side. Manual review for UI placeholders.

---

## Article II — Chronology Necessity

> **No operational truth without chronology.**

Every operational mutation that affects money, trust, or state visible to a counterparty must be recorded in an append-only chronology. The closed taxonomy lives in `/app/backend/app/payments/chronology/writer.py` (19 kinds, frozen 2026-02-22 per `P0bCf_F1_taxonomy_frozen_2026_02_22.md`).

Practical consequences:
- Mutating `service_payments` without writing a corresponding `payment_events` row is a doctrine violation.
- Resolving a dispute without a chronology entry is a doctrine violation.
- "Silent" backfill / migration that changes business-meaningful fields without chronology is a doctrine violation. Schema migrations are exempt; semantic state changes are not.

Enforcement: code review + grep-able pattern (every router that calls `db.service_payments.update_*` must be near an `append_payment_event` call).

---

## Article III — Attribution Necessity

> **No chronology without attribution.**

Every chronology row, every audit-log row, every mutation evidence record must carry actor identity, source route, and timestamp. Anonymous mutations do not exist. The canonical capture point is `app.core.attribution.get_attribution_context` (P5.1).

Practical consequences:
- A chronology row with `actor_id == 'unknown'` is a recoverable bug, not a feature.
- A backend mutation that writes to chronology but cannot identify the actor must reject the request with `400`, not synthesize a placeholder.
- Background workers count as actors (`platform`) but must declare which worker triggered the action (e.g. `actor_id: 'orchestrator', actor_role: 'platform'`).

Enforcement: `record_admin_mutation` does the right thing automatically. Routes that bypass it are flagged in review.

---

## Article IV — Forensic Navigability

> **No attribution without forensic navigation.**

Every chronology / audit entry must be reachable from the admin shell within three clicks from the affected entity. The path:

```
entity list page
  → forensic graph
    → related entity / chronology link / Stripe deeplink
```

is the canonical operator loop, established by P4.

Practical consequences:
- Adding a new mutation domain requires adding it to `OWNERSHIP_MAP.md` AND wiring at least one navigation entry point in the admin SPA.
- Audit-only collections (no UI entry point) are a debt, not a deliverable.

Enforcement: every new operational domain comes with a row in OWNERSHIP_MAP.md and an entry in the forensic graph dispatch.

---

## What is OUT of scope (cumulative)

These items have been explicitly rejected during the substrate-closure phases. Restoring any of them requires retiring the corresponding articles in this constitution, not merely arguing "it's nice to have."

| Item | Article that forbids it | Reason |
| --- | --- | --- |
| Force-directed graph viewer | IV | Looks impressive, adds no operator capability over a labelled list. |
| Universal SDK / generated clients | (architectural prudence) | Duplication is cheaper than the wrong abstraction. |
| Unified balance ledger | II + III | Independent truths + divergence detection is more robust than a "true" ledger fighting reality. |
| Auto-remediation / auto-fix buttons | II | Mutations require attribution; "fix" without operator decision is anonymous mutation. |
| Generic event bus / `emit_event(any_string)` | II + III | Closed kind set is the doctrine; open string sets become arbitrary in 6 months. |
| AI summarization of chronology | (clarity over cleverness) | Operators need raw evidence; summaries hide divergences. |
| Microservices / Kafka / event sourcing | (architectural prudence) | Pre-flight check fails; the system is comprehensible as a monolith and that comprehension is itself a moat. |
| Automation rules resurrection | OWNERSHIP_MAP §4 | Was governance theatre without operational truth; prerequisites unmet. |

---

## How to amend this constitution

A PR that touches `/app/shared/contracts/CONSTITUTION.md`:

1. Must reference the specific article being amended.
2. Must include a memory/ closure doc explaining what real-world failure mode justified the amendment.
3. Must update OWNERSHIP_MAP.md if the amendment changes domain accountability.
4. Cannot be self-reviewed.

Removing an article without amendment is automatically a doctrine violation.

---

## Closing

> Mature systems remove ambiguity before adding infrastructure.

P1.2 removed dead surfaces. P2 removed contract drift. P3 named the owners. P4 surfaced the navigation. P5 closed attribution.

The platform now understands itself. The constitution exists so it cannot forget.
