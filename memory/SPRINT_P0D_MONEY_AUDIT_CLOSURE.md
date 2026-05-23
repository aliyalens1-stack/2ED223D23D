# Sprint P0.d — Admin Money & Moderation Surface

**Closed:** 2026-02-20 · 12/12 e2e tests passed.

## Scope (delivered exactly as briefed)

### Payouts FSM (`payouts` collection, status field)

Final state machine — `failed` added per brief:

```
            pending → approved → processing → paid
               ↓         ↓           ↓
              hold ← hold ←──── hold
            processing → failed
            hold → approved
```

Rules enforced in `app/admin/p0d/payout_fsm.py`:
- `paid`, `failed` are **terminal** — every admin action returns 409 + writes
  `*:rejected` row to `money_audit`.
- `hold` only from non-terminal (`pending|approved|processing`).
- `process` only from `approved`.
- `approve` only from `pending|hold`.

### Endpoints (admin-only, `verify_admin_token`)

| Method | Path | Effect |
|---|---|---|
| GET   | `/api/admin/payouts`                    | list with filter (status/inspectorId/providerId) |
| GET   | `/api/admin/payouts/{id}`               | detail + audit history |
| POST  | `/api/admin/payouts/{id}/approve`       | `pending|hold` → `approved` |
| POST  | `/api/admin/payouts/{id}/hold`          | non-terminal → `hold` |
| POST  | `/api/admin/payouts/{id}/process`       | `approved` → `processing` |
| GET   | `/api/admin/payments/admin-list`        | list `service_payments` |
| GET   | `/api/admin/payments/{id}/detail`       | detail + audit history |
| POST  | `/api/admin/payments/{id}/refund`       | `paid|released` → `refunded` (terminal, single-shot) |
| POST  | `/api/admin/payments/{id}/retry`        | `failed` → `pending` (clears stale checkout) |
| GET   | `/api/admin/reviews-mod`                | list reviews (filter: all/flagged/excluded/visible) |
| GET   | `/api/admin/reviews-mod/{id}`           | detail + audit |
| POST  | `/api/admin/reviews-mod/{id}/flag`      | `visible` → `flagged` |
| POST  | `/api/admin/reviews-mod/{id}/restore`   | `flagged` → `visible` |
| POST  | `/api/admin/reviews-mod/{id}/exclude-rating` | toggle `excludeFromRating` + recompute |

### Audit (`money_audit` collection — append-only)

Document shape: `{ id, entity, entityId, action, actorId, actorRole, fromStatus, toStatus, meta, timestamp }`.
Indexes (ensured at startup): `(entity, entityId, timestamp DESC)`, `(actorId, timestamp DESC)`, `(action, timestamp DESC)`.

Discipline:
- Every mutating endpoint writes exactly one row, **after** the entity mutation
  (so failed mutations don't appear as succeeded actions in history).
- Rejected attempts (FSM violations) also write a row with `action="<verb>:rejected"`
  — silent rewrite attempts are visible.
- TOCTOU guard on every mutation: `update_one({"id": pid, "status": current}, ...)` —
  a concurrent state change returns 409 to the second caller.

## Critical acceptance test ✅

> released / paid / refunded history cannot be silently rewritten

Implemented as `test_critical_invariant_refunded_history_cannot_be_silently_rewritten`
in `backend/tests/test_p0d_money_audit_e2e.py`:

1. Seed paid payment → first refund succeeds, stores `refundedAt` + `refundReason="1st"`.
2. Second refund attempt with `reason="covert rewrite"` → returns **409**.
3. On-disk doc compared byte-for-byte to snapshot after first refund — `refundedAt` and `refundReason` unchanged.
4. Exactly one `refund:rejected` row in `money_audit` with the attacker's reason captured.

Also covered:
- `paid` payout terminal: 3×409 for approve/hold/process + 3 rejected-audit rows.
- `failed` payout terminal: identical contract.
- `process` rejected from `pending` and `hold`.
- Payment `retry` rejected from `paid`.

## Files

```
backend/app/admin/p0d/
├── __init__.py         # re-exports router + ensure_indexes + audit writer
├── payout_fsm.py       # state machine (one file, every transition explicit)
├── audit.py            # money_audit collection writer + ensure_indexes
├── payouts.py          # 5 endpoints (3 mutating)
├── payments.py         # 4 endpoints (2 mutating)
├── reviews.py          # 5 endpoints (3 mutating)
└── router.py           # aggregate APIRouter

backend/tests/
└── test_p0d_money_audit_e2e.py  # 12 tests, all pass against live backend

backend/server.py
└── include_router(p0d_router) + on_event('startup') -> ensure_indexes
```

## Not in scope (deferred to follow-ups)

- `retry_failed_payout` — separate sprint as agreed (`failed` stays terminal here).
- Wiring real Stripe refund into `/payments/{id}/refund` (today only mutates platform
  state; the existing `app/integrations/router_connect.py` admin refund path is
  the integration seam if/when wired).
- Admin UI surfaces (web-app / admin SPA) — backend only this sprint.
