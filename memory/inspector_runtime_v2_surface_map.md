# Inspector Runtime v2 — Surface Map

> **Status**: Design deliverable, before code. Living document.
> **Principle**: UI execution reality → backend support. Not reverse.
> **Mental model**: проведение полевой операции, не заполнение анкеты.

---

## 0. Core principles (binding)

| # | Principle | Meaning in practice |
|---|---|---|
| 1 | **Evidence-first, summary-last** | Inspector сначала добавляет media + structured observations. Verdict draft появляется в конце как **emergent**, не как input. |
| 2 | **One cognitive chunk at a time** | Никаких giant-form. Один section = один экран. Внутри section — один item = один focused interaction. |
| 3 | **Resumable everywhere** | Любое прерывание (звонок, потеря связи, выгрузка app, разрядка) не должно терять ни байта прогресса. State persistent с автосейвом. |
| 4 | **Offline-tolerant** | Inspections происходят в паркингах, подвалах, деревнях. Network — fallback, не зависимость. Local-first, sync queue. |
| 5 | **Media-native** | Камера встроена в flow, не attached. Каждый фото/видео tied to конкретному item/section. Нельзя "добавить 5 фото в конце". |
| 6 | **Progressive confidence** | Поток наблюдений → findings → verdict draft → final. Inspector не должен в начале знать ответ. |
| 7 | **Report = emergent** | Финальный PDF/JSON отчёт не пишется. Он **извлекается** из runtime data. Inspector только confirms. |

---

## 1. Honest baseline — что уже есть в `frontend/app/inspector/`

| Файл | Что делает | Соответствует runtime v2? |
|---|---|---|
| `jobs.tsx` | Список open + my jobs | ✅ Подходит как entry, минимальные доработки |
| `job/[id]/index.tsx` | Detail + lifecycle actions (claim → on_route → arrived → start) | ⚠️ Lifecycle ОК, но action set слабый для arrival (нет GPS check, VIN scan, flashlight, network indicator) |
| `job/[id]/report.tsx` | Giant single-page form: все checklist items, статусы, photos, summary, score, verdict в одном scroll | ❌ Антиподход runtime v2 — это monolithic form, не section-by-section. Заменяется. |
| `checklist.py::CHECKLIST` (backend) | Hardcoded 60+ items по 15 groups (documents, body, engine, transmission, brakes, suspension, tyres, glass, lights, interior, ac, electronics, test_drive, environment, history) | ✅ Использовать как **template source**. Не переизобретать. |

**Что переиспользуется как есть:**
- Lifecycle states (`claimed → on_route → arrived → inspecting → done`)
- Atomic `CHECKLIST` keys и `ITEM_STATUSES`
- `POST /api/inspector/jobs/:id/report` финальный submission endpoint
- Media upload pipeline (`inspection_media` collection, `/api/media/:id`)

**Что переписывается:**
- `report.tsx` → разрезается на section runtime
- Action-buttons на arrival → arrival workspace screen

---

## 2. Surface Graph

```
   inspector tabs
          │
          ▼
   [A] my jobs ──────────────► [B] job detail (preview before claim)
                                       │
                                       ▼  (claim)
                              [C] job workspace
                                       │
                       ┌───────────────┴─────────────────┐
                       ▼                                 ▼
                [D] arrival                    [E] resume runtime
                       │                                 │
                       ▼                                 │
                [F] runtime entry  ◄─────────────────────┘
                       │
                       ▼
          ┌─────────────────────────────┐
          │                             │
          ▼                             ▼
   [G] section runtime ─── (next) ──► [G'] next section
          │                             │
          │                             │
       (last section)                   │
          ▼                             │
   [H] draft preview ◄──────────────────┘
          │
          ▼
   [I] submit confirmation
          │
          ▼
   (back to my jobs · status=done)
```

**8 screens total.** Inspector никогда не видит больше одного **active
content area** одновременно.

---

## 3. Per-screen anatomy

### [A] My Jobs (existing — light enhancement)

