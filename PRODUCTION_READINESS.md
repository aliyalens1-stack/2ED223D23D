# PRODUCTION_READINESS.md

> Auto Service Platform — operational runbook for going live.
> Updated: 2026-05-19 (Sprint 9 — Stabilization & Hardening)

Платформа сейчас — **operating transactional system** с замкнутым economic loop:
```
marketplace → bids → escrow → work → chat → trust → arbitration → real Stripe payouts
                                         ↓
                          admin ops alerts · push-delivered UX
```

Этот документ — минимум, что должно быть готово ДО первого live customer.

---

## 1. Required Environment Variables

### Backend (`/app/backend/.env` — protected, не модифицируется через rewrites)
| Variable | Required | Purpose |
| --- | :---: | --- |
| `MONGO_URL` | ✅ | MongoDB connection string |
| `DB_NAME` | ✅ | Database name (по умолчанию `test_database`) |
| `JWT_SECRET` | ✅ | **MUST be ≥32 chars random in production**. Default in code — небезопасен |
| `ADMIN_PASSWORD` | ✅ | Initial admin password. **MUST be changed before live** |
| `STRIPE_API_KEY` | ⚠️ | Sentinel `sk_test_emergent` сейчас. Заменить через `/api/admin/integrations` UI (encrypted в `integration_credentials`) |
| `STRIPE_CONNECT_ENABLED` | ✅ live | `1` после активации Connect Express в Stripe Dashboard. Default `0` = sandbox |
| `REDIS_URL` | ⭕ | `redis://127.0.0.1:6379/0` — без него orchestrator работает в NO-OP fallback (не блокер для money flows) |

### Frontend (`/app/frontend/.env` — protected)
| Variable | Note |
| --- | --- |
| `EXPO_PUBLIC_BACKEND_URL` | Resolved автоматически Emergent ingress |
| `EXPO_PACKAGER_PROXY_URL` | **DO NOT MODIFY** |
| `EXPO_PACKAGER_HOSTNAME` | **DO NOT MODIFY** |

---

## 2. Stripe Live Activation Checklist

1. **Sign up at https://dashboard.stripe.com/connect** — Express type
2. В dashboard: **Settings → Connect → Onboarding options**:
   - Add app name + branding (logo, support email)
   - Enable test mode profiles (Germany / Austria / Poland / UA / Baltic states)
   - Configure capabilities: `card_payments`, `transfers`
3. В **Settings → Webhooks**: add endpoint `https://YOUR_DOMAIN/api/billing/webhook/connect`
   - Subscribe to: `account.updated`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `transfer.created`, `transfer.updated`, `transfer.reversed`, `refund.created`, `refund.updated`, `charge.refunded`
   - Copy webhook signing secret
4. Через admin panel `/api/admin-panel/`:
   - Upload `sk_test_...` (or `sk_live_...`), `pk_test_...`, `whsec_...` в `integration_credentials.stripe`
5. **Toggle flag**: `platform_settings.stripe_connect.enabled = true` (или `STRIPE_CONNECT_ENABLED=1` env)
6. Restart backend → проверьте `/api/admin/payments/platform-status`: должен показать `sandbox: false`
7. **Test transaction**: 1 provider → onboarding → 1 customer → €1 escrow → release → confirm Transfer arrived в provider's Stripe balance

---

## 3. Backup & Restore Policy

### MongoDB
**Critical collections** (data loss = irreversible business loss):
- `service_payments` · `service_requests` · `disputes` · `provider_reviews` · `provider_reputation`
- `users` · `organizations` · `integration_credentials` (encrypted Stripe keys!)
- `stripe_webhook_events` (idempotency log — loss = potential duplicate processing)

**Backup cron** (recommended, NOT yet in code):
```bash
0 */6 * * * mongodump --uri="$MONGO_URL" --out=/backups/$(date +%Y%m%d_%H%M%S) --gzip
```

**Restore drill**:
```bash
mongorestore --uri="$MONGO_URL" --drop /backups/YYYYMMDD_HHMMSS
```

### Redis
Stateless — orchestrator state recoverable from MongoDB. No backup needed.

---

## 4. Incident Playbook

### A. Stripe webhook outage / verification failures
- **Symptom**: `ops/alerts.failedWebhooks24h > 0` или webhook events not landing
- **Action**:
  1. Check Stripe Dashboard → Developers → Webhooks → Events log for HTTP errors
  2. Re-deliver failed events from Stripe Dashboard (one-click)
  3. Idempotency in `stripe_webhook_events` collection protects against duplicate replay

### B. Stuck escrow (payment paid, no release > 24h)
- **Symptom**: `ops/alerts.stuckEscrow.count > 0`
- **Action**:
  1. Open `/api/admin/ops/alerts` → identify payment IDs
  2. For each: investigate via `/api/admin/disputes` (was a dispute opened?)
  3. If no dispute and customer/provider both happy → admin force-release via `/api/payments/stripe/escrow/release/{id}` (admin bypasses 12h gate)

### C. Suspicious activity / fraud alert
- **Action**: `POST /api/admin/payments/freeze` with reason → all payouts halt globally
- **Resume**: `POST /api/admin/payments/unfreeze` once cleared

### D. Bad-actor provider
- **Action**: `POST /api/admin/payments/freeze-provider/{provider_id}` — single provider's payouts halt
- **Unfreeze**: `POST /api/admin/payments/unfreeze-provider/{provider_id}`

### E. Payout rollback (Stripe Transfer needs reversal)
- **Action**: From Stripe Dashboard → find Transfer → Reverse. Webhook `transfer.reversed` will auto-update `service_payments.status = transfer_reversed`

---

## 5. Operational Workers (Cron / Loops)

