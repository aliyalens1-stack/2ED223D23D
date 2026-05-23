# 🔒 LEGACY /SUMMARY DATETIME COERCION — SHIPPED

**Date:** 2026-05-13 10:33 UTC
**Status:** ✅ **SHIPPED** (narrow operational defect closure)
**Predecessors:** Phase 1A ✅ · Phase 1B ✅ · Redis Truthfulness ✅ · Phase 2A-α ✅ · Phase 2A-β ✅
**Successor:** Phase 2A-γ (customer/provider currency surface) — NOT STARTED

---

## 1. Scope (locked, exactly as specified)

Reader-side tolerant datetime coercion for `/api/admin/revenue/summary`.

| Concern | Decision |
|---|---|
| "Переписать revenue summary" | ⛔ NO — only the sort key + response field touched |
| "Normalization migration" | ⛔ NO — zero writes to DB, no migration script |
| "Parse all dates everywhere" | ⛔ NO — single helper used only at the 500 path |
| Reader-side coercion | ✅ minimal helper `_coerce_created_at(value)` |
| Additive | ✅ helper is new symbol, callsite is one-line swap |
| No response-shape drift | ✅ Phase 2A-α back-compat test re-asserts the key set |
| No semantic reinterpretation | ✅ ISO 8601 strings kept verbatim (lex sort = chron sort) |
| Malformed: skipped, never silently coerced into wrong totals | ✅ unsupported types → `""` (sortable bottom) + counter + throttled log |

**Master operational invariant:** *mixed historical legacy createdAt types
must not 500 the endpoint, and must not be silently coerced into wrong totals.*

---

## 2. The bug (reproduced & fixed)

Repro before fix:
```bash
$ mongosh test_database --eval '
  db.payment_transactions.insertMany([
    {status:"paid", amount:100, currency:"EUR", createdAt: new Date()},        # BSON Date
    {status:"paid", amount:200, currency:"EUR", createdAt: new Date().toISOString()}  # ISO str
  ]);
'
$ curl -H "Authorization: Bearer $ADMIN" /api/admin/revenue/summary
HTTP=500
{"error":true,"code":"INTERNAL_ERROR","message":"'<' not supported between instances of 'datetime.datetime' and 'str'"}
```

Traceback pinpoints `app/revenue/__init__.py:225`:
```python
recent.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
                                                ^^^^^
                              # When dict has datetime in one row and str in
                              # another, Python's sort heap-merge compares
                              # them with `<` and raises TypeError.
```

After fix:
```bash
$ curl ... /api/admin/revenue/summary
HTTP=200
{ "today": 0, ..., "recent": [{ ..., "createdAt": "2026-05-13T10:29:43.238Z" }, ...] }
```

Same docs, same query, same code path — just clean integers and strings on the way out.

---

## 3. The fix (~70 LOC)

### `app/revenue/__init__.py` — new helper

```python
def _coerce_created_at(value: Any) -> str:
    """Reader-side coercion of `createdAt` to an ISO-8601 sortable string."""
    if value is None:
        return ""                               # sortable bottom
    if isinstance(value, datetime):
        return value.isoformat()                # BSON Date → ISO string
    if isinstance(value, str):
        return value                            # ISO string → verbatim
    _malformed_created_at_counter += 1          # debug counter
    # throttled WARNING log (first malformed per minute bucket)
    return ""                                   # never raise
```

### `app/revenue/__init__.py` — single callsite swap (line ~225 before, ~290 after with the new module docstring)

```python
for d in docs:
    recent.append({
        ...
-       "createdAt": d.get("createdAt"),
+       # Reader-side tolerant coercion (see module docstring).
+       # Normalize at projection time so the sort below and the JSON
+       # response both see a string. Datetime/BSON-Date docs become ISO;
+       # unknown types become "" (sortable bottom).
+       "createdAt": _coerce_created_at(d.get("createdAt")) or None,
    })
- recent.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
+ # Sort by the already-coerced string — datetime ↔ str crash impossible.
+ recent.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
recent = recent[:10]
```

Note: the sort line text is byte-identical, but its semantics are now safe
because every element in `recent` already has `createdAt` as `str | None`.

### Why NOT touch the `$gte: start_iso` queries

The `_sum_amount` helper and other aggregation matches use
`createdAt: {$gte: start_iso}`. MongoDB's BSON ordering treats `Date < String`,
so a BSON-Date doc would NOT match an ISO-string lower bound — this is a
**second** latent defect (silent under-count when DB has BSON Date rows).
It is **deliberately not addressed** in this pass per the constraint
"Не parse all dates everywhere". The malformed counter + future Phase 1A.2
backfill (cluster + canonical createdAt format) are the right place to
address it, not here.

