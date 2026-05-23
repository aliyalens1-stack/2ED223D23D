# Phase 5 — Car-Selection i18n Stabilization (Wording Freeze)

**Date:** 2026-02-17
**Scope:** Car-Selection subsystem only (customer detail + provider list + provider detail + shared thread block).
**Status:** ✅ Frozen.

---

## 1. Why we did this *now*

After Phase 4 the subsystem stabilized:
- surfaces locked, testIDs locked, lifecycle invariants locked.
- thread is append-only · evidence is immutable · brief is read-only.

The right moment to **freeze customer-facing wording** is *before*:
- new artifact types appear,
- offer packages introduce paid-delivery semantics,
- richer status vocabulary leaks in.

This sprint did **not** add features. It locks vocabulary.

---

## 2. Discipline encoded

1. **Lifecycle enums are canonical** — never translated.
   `assigned` / `in_progress` / `waiting_customer` are keys into
   `car_selection.status.*`, never visible text themselves.
2. **Service-type ids are canonical** — `budget_search` etc. key into
   `car_selection.service.*`, never echoed raw.
3. **Backend error codes are canonical** — `ARTIFACT_TOO_LARGE` etc.
   map through `mapCarSelectionError(t, err, kind?)` →
   `car_selection.error.<CODE>` (or `<CODE>.<kind>` for size errors).
4. **No dynamic interpolation in error wording.**
   Per-kind size copy is **explicit**:
   - `Photo exceeds 8 MB limit`
   - `PDF exceeds 20 MB limit`
   - `File exceeds 10 MB limit`
   Not `${kind} exceeds ${cap} MB`. (Operational systems read better
   with explicit phrases.)
5. **Restrained tone.** No "Oops! Something went wrong 😢". Examples
   used in copy:
   `Append a message` · `Upload failed` · `Photo exceeds 8 MB limit`.
6. **Customer vs. provider status framing** — same canonical
   enum `waiting_customer`, two restrained variants:
   - customer sees `Waiting for you` (the act faces them)
   - provider sees `Waiting customer` (operational status)
   Backend stays unchanged; only the label key differs per surface.
7. **i18n.language is the only source of truth** for the active
   language at render time — no parallel state.

---

## 3. Files added / changed

```
ADDED  /app/frontend/src/i18n/carSelectionErrors.ts
       small helper: mapCarSelectionError(t, err, kind?), carSelectionErrorByCode(t, code, kind?)
       — extracts code/message from axios error envelope (data.{code,message}
         or data.detail.{code,message}); fallback chain:
            t('car_selection.error.<CODE>(.<kind>)')   ← preferred
            backend `message`                          ← restrained
            t('car_selection.error.generic')           ← last resort

CHANGED /app/frontend/src/i18n/locales/en.json   +car_selection block (4.3 KB)
CHANGED /app/frontend/src/i18n/locales/ru.json   +car_selection block (5.6 KB)
CHANGED /app/frontend/src/i18n/locales/de.json   +car_selection block (5.3 KB)

CHANGED /app/frontend/src/components/CarSelectionThreadBlock.tsx
        all visible strings → t('car_selection.*')
        per-kind size-cap message → carSelectionErrorByCode(...)
        role badge labels via ROLE_LABEL map at render time
        send axe — accessibilityLabel via t()

CHANGED /app/frontend/app/car-selection/[id].tsx           (customer surface)
        STATUS_LABEL / SERVICE_LABEL moved into component (useMemo + t())
        eventLabel() → car_selection.timeline_event.<type>
        formatDate(iso, i18n.language) — locale-aware via Intl
        cancel modal: Alert wired to t() keys
        error fallbacks → mapCarSelectionError(t, err)

CHANGED /app/frontend/app/provider/car-selection/index.tsx (provider list)
        SERVICE_LABEL_KEY / STATUS_LABEL_KEY → resolve through t()
        KPI labels, empty/error states, group headers → t()
        relative time agoLabel passed through t('car_selection.list.ago')

CHANGED /app/frontend/app/provider/car-selection/[id].tsx (provider detail)
        STATUS / SERVICE / TRANSITION maps moved into component (useMemo + t())
        brief lock label / hint → t()
        meta / criteria labels → t()
        transition Alert.alert → t() + mapCarSelectionError
        terminal / pre-assigned copy → t()
```

