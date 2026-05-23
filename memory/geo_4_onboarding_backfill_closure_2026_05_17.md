# Geo-4 — Provider onboarding topology integration + backfill (closure, 17.05.2026)

## Why
Geo-3 stood up the operational coverage projection but its trustworthiness
collapses if `provider_topology` has gaps. Two concrete gaps existed:

  1. New providers entering through `POST /api/provider/onboarding/quick-start`
     never wrote a `provider_topology` row → projection counts them as 0.
  2. Existing providers (seeded marketplace) were never bound to canonical
     topology → starting state was 1/11 = 9.1% completeness.

Geo-4 closes both gaps and adds an explicit **trust marker** so operators
know how much of the projection they can act on.

## Hard invariant (enforced by code path, not just docs)

    provider cannot become marketplace-active without provider_topology

Registration is allowed without topology (so account creation never fails),
but `is_marketplace_active(owner_id)` is False until topology exists. The
self-check `GET /api/provider/topology/me/marketplace-active` returns the
specific missing signal — UI can route providers straight to the topology
screen instead of generating "why no leads?" support tickets.

## What ships in this closure

### 1. Shared canonical writer
`app/geo/topology.py::upsert_topology(user_id, country, city, radius)` —
single funnel for every topology write. PUT endpoint, demo seed,
onboarding hook, backfill — all delegate here. Guarantees:
- radius ∈ `ALLOWED_RADIUS_KM` (50/100/150/250)
- city ∈ CITY_CATALOGUE (rejected `ValueError` otherwise)
- lat/lng resolved server-side
- mirrors onto `users.baseCountry|baseCityId|baseLat|baseLng|travelRadiusKm`

### 2. Onboarding integration
`OnboardingPayload` now accepts `topologyCountry|topologyCityId|topologyRadiusKm`
(Berlin/DE/100km default). `_run_onboarding` calls `upsert_topology` between
org creation and bid bootstrap. If the requested city isn't in the catalogue,
falls back to Berlin default and **logs a warning** — onboarding never fails
because of geo, but the projection always gets a row.

### 3. One-shot backfill
`app/geo/backfill.py::backfill_provider_topology(db, radius_km, dry_run)` +
CLI `scripts/backfill_provider_topology.py`.

Deterministic resolver (`resolve_city_for_org`):

| Rule         | When applied                                        |
|--------------|-----------------------------------------------------|
| `name_match` | `org.city` == catalogue `name` / `code` / addressMarker, country matches |
| `coord_match`| `org.location.coordinates` within 5 km haversine of exactly ONE catalogue city |
| (skipped)    | `ambiguous_name`, `ambiguous_coord`, `unknown_city`, `no_signal`, `missing_owner` |

**Live result on this deploy:**
```
Before: 1/11 (9.1%) — only demo provider seeded
Backfill: 10 orgs resolved via name_match → 0 skipped
After:  11/11 (100%) — DE: 4 providers · UA: 7 providers
```

Idempotent (`already_bound` short-circuits) — safe to re-run on every deploy.

### 4. Trust marker — `/api/geo/coverage/topology-completeness`
```json
{
  "totalProviders": 11,
  "mappedProviders": 11,
  "percent": 100.0,
  "unmappedSamples": []
}
```
Rendered in the Coverage screen as a banner above the country list:
green shield ≥ 80%, amber alert below. When < 100%, shows the first three
unmapped org slugs so operators can fix them by slug instead of hunting.

### 5. Marketplace-active gate
`app/geo/topology.py::is_marketplace_active(owner_id)` — async helper,
True iff provider has BOTH topology AND an active organization. Public
self-check `GET /api/provider/topology/me/marketplace-active` returns:
```json
{ "marketplaceActive": true, "hasTopology": true, "hasActiveOrg": true, "missing": null }
```
Future hot-paths (matching, pricing, broadcast) should call this instead
of trusting `organizations.status` alone.

### 6. Tests (17 new, all green — 35 total in Geo-3+4 suite)
`backend/tests/test_geo_backfill.py`:
- name_match: kyiv (via addressMarkers — name is "Київ"), case-insensitive, code-as-input, country disambiguator, unknown.
- coord_match: exact, far-off rejection, country filter on coord, haversine tolerance.
- signal-absence: no fields, malformed coords.
- haversine sanity: Berlin↔Kyiv ≈ 1196 km, identity = 0.
- Marketplace-active gate truth-table.

## What was deliberately NOT done

- ❌ Map editing / pin dragging — premature, would break canonical boundary.
- ❌ Google geocoding — adds dependency, drift, billing surface.
- ❌ Free-text city in onboarding — `cityId` is canonical.
- ❌ Polygon coverage / ETA routing — Pricing-v2 territory at earliest.
- ❌ Hard block on registration when topology missing — softer gate
  (`marketplaceActive=false`) prevents brittle UX while keeping invariant.

## What unlocks next

| Sequence step | Status |
|---------------|--------|
| Geo-1 canonical countries/cities          | ✅ closed |
| Geo-2 canonical provider topology         | ✅ closed |
| Geo-3 coverage projection                 | ✅ closed |
| **Geo-4 onboarding + backfill completeness** | ✅ **this closure** |
| Pricing-v2 density-aware remote surcharge | ▶ now unblocked |
| Matching-v2 adaptive broadcast radius     | ▶ now unblocked |

Pricing-v2 can now read density buckets from coverage projection and trust
them — the `topologyCompleteness=100%` banner is the operational green
light that "density numbers reflect reality".

## Files touched
- `backend/app/geo/topology.py` — shared `upsert_topology` + `is_marketplace_active` + self-check endpoint
- `backend/app/geo/coverage_projection.py` — `TopologyCompleteness` model + endpoint
- `backend/app/geo/backfill.py` — NEW resolver + backfill driver
- `backend/scripts/backfill_provider_topology.py` — NEW CLI entrypoint
- `backend/app/provider/onboarding.py` — payload fields + `upsert_topology` call
- `backend/tests/test_geo_backfill.py` — NEW (17 tests)
- `frontend/app/admin/coverage.tsx` — completeness banner
