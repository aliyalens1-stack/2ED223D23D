# Public Marketplace Module — Implementation Notes

> **Date:** 2026-02-19
> **Sprint:** Public Marketplace Surface
> **Module:** `app/service_marketplace/router_public.py` (NEW)

## Why a new module?

Before this sprint, the service-request system had three access tiers:
- **Customer** (`router_customer.py`) — create / read own
- **Provider** (`router_provider.py`) — see matched requests in geo radius (auth required)
- **Admin** (`router_admin.py`) — full access

There was **NO public open marketplace** where anyone — guest, customer
browsing other people's tasks, executor scanning for work — could see
the same open job board. The user's screenshot showed a successful POST
(200 OK + request ID), but the next screen couldn't show "your request
in the marketplace" because the marketplace as a public surface didn't
exist.

## What was added

**One new file:** `app/service_marketplace/router_public.py` (357 LOC)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /api/marketplace/feed` | none | Paginated, filtered list of open requests |
| `GET /api/marketplace/feed/stats` | none | Aggregate counters (open count, total bids, cities, byCategory) |
| `GET /api/marketplace/feed/{id}` | none | Public detail (contact-stripped) + bids list (provider contacts stripped) |
| `GET /api/marketplace/categories` | none | The 9 service categories with meta |
| `POST /api/marketplace/feed/{id}/bid` | provider | Submit/update a bid (idempotent per provider) |

Plus 2 small wiring changes:
- `app/service_marketplace/__init__.py` — export `public_router`
- `server.py` — `include_router(service_marketplace_public_router)`

## Feed query parameters

```
GET /api/marketplace/feed
    ?city=berlin                    # exact city code (lowercase)
    &category=repair                # one of 9 keys
    &urgency=urgent                 # normal | urgent | emergency
    &budget_min=50&budget_max=500   # filters on budget.max
    &q=jeep                         # free-text in title + description
    &sort=smart                     # smart | newest | budget
    &page=1&limit=20                # offset pagination