| Aspect | Detail |
|---|---|
| **What user sees** | Two lists: `IN PROGRESS` (resumable) + `AVAILABLE` (claimable) |
| **Per row** | Brand/model · city · payout · ETA · **progress %** if started · network/battery indicator если active |
| **Interactions** | Tap → [B] for new, → [F] runtime entry для in-progress |
| **Persistence** | Server-side list. Local cache of last fetch (для cold start без сети). |
| **Required?** | Already exists. Add `progressPct` на active jobs. |
| **Auto-generated** | — |

### [B] Job Detail / Preview (existing)

Что видит до claim'а: листинг, city, цены, customer comment. **Не runtime
yet** — это commitment screen. Кнопка «Взять заявку».

### [C] Job Workspace (existing — `index.tsx`)

Post-claim home. Lifecycle actions (on_route → arrived → start).
**Reformat**: меньше похож на админ-панель, больше — на dispatcher
mission card. Sticky-bottom action — текущий правильный next step.

### [D] Arrival (NEW — replaces inline arrival action)

> Самый недооценённый экран. Сейчас это одна кнопка «Arrived» — в runtime
> v2 это **полевая операция**.

**What inspector sees:**
- Address + map preview (тапнуть → external maps)
- Seller name + phone (один tap → call / WhatsApp)
- **GPS distance** к точке (auto-refresh, "вы в 80 м от точки")
- **VIN expected** (из листинга) + кнопка `📷 SCAN VIN` (OCR)
- Quick-actions row: `🔦 Flashlight` · `📷 Camera test` · `📶 Network` · `🔋 Battery`
- One sticky CTA: **«Я на месте — начать осмотр»**

**What inspector can do:**
- Mark arrived (auto-attaches GPS coords + photo of arrival point)
- Call seller (deep-link tel:)
- Scan VIN (camera OCR; result сохраняется как **first artefact** — ещё до start)
- Test flashlight (важно: пока seller рядом, inspector проверяет что инструменты работают)

**What is saved:**
- `arrivedAt` server timestamp + GPS lat/lng
- VIN scan result (если был) → linked to session, не to checklist item
- "Pre-arrival photo" (опционально — место встречи)

**Required to proceed:** GPS подтверждение arrival OR override с reason
(если GPS отказал — текстовый dispute log)

**Offline:** GPS работает offline. Action `arrived` уходит в sync queue.

**Auto-generated:** ничего на этом экране.

### [E] Resume Runtime (NEW — invisible until needed)

Не отдельный экран — это **boot logic** для [F]. При re-entry в active
session:
- читает local persistence
- определяет последний touched section
- запускает [G] на этой секции с `resumed=true` баннером "Вы остановились на 7/15"

**Persistence layer:**
- AsyncStorage key: `inspection_session_<jobId>` (full state)
- MMKV preferable (быстрее на JSON heavy state) — оценить migration cost
- Auto-flush каждые 2 секунды после любого change

### [F] Runtime Entry (NEW)

Первый экран после `start_inspection`. Это **map of upcoming work**:

```
INSPECTION · BMW 320d
Berlin · 14:32 started

▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  0/15

▸  1   Documents              required · 5 items
▸  2   Body & paint           required · 11 items · 4 photos min
▸  3   Engine                 required · 5 items
▸  4   Transmission           required · 4 items
▸  5   Brakes                 required · 3 items
▸  6   Suspension             required · 4 items
▸  7   Tyres                  required · 4 items
▸  8   Glass                  required · 3 items
▸  9   Lights                 required · 4 items
▸ 10   Interior               required · 5 items
▸ 11   A/C & climate          required · 2 items
▸ 12   Electronics            required · 4 items
▸ 13   Test drive             required · 5 items · video required
▸ 14   Environment & history  required · 3 items
▸ 15   Final media            required · walkaround video + VIN photo

[ Начать с раздела 1 ]
```

**Inspector can:**
- Start sequentially (recommended path)
- Jump to any section (e.g. test drive while engine warm)
- See per-section completion % and required-evidence status

**Section status icons:**
- `▸` not started
- `▰` in progress (n/total items)
- `✓` complete with all required evidence
- `⚠` complete but missing required photo/video
- `✗` skipped with reason

### [G] Section Runtime (THE CORE SCREEN — NEW)

