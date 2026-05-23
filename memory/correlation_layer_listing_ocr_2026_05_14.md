# Listing ↔ OCR Correlation Layer

**Date:** 2026-05-14
**Sprint name:** Correlation-1 (first cross-data-source forensic layer)
**Discipline (per user brief):** only signals, only admin forensic rail,
no auto-penalties, no customer visibility, no inspector workflow blocking.

---

## Architectural premise

The first cross-source correlation in the inspection stack. Earlier layers
each lived inside one source of truth:

- **Inspector workflow** — what the human says (item status, notes)
- **Evidence layer** — what the photo says (OCR-1)
- **Provenance** — what the device/timestamp say
- **Timeline** — what the order of events says

This layer joins **listing claim** against **evidence + VIN-decoded
structural facts**. It produces *signals* (read-only observations), never
verdicts. The inspector keeps authority over the inspection; the customer
keeps the marketing-style presentation; the admin gets the only surface
that sees the correlation.

```
                  ┌─────────────────────────────────────┐
                  │  Listing claim                      │
                  │   • inspection_jobs.listingClaim    │
                  │   • car_requests.yearFrom/yearTo    │
                  │   • vehicles.{vin,mileage,year}     │
                  └────────────────┬────────────────────┘
                                   │
                                   ▼
        ┌───────────────────────────────────────────────────────┐
        │   compute_correlations(db, jobId)                     │
        │   Listing  vs  OCR  vs  VIN-decode                    │
        └────────────────────────┬──────────────────────────────┘
                                 │
                       Signals (admin-only)
                                 │
       ┌─────────────────────────┼──────────────────────────────┐
       │                         │                              │
       ▼                         ▼                              ▼
 inspection_correlations  correlation.signal_raised       GET /correlations
   (snapshot)              (timeline events)              (admin endpoint, 403 to others)
```

## Signal taxonomy

| Kind | Source A | Source B | Threshold | Severity |
|---|---|---|---|---|
| `correlation.vin_mismatch`       | listing.vin    | OCR.vin       | any char diff | `warn` if <3 chars, `high` otherwise |
| `correlation.mileage_divergence` | listing.km     | OCR.km        | ≥5%           | `high` if ≥15%, else `warn` |
| `correlation.year_mismatch`      | listing.year   | VIN-decode    | ±1 tolerance  | `high` if drift ≥3, else `warn` |

Severity values (`info / warn / high`) are deliberately a **separate
vocabulary** from the inspector's `critical / warning` axis. The two
surfaces never share visual language so a forensic concern can never be
mistaken for an inspection finding.

## Files added / modified

| File | Change |
|---|---|
| `backend/app/inspections/correlation.py`  | NEW — `compute_correlations`, `persist_and_emit`, signal builders, listing-view resolver |
| `backend/app/inspections/v2.py`           | Call `persist_and_emit` inside `ocr/confirm` handler (failure-silent); new `GET /correlations` admin endpoint |
| `admin/src/pages/InspectionForensicsPage.tsx` | Map `correlation.signal_raised` + `ocr.*` event types to icons in the forensics timeline rail |

## Listing-view resolver

Pulls whichever facts are available, in priority order:

1. `inspection_jobs.listingClaim` — explicit per-job claim if seeded by
   marketplace parser (preferred when present)
2. `car_requests.{yearFrom, yearTo}` — buyer's stated year window
3. `vehicles.{vin, mileage, year}` — customer's already-owned vehicle if
   `job.vehicleId` is set

Always returns a dict (never None). `_sources: [...]` records which
sources contributed — surfaced to admin in the response for transparency.

## Endpoint contract

```
GET /api/inspections/{job_id}/correlations[?recompute=true]
  Auth: admin only (inspector + customer get 403)
  Returns:
    {
      jobId, computedAt,
      listing: { vin, mileageKm, yearFrom, yearTo, source, _sources },
      evidence: { vin, mileageKm, vinDecode: { country, manufacturer, modelYear, wmi, ... } },
      signals: [ { kind, severity, sources, values, summary }, ... ],
    }
```

`recompute=true` recomputes against latest state and triggers timeline
emit for any new/escalated signals. Default reads the cached snapshot
(written by the OCR-confirm hook).