```

Response:
```json
{
  "items": [
    {
      "id": "636da7e5-…",
      "category": "repair",
      "title": "Jeep",
      "description": "починить ходову",
      "city": "berlin",
      "urgency": "urgent",
      "budget": { "min": 50, "max": 100, "currency": "EUR" },
      "photos": [],
      "status": "bidding",
      "bidsCount": 1,
      "createdAt": "2026-05-19T18:03:46+00:00",
      "expiresAt": "2026-05-22T18:03:46+00:00",
      "categoryMeta": { "titleRu": "Ремонт", "emoji": "🔧", … }
    }
  ],
  "total": 3,
  "page": 1,
  "limit": 20,
  "hasMore": false,
  "filters": { … }
}
```

## Ranking (sort=smart)

Composite score with deliberate weights:
- **Urgency** ×0.45 — emergency (1.0) > urgent (0.67) > normal (0.33)
- **Freshness** ×0.40 — linear decay across the 72h TTL
- **Budget ceiling** ×0.15 — capped at €2000 to prevent dominance

Tuning rationale: an `emergency` request a few hours old should out-rank
a `normal` request just posted. Customers choosing `normal` get fair
treatment but don't out-rank emergencies on recency alone.

## Contact-stripping contract

The public router **never** returns:
- `customerId`, `customerName`, `contactPhone` on the request
- `providerPhone`, `providerEmail` on a bid

This is enforced in three places:
1. `FEED_CARD_FIELDS` projection — feed cards drop them at the Mongo
   layer (cheapest).
2. `public_feed_detail` — explicit `.pop()` on the doc + `BID_PUBLIC_FIELDS`
   projection on bids.
3. `public_submit_bid` — response projection drops phone/email from the
   bid object even though they're stored.

Even an owner hitting `/api/marketplace/feed/{id}` gets the redacted
view. Owners must use the existing `/api/service-requests/{id}` for the
owner-aware detail with contact information.

## Status state machine integration

The public feed only shows `open` and `bidding`. As soon as the customer
accepts a bid (existing `/api/service-requests/{id}/accept-bid` →
status `awaiting_payment`), the request **disappears from the public
marketplace**. Only owner / assigned provider / admin keep visibility.

This matches the customer-side intuition: "if I picked someone, my
request shouldn't keep attracting strangers." Also closes a privacy gap
(a paid escrow request leaking provider identity through the public
bids array).

## Bid idempotency

A provider may have **at most one active bid** per request. Re-POSTing
the same `(provider, request)` pair UPDATES the price/message/ETA
rather than creating a duplicate. The `bidsCount` increment runs only
on the first bid; subsequent updates leave it alone.

Tested:
```
POST /feed/{id}/bid  price=80   → action=created, bidsCount=1
POST /feed/{id}/bid  price=75   → action=updated, bidsCount=1
```

## Verified

```bash
GET  /api/marketplace/feed                            → 200, total=3
GET  /api/marketplace/feed?city=berlin&urgency=urgent → 200, total=1
GET  /api/marketplace/feed?sort=smart&limit=5         → 200, ranked
GET  /api/marketplace/feed?q=jeep                     → 200, full-text match
GET  /api/marketplace/feed?page=2&limit=2             → 200, hasMore=false
GET  /api/marketplace/feed?category=wash              → 200, total=0
GET  /api/marketplace/feed?category=carwash           → 400 (validation)
GET  /api/marketplace/feed?budget_min=50&budget_max=200 → 200, total=3
GET  /api/marketplace/feed/stats                      → {openRequests:3, totalBids:0, cities:2, byCategory:{repair:3}}
GET  /api/marketplace/feed/{valid_id}                 → 200, isPublic:true, customerId stripped
GET  /api/marketplace/feed/nonexistent-id             → 404
GET  /api/marketplace/categories                      → 200, 9 categories
POST /feed/{id}/bid  (no auth)                        → 401
POST /feed/{id}/bid  (admin auth)                     → 403 (provider role required)
POST /feed/{id}/bid  (provider auth)                  → 200, status=bidding, bidsCount++
POST /feed/{id}/bid  (provider, second time)          → 200, action=updated, bidsCount unchanged
```

## Frontend integration (next step — not in this commit)

The existing frontend has:
- `app/service-marketplace/index.tsx` → calls `/service-requests/me` (customer's own — keep as is)
- `app/service-marketplace/exchange.tsx` → calls `/provider/service-requests/feed` (provider geo — keep as is)
- `app/service-marketplace/[id].tsx` → request detail screen

What's missing: a **public marketplace screen** for guests/non-provider
authed users. Suggested route: `app/service-marketplace/public.tsx` or
extend `index.tsx` with a "Public marketplace" tab. Calls to add:

```ts
// Browse open marketplace (any user)
api.get('/marketplace/feed', { params: { city, category, urgency, sort, page } })
api.get(`/marketplace/feed/${id}`)
api.get('/marketplace/feed/stats')
api.get('/marketplace/categories')

// Provider bid (provider auth required)
api.post(`/marketplace/feed/${id}/bid`, { price, currency, message, etaMinutes })
```

## Was the user's "не обрабатывается" bug a real bug?

Investigation:
- `POST /api/service-requests` returned 200 + valid request body with `id`.
- The form's success Alert fired ("Заявка опубликована").
- Frontend then routes to `/service-marketplace/${requestId}` (the detail screen).

The actual user-facing problem: after the alert, **there was nowhere
public to see all open marketplace requests**. The customer expected a
marketplace ("биржа") view; instead they had only their own request
detail screen. The fix is structural — add the open marketplace surface —
which is exactly what this module delivers.

## Why this module is "правильно по иерархии"

```
service_marketplace/
├── __init__.py              re-exports all 7 routers
├── models.py                shared Pydantic + projections + categories
├── router_customer.py       owner CRUD (auth: customer)
├── router_provider.py       geo feed + bid (auth: provider)
├── router_admin.py          governance (auth: admin)
├── router_public.py  ★NEW   open marketplace (auth: none for reads)
├── router_geo.py            geo registry + dispatch
└── notifications.py         delivery
```

One router per access-control tier. The public tier was the missing
peer of customer/provider/admin. Now the surface map is complete.
