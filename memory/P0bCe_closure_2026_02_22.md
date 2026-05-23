# P0.b.C.e — Deep-links into chronology surfaces — CLOSURE

**Status:** ✅ CLOSED  
**Date:** 2026-02-22  
**Predecessor:** P0.b.C.d (admin forensic surface)  
**Successor:** P0.b.C.f (payment_events chronology)

---

## Outcome

Added an **`asearch://` deep-link layer** that increases discoverability of the 4 existing chronology surfaces without changing chronology semantics.

The resolver is a **stateless metadata lookup**, not a permission engine. Authorisation remains on the target REST/WS endpoint and screen guard — exactly as established in P0.b.C.a..d.

---

## Architectural invariants preserved

1. **Resolver opacity.** Endpoint returns identical JSON for unauth / customer-JWT / admin-JWT callers. Empirically proven in `test_deeplink_resolver_smoke.py` check #6.
2. **No new permission surface.** Caller's JWT is never inspected by `/api/deeplink/resolve`. The actual chronology endpoints (P0.b.C.a..d) still enforce role gates with their existing 4-actor projections.
3. **No shared timeline kit, no DeepLinkProvider context, no event-store, no replay console.** Pure resolver + Linking listener. ~150 LOC backend + ~110 LOC frontend.
4. **Naming preserves ontology.** Admin surface keyed as `booking-forensic.admin`, NOT `booking-timeline.admin`. Mirrors P0.b.C.d's namespace separation.
5. **No universal-links / domain-verification.** App scheme only. Kept as explicit out-of-scope per user directive.

---

## Files changed

### Backend (additive)
- **NEW** `/app/backend/app/system/deeplink.py` (114 LOC)
  - `GET /api/deeplink/resolve?ref=<surface-key>:<resource-id>`
  - `GET /api/deeplink/surfaces` — read-only catalogue
- **EDITED** `/app/backend/server.py` — added 3 lines:
  ```python
  from app.system.deeplink import router as deeplink_router
  ...
  app.include_router(deeplink_router)
  ```

### Frontend (additive)
- **NEW** `/app/frontend/src/deeplink/index.ts` (108 LOC)
  - `parseDeeplinkUrl()` · `resolveDeeplink()` · `navigateDeeplink()`
- **EDITED** `/app/frontend/app/_layout.tsx`:
  - Added `import * as Linking from 'expo-linking'`
  - Added `import { navigateDeeplink } from '../src/deeplink'`
  - Added `useEffect` in `RootLayoutNav` for cold-start URL + hot URL listener
- **EDITED** `/app/frontend/app.json`:
  - `"scheme": "frontend"` → `"scheme": "asearch"` (single-line change)

### Tests (additive)
- **NEW** `/app/backend/test_deeplink_resolver_smoke.py` (167 LOC)
  - 10 checks including opacity invariant

### Doc (additive)
- `/app/memory/P0bCe_plan_2026_02_22.md`
- `/app/memory/P0bCe_smoke_baseline_2026_02_22.md`
- `/app/memory/P0bCe_closure_2026_02_22.md` ← this file

### NOT touched
- 4 chronology screens (no new props, no new guards)
- 4 timeline REST endpoints
- 4 timeline WS streams
- Auth pipeline (JWT, bcrypt, account-switcher)
- City-onboarding gate
- City pass-through list
- `package.json`, `requirements.txt`
- Any chronology projection logic

---

## Test matrix (post-implementation)

| Suite | Status |
|---|---|
| `test_trust_e2e.py` (Sprint 5) | ✅ PASS |
| `test_disputes_e2e.py` (Sprint 6) | ✅ PASS |
| `test_stripe_connect_e2e.py` (Sprint 7) | ✅ PASS |
| `test_sprint8_ops_e2e.py` (Sprint 8) | ✅ PASS |
| `test_customer_timeline_ws_smoke.py` (P0.b.C.a) | ✅ PASS |
| `test_provider_timeline_ws_smoke.py` (P0.b.C.b) | ✅ PASS |
| `test_inspector_timeline_ws_smoke.py` (P0.b.C.c) | ✅ PASS |
| `test_admin_forensic_ws_smoke.py` (P0.b.C.d) | ✅ PASS |
| `test_deeplink_resolver_smoke.py` (P0.b.C.e) | ✅ **NEW — PASS** |

Zero regressions in 8 baseline suites. New suite passes all 10 checks.

Web bundle: **1304 modules** (was 1303; +1 deeplink module). Clean compile, no warnings related to changes.

---

## What this sprint did NOT do (locked)

- ❌ Universal links / apple-app-site-association / assetlinks.json
- ❌ Ref signing (HMAC) / TTL / expiry
- ❌ Mutating deep-links (no `asearch://accept?id=…`)
- ❌ Push-notification payload integration with deep-links
- ❌ QR code generation
- ❌ Deep-link analytics / attribution
- ❌ Web fallback page (`asearch.app/link?ref=…`)
- ❌ Inter-actor deep-links (resolver does not filter by caller)
- ❌ Auth check in resolver
- ❌ Generic `DeepLinkProvider` / `useDeepLink()` hook
- ❌ Shared timeline kit / event-store / replay console

If any of these become needed → separate sprint with its own ontology decision.

---

## Empirical proof points

1. **Opacity invariant** (P0.b.C.e check #6): identical response shape for unauth/customer/admin calls. Caller cannot use resolver to probe role boundaries.
2. **Closed surface whitelist:** unknown surface returns 400, not a generic redirect. No discoverability of internal routes via deep-links.
3. **Param-key independence:** `inspector` surface uses `jobId`, others use `id`. Mirrors the inspector-projection invariant (P0.b.C.c) where the chronology key is jobId, not bookingId/requestId.
4. **Bundle delta = +1 module:** confirms no abstraction creep. No shared kit, no provider.

---

## Operational notes

- Backend resolver is pure (no Mongo). Sub-ms response. Safe under high traffic.
- Frontend listener is mounted once at root layout. Cleanup is correct on unmount.
- Cold-start URL: handled via `Linking.getInitialURL()` on mount.
- Hot URL: handled via `Linking.addEventListener('url', …)` and cleaned up on unmount.
- Failed resolves (network / 4xx) → silent (logged outcome only, no toast). Justified: deep-links are entry vectors, not user-initiated actions. Spammy toasts on cold-start would degrade UX. If observability becomes a need → separate sprint.

---

## Next sprint

**P0.b.C.f — payment_events chronology** (per user directive).

Pre-requisites already met:
- 4-actor projection discipline established (P0.b.C.a..d)
- chronology naming convention frozen (`<domain>-<species>.<actor>`)
- WS handshake/keepalive/role-gate pattern reusable for payment-forensic
- discovery substrate now exists (deep-link resolver)

`payment_events` will introduce a 4th chronology species (alongside `booking_timeline`, `job_timeline`, `booking_forensic`) and a new namespace `payment-forensic`. **It does NOT replace `money_audit`** (forensic money mutation evidence) — they coexist.