> One section. One screen. Bottom-sheet pattern с up/down swipe между
> items внутри section.

**Layout:**
```
┌─ Section 2/15 · Кузов и покрас ──────────────┐
│  ▰▰▰▰▱▱▱▱▱▱▱  4/11                          │
│                                              │
│  Item 5/11 · Левое переднее крыло            │
│  ┌────────────────────────────────────────┐  │
│  │  📷    (large camera button)           │  │
│  │  press to capture photo for this item  │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Толщина ЛКП:   [ 128 ] µm                   │
│  Покрас?        ◯ нет  ● да  ◯ unknown       │
│  Ржавчина?      ◯ нет  ◯ да   ● не вижу      │
│  Severity:      ◯ ok  ● warning  ◯ critical  │
│  Note (опц):    ┌──────────────────────────┐ │
│                 │ царапина у фары, ~10 см  │ │
│                 └──────────────────────────┘ │
│  🎤 voice note (15s)                         │
│                                              │
│  attached: 1 photo · 0 video · 1 voice       │
│                                              │
│  [ ← prev item ]    [ next item → ]          │
└──────────────────────────────────────────────┘
                                  ⓘ tap для help
[ section overview ]   [ skip section ]
```

**Critical interactions:**

| Action | What happens |
|---|---|
| **Big 📷 button** | Inline camera (`expo-camera`) → photo bound to this item (`itemId`, `sectionId`). Возврат к этому же item. |
| **Auto-warning** | `paint_depth > 300 µm` → severity автоматически `warning` (overridable). Out-of-range numbers самозаполняют severity. |
| **Item navigation** | Swipe up/down OR `next/prev` buttons. State autosaves on every transition. |
| **Voice note** | 15-second cap. Stored как audio artefact, не STT (in v2). |
| **Help icon** | Контекстная подсказка ("норма 80-150 µm; новая краска 150-250; ремонт 300+"). |
| **Skip section** | Modal с required reason. Allowed для optional sections, blocked для required. |

**What is saved (every change):**
- Item result `{itemKey, sectionKey, numericValue?, severity, note?, photoIds[], voiceId?}` 
- Persist queue → flush к local + (если есть сеть) к backend
- Item server status: `not_checked` → `checked` (regardless of severity)

**Required to proceed:** Required-evidence on critical items (e.g. VIN
без фото — block exit). Soft warnings на missing photo для warning items
(можно proceed с подтверждением).

**Offline:**
- Camera fully offline (фото в `expo-file-system` + base64 cache).
- All saves local-first.
- Background sync queue (см. секцию 5).

**Auto-generated:**
- Severity из numeric out-of-range (paint depth, tyre depth, brake pad mm).
- Per-item `checkedAt` timestamp.

### [H] Draft Preview (NEW)

> Inspector видит **что система собрала** до того как submit. **Read-only**
> для checklist results — нельзя редактировать item с этого экрана
> (только переходить в [G]).

```
┌─ Inspection Draft · BMW 320d ─────────────────┐
│                                               │
│  Computed verdict suggestion:                 │
│  ┌─────────────────────────────────────────┐  │
│  │   RISK   ·   computed score 68/100      │  │
│  │   2 critical · 5 warnings               │  │
│  └─────────────────────────────────────────┘  │
│                                               │
│  Findings (auto-derived):                     │
│   ✗ Правое крыло · перекрас (410 µm)          │
│   ✗ Тормозные диски · биение                  │
│   ⚠ Шина LR · 3 мм (порог 4)                  │
│   ⚠ Подшипник переднего L                     │
│   ⚠ A/C не охлаждает                          │
│   ⚠ Сервисная книжка отсутствует              │
│   ⚠ Стоп-сигнал LR не работает                │
│                                               │
│  Evidence summary:                            │
│   24 photos · 2 videos · 3 voice notes        │
│   walkaround video ✓ · VIN photo ✓            │
│                                               │
│  Inspector summary (опционально):             │
│   ┌─────────────────────────────────────────┐ │
│   │ Машина в целом нормальная, но перекрас  │ │
│   │ правого крыла + биение дисков сильно    │ │
│   │ снижают цену...                         │ │
│   └─────────────────────────────────────────┘ │
│                                               │
│  Final verdict (confirm or override):         │
│   ◯ recommended    ● risky    ◯ not_recommended │
│                                               │
│  ⚠ Computed = RISK · You chose = RISK (same)  │
│                                               │
│  [ Back to sections ]      [ Submit report ]  │
└───────────────────────────────────────────────┘
```

