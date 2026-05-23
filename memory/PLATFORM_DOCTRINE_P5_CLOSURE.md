# PLATFORM DOCTRINE — P5 Closure & P6 Mandate

> **Status:** canonical · do not modify without explicit doctrinal revision
> **Дата фиксации:** 2026-05-22
> **Источник:** user formulation after P1→P5 closure
> **Цель документа:** institutional memory — что мы построили, что нам НЕЛЬЗЯ делать, и что такое P6.

---

## 1. Что мы есть после P1→P5

Платформа теперь — **substrate-complete operational platform**.

Не «MVP». Не «admin panel». Не «prototype».

А:

- **topology-stable**
- **contract-authoritative**
- **chronology-safe**
- **attribution-complete**
- **forensic-navigable**
- **reconciliation-capable governance substrate**

И главное — **без platform collapse**.

---

## 2. Пять одновременно закрытых слоёв (редкое сочетание)

| Layer | Что закрыто |
|---|---|
| **Topology** | `visible == operational` |
| **Contracts** | `catalogue == OpenAPI` |
| **Governance** | every domain has owner |
| **Evidence** | append-only chronology |
| **Accountability** | attribution everywhere |

Это уже **operational constitution**.

---

## 3. Архитектурный outcome

Система теперь умеет:

> **prove itself**

Это и есть рубеж.

---

## 4. Сдвиг до/после

| До P1 | После P5 |
|---|---|
| feature-heavy | evidence-first |
| route-heavy | causality-traceable |
| promise-heavy | operationally inspectable |
| truth-light | truth-anchored |

---

## 5. Самое сильное архитектурное решение всей серии

> **НЕ строить новый ledger.**

Это спасло архитектуру от:

- dual truth
- reconciliation hell
- shadow balances
- eventual consistency theatre
- endless replay engines

Вместо этого — усилили existing truth layers через chronology, attribution, reconciliation, navigation.

**Это был правильный путь.**

---

## 6. Реальная зрелость по слоям

| Layer | Maturity |
|---|---:|
| Topology | 100% |
| Contracts | 100% |
| Chronology | 98% |
| Governance | 95% |
| Attribution | 92–95% |
| Money correctness | 92–94% |
| Reconciliation | 90–92% |
| Provider UX | ~75–80% |
| Automation | **intentionally suspended** |

---

## 7. Оставшиеся asymmetry zones (это и есть P6)

### 7.1 Provider surface — главный remaining gap

- admin substrate — mature
- customer chronology — mature
- provider topology — normalized
- **provider UX** — пока **consumer-grade**, не **governance-grade**

### 7.2 Attribution saturation

P5 дал infrastructure. Не дал 100% mutation coverage.

Нужно подключить:
- disputes
- refunds
- freezes
- commissions
- moderation
- support actions

Только **mechanical wiring**. Без новых abstractions.

### 7.3 Scheduled reconciliation

Сейчас: **human-triggered persistence**.
Нужно: **platform-triggered evidence cadence**.

Это **не** automation. Это **institutional memory**.

---

## 8. P6 — symmetry completion

P6 — это **не** architecture phase. P6 — это:

1. **Provider parity** (поднять provider UX до governance-grade)
2. **Attribution saturation** (100% mutation coverage)
3. **Cadence persistence** (scheduled reconciliation snapshots)

---

## 9. Что теперь НЕЛЬЗЯ делать — premature intelligence ban

Запрещено до завершения P6:

- ❌ AI governance
- ❌ predictive enforcement
- ❌ autonomous moderation
- ❌ orchestration engines (новые)
- ❌ operator copilots
- ❌ automation rebirth

**Причина:** substrate ещё *operationally complete*, но **not institutionally saturated**.
Automation поверх partially attributable reality = опасно.

---

## 10. Финальная doctrine (identity statement)

> **The platform is not a set of screens.
> It is a causally navigable operational evidence system.**

Это уже не engineering note. Это **identity**.

---

## 11. Когда automation вернётся

**Только** после `P6 substrate saturation complete`. Иначе automation будет действовать на partially attributable reality — а это **опасно**.

---

## 12. Что получено как итог P1→P5

**Production-governable platform core.**

Foundation, на который можно:

- масштабировать команду
- сажать operators
- проходить forensic investigations
- строить real money governance
- добавлять intelligence **later** (после P6)

И главное — **без переписывания ядра**.

---

## 13. Гард для будущих агентов / разработчиков

Любая future PR / change должна проверяться против этих принципов:

- ☐ Не вводит **dual truth** или **shadow ledger**
- ☐ Не вводит **abstractions** там, где достаточно **mechanical wiring**
- ☐ Не пытается стартовать **automation** до завершения P6
- ☐ Все mutations имеют **attribution** (actor + reason + chronology event)
- ☐ Все money/trust/governance actions попадают в **append-only chronology**
- ☐ Provider parity не нарушается новыми consumer-grade features

Если PR нарушает хоть один пункт — это **doctrine violation**, требуется явный rationale + ревизия doctrine.

---

## 14. Связанные документы

- `PRODUCTION_READINESS.md` — operational runbook (Sprints 1–9)
- `AUDIT_E2_DEPLOY_2026_05_22_v2.md` — текущее состояние развёрнутого pod'а
- `memory/B4_3_A_*` — closure-docs Phase B / reconciliation hardening
- `memory/CHRONOLOGY_COVERAGE.md` — chronology surface
- `memory/I18N_MIGRATION_PROGRESS.md` — i18n parity track

---

**End of doctrine. Этот документ — anchor для всех последующих решений.**
