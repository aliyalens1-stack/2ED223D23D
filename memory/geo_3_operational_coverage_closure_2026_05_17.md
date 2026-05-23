# Geo-3 — Operational Coverage Map (closure, 17.05.2026)

## Why
Geo-2 established the canonical architectural boundary:

    frontend may select geography
    backend resolves coordinates
    provider_topology = canonical
    users.* mirror      = denormalised cache

Geo-3 is the **read-only operational observability surface** that consumes
this canonical topology + the partners (organizations) namespace and
projects "where does our marketplace actually exist today?".

This is *not* a marketing map. It is the substrate that pricing-v2,
matching-v2 and partner-rollout dashboards will eventually read from.

## Architectural rules (encoded in the API contract)

| Rule | Encoded in |
|------|------------|
| Frontend never computes counts | `country_coverage` / `city_coverage` return finished rows; no per-record arrays exposed |
| Country activation = `providers>0 OR partners>0` | Single boolean field `active` |
| Density bucket is server-decided | `density: empty\|low\|medium\|high` returned per city |
| Partner counts roll up city → country via CITY_CATALOGUE | `_CITY_TO_COUNTRY` lookup; countries have no own partner index |
| Catalogue is the unique source of supported countries | `all_countries = sorted({c['country'] for c in CITY_CATALOGUE})` |

## What ships in this closure

1. **Backend projection** — `app/geo/coverage_projection.py`
   - `GET /api/geo/coverage/countries` — array of `CountryCoverage`
   - `GET /api/geo/coverage/countries/{code}` — single country
   - `GET /api/geo/coverage/cities?country=&onlyWithPresence=` — array of `CityCoverage`

2. **Demo topology seed** — `app/geo/topology.py::seed_demo_topology`
   - Plants one `provider_topology` row for `provider@test.com` at Berlin/DE/100km.
   - Mirrors onto `users.baseCountry|baseCityId|baseLat|baseLng|travelRadiusKm`.
   - Called from `app/core/lifespan.py` (idempotent, non-fatal on failure).
   - Without it, Coverage would always report `providers: 0` everywhere — projection becomes untrustworthy.

3. **Frontend surface** — `frontend/app/admin/coverage.tsx`
   - Country tiles (active/inactive) with `providers · partners · cities` counts.
   - Tap-to-drill-down to city list, sorted by density (high → empty).
   - Density chip per city (server-side colour mapping client-side).
   - **No** Google Maps, **no** clustering, **no** heatmaps, **no** polygon editing — by design.
   - Renders the projection verbatim; the `totals` `useMemo` is a SUM of per-country rows already computed server-side, never a per-record recomputation.

4. **Navigation entry** — `frontend/app/(tabs)/profile.tsx`
   - For `role==='admin'`, a new SettingsRow `Operational Coverage` → `/admin/coverage`.
   - Subtitle: `Geo-3 · marketplace topology`. testID `settings-coverage`.

5. **Unit tests** — `backend/tests/test_geo_coverage_projection.py` (18 tests, all green):
   - Density bucket boundaries + monotonicity.
   - CITY_CATALOGUE → country mapping completeness + ISO-2 invariant.
   - Activation rule parameterised over `(providers, partners)` truth table.
   - Pydantic field-set lock for both `CountryCoverage` and `CityCoverage` (so a future rename forces a deliberate sweep through every reader).
   - Demo topology constants point at a real catalogue city + an allowed radius.

## Live data snapshot (post-seed, 17.05.2026)

```
GET /api/geo/coverage/countries → 13 countries
DE: { active=true,  providers=1, partners=3, cities=1 }
UA: { active=true,  providers=0, partners=8, cities=1 }
AT/BY/EE/LT/...:    inactive

GET /api/geo/coverage/cities?onlyWithPresence=true → 2 cities
berlin: { providers=1, partners=3, density=medium }
kyiv:   { providers=0, partners=8, density=medium }
```

## What was deliberately NOT done

- No Google Maps SDK / Leaflet integration in the mobile surface — premature.
- No polygon editing / route optimisation / ETA estimation / clustering.
- No live traffic / heatmaps / geospatial DB rewrite.
- No explicit `db.country_activation` collection — derived rule is enough for v1.

## What unlocks next

Once topology density is trusted (operators have looked at the screen for
≥1 sprint and confirmed numbers match operational reality), the next
foundation can read this projection:

- **Pricing-v2** — remote-surcharge tiers per density bucket instead of flat km tables.
- **Matching-v2** — broadcast radius adapts to local supply density.
- **Partner ops dashboards** — gap analysis ("where do we have partners but no inspectors?").
- **Marketing rollout** — country activation flips become a campaign trigger.