**What inspector can do:**
- See computed verdict + suggested findings
- Add optional human nuance (summary text + voice)
- Confirm OR override final verdict
- Jump back to any section to fix

**What is saved:**
- `inspectorSummary` (если добавил)
- `inspectorVerdict` (final, может ≠ computed)
- `inspectorScoreOverride` (если override score)
- Deviation flag: если `inspectorVerdict ≠ computedVerdict` → передаётся в QA с пометкой "high deviation" (для Slice 2 QA analytics)

**Required to proceed:**
- Все required sections complete OR skipped с reason
- Walkaround video + VIN photo present
- Final verdict выбран

**Offline:** Draft preview fully computed local (нужен `computeVerdict()`
client-side; server делает то же самое при `/report` submit для проверки).

**Auto-generated:**
- Computed verdict + score
- Findings list (severity ≥ warning + comment)
- Repair cost estimate min/max (sum по item-level estimates)
- Risk level (low/medium/high)

### [I] Submit Confirmation (existing logic + new framing)

Тонкий экран:
```
Отправить отчёт?
Inspection credit будет списан с customer.
Этот шаг необратим.

[ Cancel ]   [ Submit report ]
```

После submit:
- 200 OK → toast "Отчёт отправлен" → router back to /inspector/jobs
- Network fail → state остаётся, sync queue retry с backoff
- Server reject (race, double-submit) → modal с подробностями

---

## 4. Cross-cutting models

### 4.1 Offline model

```
                  ┌─────────────────────┐
   user action ──►│  reducer (in-memory)│──► UI update
                  └─────────┬───────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  AsyncStorage flush │  (debounced 1s)
                  │  every change       │
                  └─────────┬───────────┘
                            │
                            ▼
                  ┌─────────────────────┐
                  │  sync queue (FIFO)  │
                  │   { kind, payload } │
                  └─────────┬───────────┘
                            │
                            ▼
                  ┌─────────────────────┐  online?
                  │     dispatcher      │────────► retry с backoff
                  └─────────┬───────────┘
                            │ HTTP POST
                            ▼
                          server
```

**Sync queue contents (kinds):**
- `session.arrive` — GPS + arrival timestamp
- `session.startInspection`
- `item.update` — checklist item result
- `media.upload` — base64 photo/video/voice (chunked если > 5 MB)
- `section.skip` — skip with reason
- `draft.save` — periodic snapshot of full draft
- `report.submit` — final atomic submission

**Guarantees:**
- Idempotent on server side (server использует `itemId + sessionId` для dedup)
- Out-of-order tolerable (item updates idempotent; server применяет последний)
- Visible queue state (banner "5 items syncing..." когда есть pending)

### 4.2 Autosave model

- Reducer-driven (no manual save buttons)
- Debounced flush к AsyncStorage каждые **1 секунду** после touch
- Hard flush perfomed:
  - При section transition (next/prev)
  - При app background event
  - При выход в [H] draft preview

### 4.3 Media model

```
photo capture
   │
   ▼
expo-camera ──► File URI (local)
   │
   ▼
linked to: { itemId, sectionId, sessionId }
local cache: <appDocsDir>/<sessionId>/<photoId>.jpg
size: max 2400px long edge (downsized inline)
sync queue: chunked base64 upload to /api/inspector/jobs/:id/media

after sync:
   server media.id added to item.photoIds
   local URI retained until session submitted (for re-display)
```

Видео: HEVC, max 60s, max 720p. Voice: AAC, 15s cap.

### 4.4 Resume model

App cold-start:
1. Read `inspection_session_<jobId>` from AsyncStorage
2. If exists and `status === 'inspecting'`:
    - jump straight to [F] runtime entry
    - banner: "Возобновлено · последнее действие 14 мин назад"
