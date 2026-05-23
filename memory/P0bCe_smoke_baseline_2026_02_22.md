# Smoke Baseline — Pre P0.b.C.e
**Date:** 2026-02-22 09:00 UTC  
**Sprint context:** Before `P0.b.C.e — Deep-links into chronology surfaces`

## Result: ✅ ALL GREEN (8/8 suites)

| Suite | Status | Notes |
|---|---|---|
| `test_trust_e2e.py` (Sprint 5) | ✅ PASS | 5★ blind reveal + aggregate recompute |
| `test_disputes_e2e.py` (Sprint 6) | ✅ PASS | release_payout / partial_refund / full_refund scenarios |
| `test_stripe_connect_e2e.py` (Sprint 7) | ✅ PASS | onboarding → PI → release → freeze/unfreeze → refund → webhook idempotency |
| `test_sprint8_ops_e2e.py` (Sprint 8) | ✅ PASS¹ | ops alerts severity escalation, unread-count |
| `test_customer_timeline_ws_smoke.py` (P0.b.C.a) | ✅ PASS | REST + WS hello + keepalive + bad-token reject |
| `test_provider_timeline_ws_smoke.py` (P0.b.C.b) | ✅ PASS | projection + opacity + meta whitelist + foreign-token 404 |
| `test_inspector_timeline_ws_smoke.py` (P0.b.C.c) | ✅ PASS | jobId-only projection + mark_confirmed drop + opacity |
| `test_admin_forensic_ws_smoke.py` (P0.b.C.d) | ✅ PASS | raw rows + :rejected preserved + role-gate (admin only) |

¹ One non-blocking warning: `⚠ lifecycle not found — push wiring may not have triggered`. Expected when no Expo device is registered in test DB. Not a regression.

## Significance
- Confirms 4-actor chronology substrate stable BEFORE deep-link work begins.
- P0.b.C.e MUST keep this matrix green at close. Any divergence = abort + bisect.

## Reproduction
```bash
cd /app/backend
for t in test_trust_e2e test_disputes_e2e test_stripe_connect_e2e test_sprint8_ops_e2e \
         test_customer_timeline_ws_smoke test_provider_timeline_ws_smoke \
         test_inspector_timeline_ws_smoke test_admin_forensic_ws_smoke; do
  echo "=== $t ==="
  /root/.venv/bin/python $t.py 2>&1 | tail -5
done
```
