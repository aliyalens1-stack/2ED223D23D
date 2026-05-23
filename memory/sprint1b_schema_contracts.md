# Sprint 1B — Future-proof schema contracts (DONE)

## Goal (per direction)
**NOT migration.** Create stable, future-proof schema contracts that we won't have to break in 6 months. Empty collections + indexes + seed for controlled vocabulary.

## Naming rule (locked in 1B)
- **`account.kind`** = BUSINESS PERSONA (noun, who you are)
  `customer | admin | inspector | service_provider | dealer | transport_provider`
- **`account_capability.capability`** = ACTION VERB (what you can DO)
  `inspect | repair | wash | tow | transport | sell`
- **`specialization._id`** = STABLE ENUM ID (lowercase ASCII, no spaces)
  `bmw | ev | accident_detection | ...` — NEVER user-typed strings.
- Capabilities are **domain-agnostic** so future verticals (motorcycle / truck / marine) can reuse them.

## Vocabulary updates (from 1A)
The capability set was renamed from nouns (`inspector`, `service_provider`, `dealer`, `transport`) to verbs (`inspect`, `repair`, `wash`, `tow`, `transport`, `sell`). JWTs issued in 1A had `caps=['inspector']`; new tokens get `caps=['inspect']`. Legacy `role` claim unchanged (still `provider_owner` etc.) — fallback continues to work.

## What landed in 1B

### 1. Vocabulary update (`app/core/capability.py`)
- `KNOWN_CAPABILITIES = ('inspect', 'repair', 'wash', 'tow', 'transport', 'sell')` (verbs)
- `ACCOUNT_KINDS = ('customer', 'admin', 'inspector', 'service_provider', 'dealer', 'transport_provider')` (nouns)
- `KNOWN_CAPABILITY_KINDS` retained as alias for 1A compat
- `_LEGACY_ROLE_TO_CAPS` updated: `provider → ['inspect']`, `service_provider → ['repair']`, `dealer → ['sell']`, `transport → ['transport']`
- New `derive_account_kind_from_legacy()` — returns business persona separately from caps
- `build_active_account_snapshot()` now sets `kind` from account-kind mapping (not first cap), so admin gets `kind='admin'` even with empty caps

### 2. Pydantic schemas (`app/core/schemas_capability.py`)
Forward-compatible models with runtime assertions against vocabulary drift:
- `Account` — operational context, has `AccountStats` (rating, reviews, jobs, earnings cents)
- `AccountCapability` — thin permission layer; `specializations` are stable IDs only
- `Organization` — minimal team model (members[], owner, type)
- `Specialization` — controlled enum entry with `labels[locale]`, `aliases[]`, `searchTokens[]`
- `assert set(CapabilityVerb.__args__) == set(KNOWN_CAPABILITIES)` — tripwire if vocab drifts
- `assert set(AccountKind.__args__) == set(ACCOUNT_KINDS)` — tripwire if persona drifts

### 3. Collections + indexes (`scripts/init_capability_collections.py`)
Idempotent. Re-runnable. Safe.
| Collection | Indexes |
|---|---|
| `accounts` | `uniq_user_kind` (compound unique), `by_kind_status`, `by_org`, `uniq_slug` (sparse), `by_created` |
| `account_capabilities` | `uniq_account_cap` (compound unique), `by_cap_status`, `by_spec` |
| `account_organizations` | `uniq_slug`, `by_owner`, `by_type`, `by_member` |
| `specializations` | `by_cat_order`, `by_active`, `by_search`, `by_alias` |

⚠️ Legacy `organizations` (workshop/provider directory, 11 docs) is **untouched**. New team-model lives in `account_organizations` to avoid schema clash. 1C will decide whether/how to merge.

### 4. Specializations seed (29 entries)
Stable IDs across 6 categories:
- **brand** (10): bmw, mercedes, audi, vw, porsche, opel, ford, skoda, toyota, japanese
- **powertrain** (3): ev, hybrid, diesel
- **vehicle_class** (4): classic, motorcycle, truck, van
- **service_type** (7): accident_detection, mileage_fraud, paint_thickness, engine_diagnostics, body_repair, electrical, flood_damage
- **trust_signal** (3): tuv_certified, dekra_certified, master_mechanic
- **geographic** (2): eu_import, ru_import

Each entry has `labels{en|de|ru}`, `aliases[]` (free-form variants seen in the wild), `searchTokens[]` (normalized keywords), `sortOrder`, `active=true`.

Re-running the seed updates labels/aliases/tokens but preserves `createdAt` via `$setOnInsert`.

### 5. Tests (`tests/test_sprint1a_capability.py` extended)
**15/15 pass:**
- Customer/admin login, JWT shape, /me endpoint
- Provider register → caps=['inspect'] (verb-form)
- Legacy `/api/customer/credits` unaffected
- 9 cases of `derive_capabilities_from_legacy`
- Dual-shape `has_capability` + `has_any_capability`
- Sprint 1B collections all exist
- Specializations seed: bmw entry valid, ≥25 active
- `accounts.uniq_user_kind` compound index present
- `account_capabilities.uniq_account_cap` index present

## What is **NOT** done in 1B (intentionally)
- ❌ No data migration from `users` / providers* — 1C
- ❌ Capability helpers still derive from legacy `users.role` — 1C will switch them to read from new collections (with legacy fallback)
- ❌ No endpoints touched — 1D
- ❌ No frontend changes — 1E
- ❌ No merge of legacy `organizations` and new `account_organizations` — out of scope, decide in 1C

## Forward-compatibility guarantees
- The shape of `/auth/me.activeAccount` is **stable contract** — same JSON whether data comes from legacy `users.role` (1A/1B) or real `accounts` doc (1C+).
- All Pydantic literals have runtime asserts — vocabulary drift fails at import.
- Specialization IDs are immutable — labels/aliases can evolve.
- New verticals (motorcycle/truck/marine) can reuse capabilities and add `vehicle_class.motorcycle/truck/marine` specializations without touching capability code.

## Files changed
- MOD: `/app/backend/app/core/capability.py` — verb vocabulary, account kind helper
- ADD: `/app/backend/app/core/schemas_capability.py` — Pydantic models + drift tripwires
- ADD: `/app/backend/scripts/init_capability_collections.py` — idempotent collection+index+seed initializer
- MOD: `/app/backend/tests/test_sprint1a_capability.py` — verb-vocabulary + Sprint 1B sanity (15 tests)

## Next: Sprint 1C — Migration
For each existing `users.role='provider'/'provider_owner'`:
1. Create `accounts` doc with `kind='inspector'`, `legacyRole=<old_role>`, `userId=<users._id>`
2. Create `account_capabilities` doc with `capability='inspect'`, `status='verified'`
3. Set the user's `accountId` claim in newly issued JWTs to the new accounts._id
4. Capability helpers switch to **read from new collections, fall back to legacy** (no breaking change)

Idempotent migration script (run multiple times safely). No destructive ops. Legacy `users.role` preserved.
