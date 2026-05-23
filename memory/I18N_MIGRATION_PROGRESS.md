# i18n Migration — Progress & Next Batch

> **Last updated:** 2026-02-19 (Batch 2)
> **Owner:** Emergent E1
> **Scope:** Expo mobile/web app (`/app/frontend/app/*.tsx`) — DE / EN / RU locales

## TL;DR

| Metric                                      | Count   |
| ------------------------------------------- | ------- |
| Total `.tsx` screen files in `app/`         | 130     |
| Files using `useTranslation`                | **59**  |
| Files without `useTranslation`              | **71**  |
| Coverage                                    | **45.4 %** |

## Progress this session (2 batches)

### Batch 1 (already finished previous session)
- `inspector/jobs.tsx` — migrated, 16 keys (`inspector_jobs.*`)
- Audited `notifications.tsx` + `messages.tsx` — confirmed already fully i18n

### Batch 2 (this session) — **+5 files**
| File                              | Lines | Namespace                            | Keys |
| --------------------------------- | ----- | ------------------------------------ | ---- |
| `app/forgot-password.tsx`         | 124   | `forgot_password.*`                  | 9    |
| `app/2fa-verify.tsx`              | 162   | `two_factor.*`                       | 10   |
| `app/provider/chats.tsx`          | 185   | `provider_chats.*`                   | 11   |
| `app/provider/current-job.tsx`    | 247   | `provider_current_job.*`             | 19   |
| `app/inspector/assignments-live.tsx` | 264 | `inspector_assignments_live.*`       | 19   |

**Total new keys (Batch 2):** 68 × 3 locales = 204 string entries

### `(tabs)/create.tsx` (7 LOC) — **no-op**
File is a placeholder (`<View />` only). Contains zero user-facing strings; nothing to migrate.

## Verified after migration

- Metro bundle compiles cleanly: **10.24 MB**, status 200
- All 3 locale files (`de.json` / `en.json` / `ru.json`) have full key parity for all 6 new namespaces
- No regressions in existing screens
- `notifications.tsx`, `messages.tsx` — verified unchanged (already done)

## Coverage trajectory

```
Session start:  53 / 130 = 40.8 %
Batch 1:        54 / 130 = 41.5 %   (+1)
Batch 2:        59 / 130 = 45.4 %   (+5)
```

## Files WITHOUT `useTranslation` — 71 remaining (grouped by domain)

| Domain               | Count | Priority | Notes |
| -------------------- | ----- | -------- | ----- |
| **root**             | 13    | 🟠 high  | `disputes`, `favorites`, `zones`, `partner-register`, `direct`, `map`, `referral`, `provider-boost*`, `+html` (skip), `security-2fa`, `provider-intelligence`, `2fa-verify` ✅, `forgot-password` ✅ |
| **provider**         | 10    | 🟠 high  | `inbox` (404 LOC, NEXT), `workbench`, `clusters`, `performance`, `stats`, `availability`, `earnings*`, `explain`, `chat/[id]` |
| **inspector**        | 9     | 🟠 high  | `assignments-live` ✅, `topology`, `reputation`, `exposures`, `public-profile`, `verification`, `notifications`, `capture/[context]`, `job/[id]/*` (3 files) |
| **(tabs)**           | 2     | 🟠 high  | `garage` (508 LOC, NEXT), `quotes` (486 LOC, NEXT) |
| **booking**          | 5     | 🟡 med   | `payment`, `payment-cancel`, `summary`, `payment-success`, `repeat` |
| **service-marketplace** | 4  | 🟡 med   |       |
| **request**          | 3     | 🟡 med   |       |
| **quote**            | 2     |          |       |
| **payments**         | 2     |          |       |
| **packages**         | 2     |          |       |
| **operator**         | 2     |          |       |
| **dashboard**        | 2     |          |       |
| **customer**         | 2     |          |       |
| **chat**             | 2     |          |       |
| **admin**            | 2     |          |       |
| **misc** (zones, subscription, review, repair, profile, payment, invite, delivery) | 8 | 🟡 |  |

## Recommended Batch 3 (next session)

Order by **biggest user-facing impact** + **clustering**:

| # | File                              | LOC  | Why                                        |
| - | --------------------------------- | ---- | ------------------------------------------ |
| 1 | `app/(tabs)/garage.tsx`           | 508  | Bottom-tab — every authed user sees it     |
| 2 | `app/(tabs)/quotes.tsx`           | 486  | Bottom-tab                                 |
| 3 | `app/provider/inbox.tsx`          | 404  | Provider daily-use #1                       |
| 4 | `app/favorites.tsx`               | small| Top-level user surface                      |
| 5 | `app/disputes.tsx`                | small| Top-level user surface                      |

## Recommended Batch 4 — `auto-request/create.tsx` split

The 1830-LOC wizard MUST be split into 3 micro-PRs to stay reviewable and safe:

| Sub-PR | Scope                                                  | Estimated LOC of strings |
| ------ | ------------------------------------------------------ | ------------------------ |
| 4a     | Header + scenario picker + entry validation            | ~50 strings              |
| 4b     | Wizard steps 1-3 (vehicle / city / budget / contacts)  | ~80 strings              |
| 4c     | Submit + payment + error states + success screen        | ~60 strings              |

Total estimated: ~190 keys × 3 locales = ~570 entries (about same as everything we did in this session).

## Discipline

1. **Per-batch commit/PR** with locale JSON in same change
2. **Key parity check**: `python3 -c "import json; [print(k) for k in set(json.load(open('de.json')).keys()) ^ set(json.load(open('en.json')).keys()) ^ set(json.load(open('ru.json')).keys())]"`
3. **Bundle check after batch**: hit `/node_modules/expo-router/entry.bundle?platform=web&dev=true` and require 200 + size > 9 MB
4. **No `t()` mid-string concat**: use interpolation `t('foo', { count: n })`, never `t('a') + ' ' + n`
5. **Brand names never translated**: `Auto Search`, `AutoSearch Support`, `Google Authenticator` stay literal

## Closing this iteration

✅ **Zero code break.** All 5 priority files migrated, bundle compiles, all 3 locales in parity. Coverage **+4.6 %** in one batch (53 → 59 files). 71 files remain; the next 3 (garage / quotes / provider-inbox) account for ~1400 LOC and will move coverage to ~48 %.