## Idempotency

The persist-and-emit path holds the invariant:

> Emit a `correlation.signal_raised` timeline event only when a signal is
> NEW or its severity has CHANGED. Recomputing with identical inputs is a
> no-op for the timeline.

This keeps the admin forensic rail clean — even if OCR is corrected ten
times with the same outcome, the rail shows three signals, not thirty.

## E2E validation

Seeded `inspection_jobs.listingClaim = {vin: "WBA12345678901234",
mileageKm: 75000, year: 2015}` against OCR-confirmed
`extractedVin = "WBA8E9C50JK123456"`, `extractedMileageKm = 92500`:

```
[admin] GET /correlations?recompute=true → 200
  high  correlation.vin_mismatch             Listing VIN ... differs from OCR VIN ... (13 chars)
  high  correlation.mileage_divergence       OCR 92,500 km is higher than listing 75,000 km by 17,500 km (23.3%)
  high  correlation.year_mismatch            VIN-decoded model year 2018 is 3 year(s) outside listing range 2015-2015

[inspector] GET /correlations → 403  ✅ firewall enforced
[customer]  GET /correlations → 403  ✅ firewall enforced

[timeline] correlation.signal_raised events: 3
[idempotency] recompute with same data → events stay at 3 ✅
```

VIN-decode correctly identified the OCR'd VIN as `BMW · DE · 2018` from
WMI=WBA and position-10 year code `J→2018`.

## Firewall guarantees

1. **Inspector cannot read signals.** Endpoint returns 403. The
   inspection workflow runs the correlation pass synchronously inside
   OCR-confirm, but the result never propagates back to the inspector
   client. `try/except` around the call ensures inspector requests never
   fail because correlation failed.
2. **Customer cannot read signals.** Same 403. Listed signals are not
   stripped onto the customer-facing PDF or the sanitized timeline.
3. **No auto-penalties.** Signals never modify `item.status`,
   `inspection_reports_v2.overallScore`, `recommendation`, or any
   inspector-facing field. The correlation collection is a sidecar.
4. **No blocking.** Correlation runs after report writes are committed.
   A 500 in correlation cannot rollback the OCR confirm.

## What this explicitly does NOT do

- Does not write to `inspection_reports_v2.*` (no implicit override of
  inspector judgement).
- Does not change the customer PDF or admin overallScore.
- Does not auto-block the customer's purchase decision.
- Does not surface VIN-decode metadata (manufacturer, country) to the
  inspector's UI — only structural year is used as a signal source.
- Does not auto-quarantine the job, auto-flag the inspector, or
  auto-launch a dispute. Admin sees the signal, admin decides.
- Does not pull listing data from any external service (mobile.de,
  autoscout24). It uses what's already in the database. Live listing
  re-fetch is a separate sprint.

## Deferred (next correlation iterations)

- **Live listing re-fetch** at correlation time — currently we trust the
  snapshot in `inspection_jobs.listingClaim`. A `recompute=true` could
  re-scrape if `listingClaim.sourceUrl` is present.
- **Vehicle-class plausibility**: VIN-decoded manufacturer vs
  listing.brand. (We already have `decode_vin().manufacturer`.)
- **Country-of-origin vs listing.location** plausibility (German listing
  with a Japanese-domestic VIN is worth a look).
- **Time-coherence**: `inspection.startedAt` vs photo
  `provenance.capturedAt` divergence (already partially in suspicion
  signals — could be unified under correlation taxonomy).
- **Admin UI cluster card**: the forensics page currently renders
  `correlation.signal_raised` events as rail rows. A dedicated cluster
  card grouping all signals for a job (one chip per kind, severity tone)
  would compress the rail when there are many.

## Next natural sprint

Either:
1. **Customer-side TimelineRail** — finishes the temporal-self-awareness
   triangle (inspector, admin, customer); backend is already sanitized.
2. **Live listing re-fetch + listing snapshot collection** — turns
   correlation from "compare against trust-me-bro claim" into "compare
   against fresh scrape", which makes the mileage_divergence signal
   meaningful on real cars (currently it depends on someone having seeded
   `listingClaim`).
