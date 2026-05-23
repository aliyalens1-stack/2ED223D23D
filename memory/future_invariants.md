# Future Invariants — структурный долг, который мы НЕ делаем сейчас

Этот файл — не TODO. Это контракт о том, **во что система должна
эволюционировать**, когда появится UI use-case. До этого момента — не
делаем, чтобы не нарушать принцип «backend не опережает UI».

---

## 1. Approved inspection event = immutable snapshot

**Текущее поведение (Slice 1):**
`_append_vehicle_memory_on_approval()` использует `$pull + $push` для
event с тем же `evt_inspection_<reportId>`. Это идемпотентно в смысле
«не дублирует», но **mutable** — повторный approve с изменённым summary
перезапишет event в timeline.

**Целевой invariant:**
Первый approval создаёт **frozen snapshot** внутри activity event:
```jsonc
{
  "id": "evt_inspection_<reportId>",
  "type": "inspection_completed",
  "at": "<approval timestamp>",
  "reportSnapshot": {
    "verdict": "...",
    "score": 0,
    "summary": "...",
    "findings": [...],
    "approvedAt": "...",
    "inspectorId": "..."
  }
}
```
Повторные approvals (reapprove) **не трогают** activity[]. Если admin
изменил отчёт после approval — это **новый event** (`inspection_revised`)
или audit log, но не overwrite истории.

**Когда делать:** при появлении одного из:
- reapprove flow в admin UI (audit trail page)
- dispute system (нужен immutable proof что отчёт говорил X на момент Y)
- legal export PDF из vehicle timeline

**Что готовить пока ждём:** ничего. Это invisible infrastructure
hardening — без UI use-case будет structural protection ради protection.

---

## 2. Mobile activity translator = lossy

**Текущее поведение:**
`frontend/app/vehicles/[id].tsx::toVehicleDoc()` (line 115) проецирует
activity event с потерей:
```ts
activity: (raw.activity ?? []).map((a) => ({
  type: a.type, at: a.at, text: a.text ?? null,
})),
```
Поля `severity, score, verdict, reportId` я начал писать в backend, но
на mobile они **не доходят**. Web-app получает полный event, mobile —
урезанный.

**Целевой invariant:**
Mobile translator должен `pass-through` все поля activity event. Shared
projector (`projectVehicleTimeline`) сам решает что использовать; surface
не должен фильтровать payload.

**Когда делать:** при первом же touch этой области — если в Slice 2
shared projector начнёт раскрашивать timeline item по severity, надо
синхронно расширить translator. Не отдельным заходом — pre-flight check
в любом изменении timeline.
