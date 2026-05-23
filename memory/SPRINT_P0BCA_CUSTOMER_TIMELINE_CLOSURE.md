# Sprint P0.b.C.a — Customer-Facing Timeline Projection

**Closed:** 2026-02-20 · 9/9 e2e tests passed · trust contract proven.

## Framing

P0.b.A заморозил chronology. P0.b.B подключил production mutations к timeline.
P0.b.C.a доказывает что timeline **потребляем** — без утечки внутренней правды.

> chronology → semantic visibility — first proof of consumability

## Trust contract

### Customer ONLY sees (whitelist)
- Свои действия: `cancel`
- Provider operational milestones: `mark_confirmed`, `mark_on_route`, `mark_arrived`, `mark_in_progress`, `mark_completed`
- Dispute existence: `open_dispute`, `resolve_dispute`

### Customer NEVER sees (proven via test, with `assert "X" not in repr(events)`)
- ❌ `*:rejected` строки целиком
- ❌ `platformCut`, `providerCost`, `commissionAmount`
- ❌ `internalNotes`, `internalNote`, internal admin комментарии
- ❌ `otherPartyId`, `providerSlug`, `prov-1` (любые provider ids)
- ❌ `admin-sara`, `admin-9001-*` (любые admin actor ids)
- ❌ `refundReason`, `refundNote`
- ❌ `moderation`, `moderationReason`, `excludeFromRating`
- ❌ TOCTOU error strings (`status_changed_concurrently`, etc.)
- ❌ `mark_matched` (system-internal — клиент не должен знать про matcher)
- ❌ Activity-feed noise: `provider_viewed_booking`, `customer_opened_page`

## Architecture

**Anti-goal принят жёстко:** никакого `project_timeline(scope=...)` dispatcher'а, никакой `TIMELINE_VISIBILITY_MATRIX`, никакого generic visibility engine.

```
app/booking/projections/
├── __init__.py             # re-exports labels + customer
├── customer.py             # NEW — _CUSTOMER_VISIBLE_ACTIONS + project_timeline_for_customer
└── (provider.py / inspector.py / admin.py — future P0.b.C.b/c/d)

app/booking/projections_labels.py  # ex-projections.py — state-level labels (project_for_actor)
```

`customer.py`:
- `_CUSTOMER_VISIBLE_ACTIONS`: dict literal — каждый action отдельной записью с своим `label`, `description`, `tone` (Russian copy, calm tone)
- `_SAFE_META_KEYS = {"reason", "eta"}`: whitelist полей из meta, всё остальное дропается
- `HIDDEN_FROM_CUSTOMER`: явный список — поддерживается вручную, дублирует ту же правду что и whitelist (sanity check)
- `project_timeline_for_customer(rows, customer_id)`:
  - дропает все `:rejected`
  - дропает всё не из whitelist (включая admin transitions если их action не whitelisted) — но если admin делает whitelisted action (cancel), customer видит факт без admin id
  - `isSelfAction` помечает только cancel'ы выполненные самим customer'ом

## Endpoint

```
GET /api/customer/bookings/{booking_id}/timeline
Auth: Bearer (verify_user_token — любой аутентифицированный user)
Ownership: doc.customerId или doc.userId должен совпадать с user.sub
           (для legacy docs без customerId — пропускаем; будет ужесточено
           когда landed customer auth backfill)
Response: { bookingId, events: [...], count }
Events:   chronologically ascending (oldest first — UI scanning safety)
```

Каждый event:
```json
{
  "key": "on_route",
  "label": "Исполнитель выехал",
  "description": "В пути к вам.",
  "tone": "positive",
  "at": "2026-02-20T16:01:23+00:00",
  "isSelfAction": false,
  "meta": { "eta": 10 }
}
```

`meta` фильтрован whitelist'ом — никаких внутренних полей.

## Acceptance criteria — все 9 met

| # | Тест | Что доказывает |
|---|---|---|
| 1 | `test_endpoint_requires_auth` | 401 без token |
| 2 | `test_endpoint_returns_404_for_missing_booking` | 404 контракт |
| 3 | **`test_customer_sees_only_safe_events`** | **Главный trust-test** — 8 mixed rows → 5 правильных событий, `assert` на 7 видов утечки |
| 4 | `test_customer_sees_own_cancel` | `isSelfAction=True` + правильный label |
| 5 | `test_admin_cancel_does_not_leak_admin_identity` | admin cancel виден как `cancelled`, но без admin id и без internalNotes |
| 6 | `test_403_when_booking_belongs_to_someone_else` | ownership enforcement |
| 7 | `test_events_returned_chronologically` | strictly ascending timestamps |
| 8 | `test_unknown_actions_are_silently_dropped_not_rendered` | activity-feed trap — `provider_viewed_booking` дропается |
| 9 | `test_empty_timeline_returns_empty_events` | пустой response — валидный |

## Files

```
backend/app/booking/projections_labels.py     # renamed from projections.py
backend/app/booking/projections/__init__.py    NEW — package + re-exports
backend/app/booking/projections/customer.py    NEW — project_timeline_for_customer
backend/app/booking/customer_router.py         NEW — GET /api/customer/bookings/{id}/timeline
backend/app/booking/__init__.py                +1 export (customer_router)
backend/server.py                              +1 include_router(booking_customer_router)
backend/tests/test_p0bca_customer_timeline_e2e.py  9/9 pass
```

## Deferred (per brief sequencing)

- **P0.b.C.b** — provider projection (`project_timeline_for_provider`): operational checklist tone, sees own cost + ETA window + payout status, hides platformCut + internalNotes + customer moderation metadata
- **P0.b.C.c** — inspector projection: inspection-centric chronology (osmotr started/completed, report submitted, payout pending), NOT generic booking-centric
- **P0.b.C.d** — realtime propagation onto same timeline

## Cumulative invariants now in force

| Layer | Invariant | Surface |
|---|---|---|
| Financial | `released/paid/refunded` immutable | `money_audit` |
| Operational FSM | Terminal lifecycle states immutable | `booking_timeline` (admin) |
| Operational observability | cancel/accept/work-execute auto-write timeline | existing flows |
| Forensic | every rejected mutation logged | both audit channels |
| Concurrency | TOCTOU on every controlled mutation | both |
| Resilience | timeline write failure ≠ business flow failure | `observe_transition` |
| **Trust visibility** | **Customer NEVER sees internal truth from timeline** | `customer.py` projection |

## Suite total: 43/43

P0.d (12) + P0.b.A (11) + P0.b.B (11) + P0.b.C.a (9).
