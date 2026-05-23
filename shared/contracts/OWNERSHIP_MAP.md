# Operational Ownership Map (P3.2)

> Source: P3 — Governance Consolidation (2026-02-22)
> Status: doctrinal — pairs with `DOCTRINE.md` (P2.1 canonical path doctrine)

---

## 1. Purpose

After P2, every backend route is in the catalogue. After P3, every catalogue domain has a named **operational owner** — the surface area whose role is responsible for the correctness, observability, and on-call response of that domain.

This is NOT a permission matrix. It is an **operational ownership** table. Permission gates live in `verify_admin_token` / capability dependencies; ownership lives here.

Why this matters: when a divergence shows up in `reconciliation/report` or an alert fires in `ops/alerts`, the *who-decides-what-to-do-next* must be unambiguous. Implicit ownership is how mature systems develop "governance theatre" — alarms with no owner, dashboards no-one reads, runbooks pointing at nobody.

---

## 2. Ownership table

| Domain | Catalogue location | Owner surface | On-call signal | Forensic deeplink root |
| --- | --- | --- | --- | --- |
| `chronology` | `payments/chronology/realtime.py` · `/api/admin/payments/{id}/chronology` | **governance** | new event stream gap > 60s | `forensic-graph/payment/{id}` |
| `escrow` | `escrow/*` · `/api/payments/*` | **payments** | `outstanding_escrow` divergence in reconciliation/report | `forensic-graph/payment/{id}` |
| `payouts` | `payments/router_connect.py` · `/api/billing/webhook/connect` | **payments** | stripe webhook drift / `transfer.failed` | `forensic-graph/payment/{id}` (follow `stripe_transfer_id`) |
| `disputes` | `disputes/*` · `/api/admin/disputes/*` | **trust** | `assigned_to_admin: null` for >24h | `forensic-graph/dispute/{id}` |
| `reviews` | `reputation/*` · `/api/admin/reviews/*` | **trust** | flagged_review_unprocessed > 50 | `forensic-graph/booking/{id}` (follow `review_of`) |
| `verification` | `marketplace/partner_verifications.py` | **marketplace** | verification queue > 100 awaiting | n/a |
| `realtime` | `socket.io` namespace `/realtime` | **operations** | socket disconnect ratio > 5% | n/a |
| `bookings` | `booking/*` · `/api/bookings/*` | **marketplace** | dispatch_failed bookings > 0 in 1h window | `forensic-graph/booking/{id}` |
| `quotes / requests` | `auto_requests/*` · `/api/requests/*` | **marketplace** | stale quote (>72h, no response) | `forensic-graph/booking/{id}` |
| `inspections` | `inspections/*` · `/api/inspector/*` | **marketplace** | `awaiting_capture` job > 24h | n/a |
| `customer cognition` | `customer_cognition/*` · `/api/customer/*` | **marketplace** | continuity-gap warnings | n/a |
| `provider intelligence` | `provider/intelligence.py` · `/api/provider/intelligence` | **marketplace** | opportunities staleness | n/a |
| `reconciliation` | `payments/reconciliation.py` · `/api/admin/reconciliation/*` (P3.3) | **governance** | divergence count > 0 in nightly run | the report itself |
| `forensic graph` | `admin/forensic_graph.py` · `/api/admin/forensic-graph/*` (P3.4) | **governance** | composition errors / 5xx in graph endpoint | self |
| `governance score` | `governance/router.py` · `/api/admin/governance/*` | **governance** | score drop > threshold day-over-day | actions log |
| `audit log` | `ops_map/router.py` · `cluster_writer.py` | **governance** | write failures in cluster_writer | n/a |
| `feature flags` | `core/config.py` + `admin/features` | **governance** | flag flip without governance attribution | audit log |
| `zones` | `geo/*`, `admin/zones/*` | **operations** | dead zones > 5% of fleet | n/a |
| `demand engine` | `orchestrator/*` + ML loops | **operations** | predictor confidence drop > 20% | n/a |
| `automation rules` | `admin/automation*` (FROZEN — see §4) | **— suspended —** | n/a | n/a |
| `notifications` | `notifications/*` | **support** | push receipt 5xx ratio > 5% | n/a |
| `service chat` | `service_chat/*` | **support** | message-loss / ws-disconnect | n/a |
| `system health` | `system/router.py` · `/api/system/*` | **operations** | health endpoint 5xx | n/a |
| `integration credentials` | `admin/integrations` | **operations** | rotation overdue | n/a |
| `referrals` | `referrals.py` | **growth** | referral fraud signal | n/a |
| `pricing` | `pricing/*` (FROZEN — see §4) | **— frozen —** | n/a | n/a |

---

## 3. Owner surfaces — what they actually mean

| Owner | Definition |
| --- | --- |
| **governance** | Owns the meta-layer: what is the system doing, why, can it be reconstructed forensically. Owns chronology, reconciliation, forensic graph, governance score, audit log. |
| **payments** | Owns the money: escrow lifecycle, payouts, stripe integration, refund correctness. NOT trust — disagreements about whether money should move belong to trust. |
| **trust** | Owns the reputation and arbitration layers: disputes, reviews, provider reputation flags, rating exclusions. |
| **marketplace** | Owns the matching loop: bookings, quotes, requests, inspections, verification, customer-cognition surfaces, provider intelligence. The bulk of feature work happens here. |
| **operations** | Owns the engine room: realtime transport, zones, demand engine, integration credentials, system health. |
| **support** | Owns the outbound communication surface: notifications, service chat, customer-facing operational comms. |
| **growth** | Owns referral / acquisition flywheels. |

---

## 4. Frozen / suspended domains

These domains have explicit "do not resurrect" status. They appear in the table above for completeness; their owner is `— suspended —` or `— frozen —`.

| Domain | Status | Justification (per memory/) |
| --- | --- | --- |
| `automation rules` | suspended | Was governance theatre without operational truth. Will not resurrect until: execution ownership · real queues · retry semantics · operator attribution · audit trails · deterministic replay. |
| `pricing v2b` | frozen 2026-05-17 | Offer-packages versioning is sealed. |
| `notify_pref_1` | frozen 2026-05-15 | Notification preference shape sealed. |
| `Phase 5 i18n EN/RU/DE` | frozen | Localization keys sealed. |
| `revenue_semantics_layer` | frozen 2026-05-13 | Revenue counting semantics sealed. |
| `payments_2a_pay_button` | frozen 2026-05-16 | Pay-button UX sealed. |
| `stripe_1_wired` | frozen 2026-05-15 | Stripe integration shape sealed. |
| `reconciliation_audit_supervisor` | closure 2026-05-22 | Nightly supervisor sealed. |

---

## 5. How to use this table

- When an alert fires → look up domain → owner → that surface's on-call decides.
- When adding a new domain → add a row to §2 BEFORE writing the FastAPI router. If you cannot identify an owner, the domain probably belongs to an existing one (likely `marketplace` or `governance`).
- When the catalogue gains a route → `smoke-api-contracts.sh` (P2.4) ensures it's mounted; this map ensures it has a name on the duty-roster.

---

## 6. What this table is NOT

- Not RBAC. Permissions are enforced by `verify_admin_token` + capability dependencies.
- Not a code-ownership file (`CODEOWNERS`). It's about operational accountability, not commit review.
- Not a SLA matrix. SLAs go in a separate runbook when this team starts publishing them.