Current background loops in `/app/backend/server.py`:
| Worker | Interval | Purpose | Cancellation Safety |
| --- | :---: | --- | :---: |
| `Orchestrator cycle` | 10s | Phase E+G demand prediction | ✅ |
| `Feedback processor` | 15s | Phase G action feedback | ✅ |
| `exposures expire_loop` | 60s | Mark expired exposures | ✅ |
| `exposures batching_loop` | 60s | Batch send notifications | ✅ |
| `exposures stats_recompute` | 300s | Recompute inspector stats | ✅ |
| `Strategy optimizer` | 60s | Recalculate orchestrator weights | ✅ |
| `Sprint 20 DemandPredictor` | 60s | Train per-zone demand model | ✅ |
| `cnotify receipts_poll` | 180s | Poll Expo push receipts | ✅ |

**No orphan workers** detected. All loops are registered via `worker_supervisor` with `policy=on_failure max_restarts=5`.

**Memory growth**: orchestrator caches recomputed weights in-process. No leaks observed in 1h+ runs.

---

## 6. Database Index Audit

Compound indexes ensured on startup (`/app/backend/app/core/hot_indexes.py`):
- `service_requests`: status+createdAt · customer+status · provider+status · category+status+recent
- `service_payments`: status+createdAt · customer+recent · provider+recent · requestId · stripePaymentIntentId
- `disputes`: status+openedAt · resolution+resolvedAt
- `provider_reviews`: public_listing compound
- `notifications`: user+recent · user+unread+recent
- `push_device_tokens`: user+token
- `stripe_webhook_events`: type+recent
- `service_chat_messages`: request+recent
- `platform_settings`: type

**Drift detection**: run `mongo test_database --eval 'db.adminCommand({collStats: "service_payments"}).indexSizes'` periodically.

---

## 7. Observability — Structured Logs

All money/trust/arbitration events emit JSON envelope via `app/core/structured_log.py`:
```json
{"ts": "...", "level": "INFO", "event": "escrow.release.succeeded",
 "traceId": "...", "requestId": "...", "paymentId": "...",
 "providerId": "...", "customerId": "...", "meta": {...}}
```

Whitelisted event names в `EVENTS` set:
- Money: escrow.intent.created · escrow.release.{started,succeeded,failed,blocked.*} · refund.{requested,succeeded,failed} · transfer.{created,failed,reversed}
- Trust: review.{submitted,revealed} · reputation.recomputed
- Arbitration: dispute.{opened,resolved} · platform.{frozen,unfrozen} · provider.{frozen,unfrozen}
- Connect: connect.account.{created,updated} · connect.onboarding.started
- Notifications: push.{sent,failed} · webhook.{received,duplicate,invalid_signature}

**Grep cheat-sheet**:
```bash
# All escrow release attempts for a request
grep '"event":"escrow.release.' /var/log/supervisor/backend.err.log | grep '"requestId":"X"'

# All failed transfers in last hour
grep '"event":"transfer.failed"' /var/log/supervisor/backend.err.log | tail -50

# Dispute audit trail
grep -E '"event":"dispute\.(opened|resolved)"' /var/log/supervisor/backend.err.log
```

---

## 8. Pre-Live Smoke Test (run before opening to first customer)

```bash
cd /app/backend
python test_trust_e2e.py            # Sprint 5 — reviews + reputation
python test_disputes_e2e.py         # Sprint 6 — disputes + resolution
python test_stripe_connect_e2e.py   # Sprint 7 — Stripe Connect Express
python test_sprint8_ops_e2e.py      # Sprint 8 — push + ops alerts
```

All 4 suites must pass before flipping `STRIPE_CONNECT_ENABLED=1`.

---

## 9. First-User Pilot Checklist

The biggest risk is no longer architecture — it's **unknown real-world behavior**. Do this BEFORE Sprint 10:

- [ ] 1 internal admin user verified
- [ ] 1 customer pilot account in Berlin
- [ ] 1 provider pilot account (workshop) onboarded via Stripe Connect Express
- [ ] €1 real escrow flow → release → confirm Stripe payout landed
- [ ] Open a test dispute → resolve via partial_refund → confirm Stripe Refund landed
- [ ] Push notification arrived on phone (not just simulator)
- [ ] App foreground refresh works after background

Observe:
- Where UX breaks
- Where users hesitate (drop-off funnel)
- Where notification timing fails
- Where liquidity (provider response time) fails

That data drives **Phase B → C** of the roadmap (liquidity tuning), not new bounded contexts.

---

## 10. What NOT to do next

Per platform spec:
- ❌ AI dispatch / ML pricing — premature
- ❌ Microservices / Kafka / event sourcing — bottleneck is users, not arch
- ❌ GraphQL / CQRS / blockchain — vanity tech
- ❌ "Uber-scale architecture" — you have 0 users yet

What to focus on:
- ✅ First 10 providers · first 100 jobs · first 10 real disputes
- ✅ Response time tuning · bid conversion · rematch heuristics
- ✅ Real production onboarding edge cases (KYC failures, Stripe holds, currency mismatches)

---

## Sprint History Index
| Sprint | Focus | Status |
| --- | --- | :---: |
| 5 | Trust & Retention (reviews + reputation + trust cards) | ✅ |
| 6 | Disputes & Resolution Layer | ✅ |
| 7 | Stripe Connect Express (sandbox-ready) | ✅ |
| 8 | Firebase Realtime & Operational UX | ✅ |
| 9 | Stabilization & Hardening (THIS DOC) | ✅ |

After Sprint 9 → **STOP feature expansion**. Phase A (this doc) complete. Move to **Phase B: Pilot Users**.