---

## 4. Key map at a glance

```
car_selection
├── title / back / loading / not_found / not_found_hint
├── back_to_list / load_failed / list_load_failed
├── list.{title,subtitle,empty,empty_hint,loading,ago}
├── kpi.{active,new,wait,done}
├── status.{submitted,reviewing,assigned,in_progress,
│           waiting_customer,waiting_customer_customer,
│           completed,cancelled}                          ← canonical key, surface-aware label
├── service.{budget_search,market_search,negotiation_help,listing_review}
├── role.{customer,provider,admin}
├── section.{description,source,criteria,timeline,history,thread,actions}
├── brief.{lock_label,lock_hint}
├── criteria.{budget,budget_from,budget_to,brands,fuel,transmission,year}
├── meta.{created,updated,assigned_label,location}
├── actions_block.note_placeholder | note_hint | status_update_failed | busy
├── actions_block.transition.{in_progress,waiting_customer,completed}
├── terminal.{completed,cancelled,pre_assigned}
├── cancel.{button,modal_title,modal_body,modal_keep,modal_confirm,failed}
├── thread.{title,count,hint,empty,load_failed,send_failed,
│           input_placeholder,send,open}
├── picker.{photo,pdf,file,cancel}
├── upload.{permission_denied,failed,open_failed,open_failed_status}
├── timeline_event.{submitted,assigned,
│                   status:reviewing,status:assigned,
│                   status:in_progress,status:waiting_customer,
│                   status:completed,status:cancelled}
└── error
    ├── ARTIFACT_TOO_LARGE.{image,pdf,file,default}     ← per-kind explicit
    ├── ARTIFACT_EMPTY
    ├── ARTIFACT_INVALID_KIND
    ├── ARTIFACT_KIND_MIME_MISMATCH
    ├── ARTIFACT_TOO_MANY
    ├── ARTIFACT_NOT_FOUND
    ├── ARTIFACT_CROSS_REQUEST
    ├── ARTIFACT_BUCKET
    ├── CAR_SELECTION_NOT_FOUND
    ├── INVALID_TRANSITION
    ├── FORBIDDEN_PROVIDER
    └── generic
```

73 keys resolved in **EN / RU / DE** (verified by exhaustive lookup test).

---

## 5. Verification

- ✅ `tsc --noEmit` — zero new errors in Car-Selection files
  (`carSelectionErrors.ts`, `CarSelectionThreadBlock.tsx`, customer
  detail, provider list, provider detail). Pre-existing TS errors in
  other unrelated files predate this sprint.
- ✅ Zero remaining Cyrillic literals in the 4 modified files
  (`grep -P "[А-Яа-яЁё]"` → empty).
- ✅ 73 referenced i18n keys resolve in all three locales (script).
- ✅ Expo bundle compiles; app boots; lighthouse landing renders.
- ✅ Backend smoke unchanged (no backend code touched in this sprint).

---

## 6. What is NOT in this sprint (intentionally)

- ❌ No new artifact types
- ❌ No Offer Package (would introduce new domain entities)
- ❌ No customer-side upload (customer reading/opening is enough)
- ❌ No backend message rewrites (server messages already restrained;
  we just stopped echoing them unfiltered)
- ❌ No web-app / admin-panel i18n changes (those surfaces have their
  own locale namespaces; Phase 5 is mobile-only freeze)

---

## 7. Production readiness verdict

After Phase 5 the Car-Selection mobile subsystem is:

- architecturally complete (Phase 1-3)
- operationally complete (Phase 4)
- **customer-facing stable** (Phase 5)

This is a textbook-quality vertical:
**append-only communication · immutable evidence · projection-based
notifications · frozen workflow truth · role-scoped visibility ·
locked operational vocabulary.**

Ready to be the foundation for the next domain expansion sprint
(Car-Selection-v2 / Offer Packages).