3. Hydrate sync queue and start dispatcher
4. Background-fetch server state (для merge: server is источник истины для
   lifecycle, local — для in-flight content)

---

## 5. Section Graph (15 sections — обязательность и порядок)

Ranked по execution sequence что обычно делает inspector (см. также
backend `checklist.py::GROUPS`):

| # | Section | Required | Recommended order rationale |
|---|---|---|---|
| 1 | Documents | yes | Делается first — пока seller рядом |
| 2 | Body & paint | yes | Цвет/перекрас лучше на дневном свете |
| 3 | Glass | yes | Связан с body осмотром |
| 4 | Lights | yes | Связан с body, требует включения зажигания |
| 5 | Tyres | yes | Связан с подвеской, до подъёма |
| 6 | Interior | yes | До enginer start чтобы услышать тишину |
| 7 | Electronics | yes | Тестируется при ignition on |
| 8 | A/C & climate | yes | Тестируется при engine on (warm + cool) |
| 9 | Engine | yes | Cold start observation crítico |
| 10 | Transmission | yes | После warm-up |
| 11 | Brakes | yes | Visible если поднять, otherwise test-drive only |
| 12 | Suspension | yes | Часть test-drive |
| 13 | Test drive | yes | Combined transmission/brakes/suspension dynamic |
| 14 | Environment & history | yes | По итогам осмотра + документов |
| 15 | Final media | yes | Walkaround video + VIN photo + dashboard photo |

**Optional sections (none in v1).** Recommendation: всё required, потому
что иначе teaser-reports теряют trust value.

**Skip discipline:**
- Critical items (VIN photo, walkaround video) — нельзя skip ever.
- Conditional skip: если car cold не запустился → engine section skipped с reason `engine_cold_failure_to_start`. Это **finding**, не skip.

---

## 6. Evidence Model

Every checklist item produces an **evidence triple**:
```
(observation, severity, media[])
```

Where:
- `observation` = structured numeric/boolean/enum result
- `severity` = ok | warning | critical | not_applicable | not_checked
- `media[]` = list of photo/video/voice IDs tied to this item

**Required-evidence enforcement** (item-template level):
- VIN match → `photo_required: 1`
- Paint depth on body items → `photo_required: 1` если severity ≥ warning
- Walkaround section → `video_required: 1`
- Engine bay → `photo_required: 1`

**Why this matters:** report = emergent. Если evidence не привязано к
конкретному item, восстановить причинно-следственную связь невозможно ни
для QA, ни для disputes.

---

## 7. Completion Logic (когда session готов к submit)

```python
def can_submit(session):
    # All required sections complete or explicitly skipped
    for sec in REQUIRED_SECTIONS:
        if not section_complete(sec, session):
            return False, f"section_incomplete: {sec}"
    
    # Per-item required evidence
    for item in session.items:
        if item.template.photo_required and not has_photo(item):
            return False, f"missing_photo: {item.key}"
        if item.template.video_required and not has_video(item):
            return False, f"missing_video: {item.key}"
    
    # Hard global rules
    if not session.walkaround_video_id:
        return False, "missing_walkaround_video"
    if not session.vin_photo_id:
        return False, "missing_vin_photo"
    
    # Inspector confirmed final verdict (can be computed-agreed OR override)
    if not session.inspector_verdict:
        return False, "missing_final_verdict"
    
    return True, None
```

This function lives **both** in mobile (для UI gating) and backend (для
double-check at `/report` submit). They must use the **same shared
domain** module (`@platform/domain/inspection/completion`) — same
discipline as `projectVehicleTimeline` already does для memory.

---

## 8. Backend obligations (downstream of UI map)

> Эти изменения произойдут **после** того как UI выше будет prototype'd
> и протестирован на 1-2 реальных inspections (или их подобии в
> staging). Не вперёд.

### 8.1 New collections / fields