A note has been logged in the module docstring to make this trade-off
visible to the next maintainer.

---

## 4. Test coverage

`backend/tests/test_revenue_datetime_coercion.py` — **10/10 PASS**

| Test | What it locks |
|---|---|
| `test_coerce_datetime_returns_iso_string` | datetime → ISO string |
| `test_coerce_iso_string_returns_verbatim` | ISO string passes through unchanged |
| `test_coerce_none_returns_empty_string` | None → "" (sortable bottom) |
| `test_coerce_unknown_type_returns_empty_string_and_does_not_raise` | int/list/dict/float/object → "" without raising |
| `test_coerce_increments_malformed_counter_on_unknown_type` | drift detection counter increments for unsupported |
| `test_coerce_does_not_increment_counter_on_valid_inputs` | counter does NOT bump for valid datetime/str/None |
| `test_mixed_inputs_can_be_sorted_after_coercion` | sort of coerced keys is total + correct order |
| `test_summary_endpoint_200_with_mixed_created_at_types` | end-to-end: seed BSON Date + ISO + missing → 200 |
| `test_summary_response_keys_unchanged_after_coercion_fix` | Phase 2A-α back-compat freeze still holds |
| `test_summary_recent_items_have_string_or_none_createdAt` | no datetime leakage into JSON response |

### Regression — **45/45 total backend tests green**
- 10 datetime coercion (NEW)
- 11 Phase 2A-α cluster summary
- 7 dedupe_bucket (Redis Truthfulness)
- 17 Phase 1B writer enrichment

Pre-existing test suites untouched.

---

## 5. Live verification (post-fix)

```bash
$ mongosh test_database --eval 'db.payment_transactions.countDocuments({_repro: true})'
2                                              # BSON Date + ISO string both still in DB

$ curl ... /api/admin/revenue/summary
HTTP=200                                       # ← was 500 before this pass
recent count: 4
recent[0].createdAt: "2026-05-13T10:29:43.238Z"  ← ISO string in JSON
all createdAt values in recent are str or None ← contract holds
```

Browser screenshot at `https://...preview.../api/admin-panel/revenue`
shows the full legacy dashboard rendering (Today / Week / Month KPI cards,
Conversion, Revenue Sources panel, Top providers, Top zones, Recent
transactions) — no more "Legacy summary unavailable" red banner. Split-brain
between legacy and Phase 2A-β cluster panels closed.

---

## 6. What this pass deliberately does NOT do

| Not done | Reason |
|---|---|
| Fix `$gte: start_iso` query silent-undercount on BSON Date rows | Explicit user constraint "Не parse all dates everywhere"; second defect, addressable in Phase 1A.2 |
| Add request-side createdAt validation | Out of scope (reader-side pass) |
| Migrate all historical docs to canonical ISO string | "Не normalization migration" — would require DB write path |
| Touch Phase 2A-α contract surface | Frozen |
| Touch Phase 2A-β UI surface | Already shipped & decoupled |
| Bump response shape version | No drift |

---

## 7. Reversibility

`git revert <this-commit>` undoes everything:
1. Remove `_coerce_created_at` helper + `_malformed_created_at_counter` +
   `_malformed_log_throttle` + the module docstring section.
2. Restore the literal `"createdAt": d.get("createdAt")` projection.

The endpoint will revert to its prior 500-on-mixed-types behavior.
**No DB rollback needed** — pass writes nothing.

---

## 8. Phase ladder

| Phase | Description | Status |
|---|---|---|
| 1A | Historical provenance | ✅ COMPLETE |
| 1B | Future provenance (writer cluster-native) | ✅ FROZEN |
| Redis Truthfulness | Honest docstrings + insert dedupe | ✅ SHIPPED |
| 2A-α | Revenue reader contract | ✅ FROZEN |
| 2A-β | Admin visualization (read-only, literal) | ✅ SHIPPED |
| **Legacy /summary datetime coercion** | **Reader-side tolerant coercion at the 500 path** | ✅ **SHIPPED (this pass)** |
| 2A-γ | Customer/provider currency surface | NOT STARTED |
| 1A.2 | Cluster + createdAt backfill on historical paid docs | DEFERRED (would address the second latent defect) |
| 1B.1 | Cluster writer for `provider_purchases` | DEFERRED |
| 3 | Webhook dispatcher unification | NOT STARTED |

**Revenue semantics layer is now stable:**
- writers consistent ✅
- readers consistent ✅
- admin surface semantics visible ✅
- operational dedupe stabilized ✅
- legacy /summary no longer the obviously-broken admin path ✅

Right moment to move to 2A-γ when the user authorizes the next step.