| Collection | Field(s) | Purpose |
|---|---|---|
| `inspection_jobs` | `runtime: { sessionStartedAt, currentSectionIdx, completionPct, walkaroundVideoId, vinPhotoId }` | Session runtime metadata |
| `inspection_jobs` | `arrival: { gpsLat, gpsLng, vinScan?, arrivedAt }` | Field arrival evidence |
| `inspection_media` | `itemKey: str, sectionKey: str` (added) | Tie media to source item |
| `inspection_media` | `voice: { duration_s }` (optional sub-doc) | Voice notes |
| **NEW** `inspection_sections_state` | `{ sessionId, sectionKey, status, completedAt?, skippedReason? }` | Per-section state — для resume + analytics |
| **NEW** `inspection_item_results` | `{ sessionId, itemKey, sectionKey, numericValue?, severity, note?, photoIds, voiceId?, updatedAt }` | Atomic per-item results (вместо `checklist[]` в report). Report при submit derived из этого. |

### 8.2 New endpoints

| Method + path | Body | Purpose |
|---|---|---|
| `POST /api/inspector/jobs/:id/arrival` | `{gpsLat, gpsLng, vinScan?}` | Arrival evidence persistence |
| `PATCH /api/inspector/jobs/:id/items/:itemKey` | `{numericValue?, severity, note?, photoIds, voiceId?}` | Atomic item update (replaces giant `report.checklist[]`) |
| `POST /api/inspector/jobs/:id/sections/:sectionKey/skip` | `{reason}` | Section skip with audit |
| `POST /api/inspector/jobs/:id/media` (existing — extend) | + `itemKey` + `sectionKey` | Media tied to source |
| `GET /api/inspector/jobs/:id/draft` | — | Compute draft + verdict + findings on demand (server canonical) |
| `POST /api/inspector/jobs/:id/report` (existing — repurpose) | `{inspectorVerdict, inspectorSummary?}` | Final submit — server **derives** checklist/findings/score from stored items + verifies `can_submit()` |

### 8.3 Reused as-is

- Lifecycle endpoints (`/claim`, `/on-route`, `/arrived`, `/start-inspection`, `/cancel`) — без изменений
- `checklist.CHECKLIST` остаётся single source of truth для template
- Credit consume — без изменений (на report submit)
- Memory append (Slice 1) — без изменений

---

## 9. Out of scope (not v2)

Чтобы не размазать scope. Эти вещи **не** появляются в Runtime v2:

- ❌ Inspector quality score / reputation — это analytics layer, Slice 3+
- ❌ Auto-translation reports — кастомер-side feature
- ❌ Real-time customer "Inspector is on section 4" — distraction для inspector
- ❌ Inspector partner reviews / collaboration — отдельный flow
- ❌ Voice-to-text для notes — STT добавляется позже
- ❌ AI photo analysis — отдельный layer
- ❌ Section template versioning — Slice 4
- ❌ Customer dispute interface — Slice 3+

---

## 10. Build order (recommended sequence)

> Каждый шаг видим в UI до того как трогаем backend. Принцип сохранён.

| Step | Surface | Backend obligation |
|---|---|---|
| **R1** | Replace `report.tsx` с [F] runtime entry stub + [G] section runtime (1 section first — `body_paint`, как proof-of-concept) | None — пока всё через existing `POST /report` в конце |
| **R2** | Add autosave + local persistence layer (AsyncStorage based) | None — local-only |
| **R3** | Add inline `expo-camera` для item-bound photos | Extend `/media` endpoint with `itemKey/sectionKey` |
| **R4** | Roll out оставшиеся 14 sections (using same [G] template) | Extend `checklist.GROUPS` если что-то отсутствует |
| **R5** | Build [H] draft preview с computed verdict | Add `GET /jobs/:id/draft` server-side computation |
| **R6** | [D] arrival workspace с GPS + VIN scan | Add `POST /arrival` endpoint |
| **R7** | Sync queue dispatcher + offline online detection | Atomic `PATCH /items/:itemKey` endpoint (idempotent) |
| **R8** | Resume model + cold-start hydration | None — purely client |
| **R9** | Switch final submit от giant payload к server-derived (server compiles report из items) | Repurpose `POST /report` payload to `{inspectorVerdict, inspectorSummary?}` only |

**R1-R3 = MVP runtime** — этого достаточно, чтобы real inspector мог
провести inspection с item-bound photos и autosave. Всё остальное —
optimization on top.
