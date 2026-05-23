# Sprint Customer-Loc-1 — narrative localisation (DE / EN / RU)

**Date:** 2026-05-14
**Surface:** customer
**Scope:** `continuity.tsx`, `timeline.tsx`, `report-cognition.tsx`
**Status:** **Shipped**

---

## Architectural choice

This is **NOT a product-i18n sprint.** It is a **trust-grammar layer**
sprint. Decision:

```
eventType
  → projection key (in surface)
    → curated locale copy table (here, isolated)
      → rendered narrative
```

Customer-visible strings live in their own module
(`src/customer-grammar/`) — **not** in the global `src/i18n/locales/*.json`.
That isolation is the firewall, not an accident.

Rationale (from sprint brief):

> для customer surface я бы НЕ использовал обычный "product i18n style".
> Лучше держать tiny curated copy tables, explicit allowed phrases,
> locale-level lexicon tests.
> Потому что у вас это не просто translation layer — это trust grammar layer.

Cross-surface reuse with inspector / admin grammars is explicitly
forbidden — those surfaces have different epistemic vocabularies by
design.

---

## What shipped

### 1. Customer-grammar module

```
src/customer-grammar/
├── copy/
│   ├── en.json                 # 36 ui + 12 event entries
│   ├── de.json                 # 36 ui + 12 event entries
│   └── ru.json                 # 36 ui + 12 event entries
├── forbidden-lexicon.json      # 19 universal + (17|17|18) per-locale tokens
├── types.ts                    # UICopyKey | EventCopyKey | CustomerCopyTable
├── narrative.ts                # getCopy / getEventCopy / fillDate
└── README.md
```

**Total customer-visible strings: 180** (60 per locale × 3 locales).
Every string is in exactly one curated table — no `t('namespace.key')`
machinery, no nested keys, no pluralization, no genders. Single
template primitive: `{{date}}` resolved by `.replace()`.

### 2. Lexicon firewall test

```
scripts/check-customer-lexicon.mjs
```

Pure-node script (no TS runtime, no yarn deps). Walks all 180 strings,
checks each against the universal forbidden tokens **plus** the
per-locale forbidden words. Word-boundary matching is Cyrillic-safe
and umlaut-safe.

**Current run:**
```
[lexicon] OK — locales=[en,de,ru], strings=180, checks=6600, violations=0
exit=0
```

CI hook: any merge introducing a forbidden token in any locale fails
the build via exit code 1.

### 3. Surfaces rewired

All three customer surfaces now read from the customer-grammar
tables via `getCopy(i18n.language).ui` (reactive — re-renders when
the user switches language).

| Surface              | Strings replaced | Symbol used                                |
|----------------------|------------------|---------------------------------------------|
| `timeline.tsx`       | 12               | `copy['timeline.*']`, `getEventCopy(...)`   |
| `continuity.tsx`     | 14               | `copy['continuity.*']`, `MATURITY_KEY`      |
| `report-cognition.tsx` | 10             | `copy['cognition.*']`                       |

Event-stream allowlist (timeline) now lives in
`copy/<lang>.json#events` — projection is canonical, language
replaceable. New media subtypes still fall through `media.uploaded.*`
without leaking.

Backend-owned strings (section titles + bodies from
`report-cognition` mapper, free-form `continuity` events) are still
rendered **verbatim** — that text belongs to the cognition pipeline,
not to this module.

---

## Live verification

```
locale  url path                                         rendered top of page
------  -----------------------------------------------  --------------------------------------------------------
EN      /customer/inspection/.../timeline                Back / INSPECTION / Process history / Refresh / Current state / Report
DE      /customer/inspection/.../timeline                Zurück / INSPEKTION / Verlauf der Prüfung / Aktualisieren / Aktueller Stand / Bericht
RU      /customer/inspection/.../timeline                Назад / ОСМОТР / Ход проверки / Обновить / Текущее состояние / Отчёт
RU      /customer/inspection/.../continuity              Назад / ОСМОТР / Непрерывность / Обновить
```

Empty-state lines also localized:
- EN: "No inspection history yet. Pull to refresh once the inspector starts."
- DE: "Noch kein Verlauf. Ziehen Sie nach unten, sobald der Inspektor beginnt."
- RU: "Истории пока нет. Потяните вниз, как только инспектор начнёт."

---

## Forbidden lexicon — what's locked

### Universal (19 tokens, blocked in all locales)
`AI · OCR · hash · sha256 · override · overridden · suspicion ·
suspicious · suspect · algorithm · algo · percent · flagged · flag ·
draft · drafted · confidence · probability · accuracy`

### EN (17 tokens)
`score · rating · risk · safe · warning · critical · system · expert ·
guaranteed · queue · queued · vehicle-passed · safe-to-buy ·
expert-approved · green-light · red-flag · yellow-flag ·
recommended-purchase`

### DE (17 tokens)
`Score · Bewertung · Risiko · sicher · Warnung · kritisch · System ·
Experte · garantiert · KI · Algorithmus · Entwurf · Warteschlange ·
Verdacht · Genauigkeit · Prozent · markiert`

### RU (18 tokens)
`балл · оценка · рейтинг · риск · безопас · предупрежд · критич ·
система · эксперт · гарантиров · ИИ · алгоритм · черновик · очередь ·
подозрен · точность · процент · помечен`

---

## What this sprint deliberately did NOT do

- **No reuse of `src/i18n/locales/*.json`** for any customer narrative
  string. Those files remain for product-chrome strings (tabs,
  profile, search) — different epistemic surface, different rules.
- **No deep keys, no pluralization, no gender, no namespacing.** The
  copy tables are flat dictionaries of *finite curated phrases*.
  Adding a phrase is an explicit, surveyable act.
- **No backend changes.** The forensic event stream still emits
  operational vocabulary. The customer surface's projection is what
  performs the firewall — backend doesn't know there's a customer.
- **No translation of backend-owned text** (cognition section bodies,
  continuity event titles). That ownership boundary is preserved.

---

## Files touched (5 new, 3 edited)

**New:**
- `src/customer-grammar/README.md`
- `src/customer-grammar/types.ts`
- `src/customer-grammar/narrative.ts`
- `src/customer-grammar/forbidden-lexicon.json`
- `src/customer-grammar/copy/{en,de,ru}.json` (3 files)
- `scripts/check-customer-lexicon.mjs`

**Edited:**
- `app/customer/inspection/[jobId]/timeline.tsx`
- `app/customer/inspection/[jobId]/continuity.tsx`
- `app/customer/inspection/[jobId]/report-cognition.tsx`

No other files touched. Metro re-bundles cleanly (1212 modules).
TypeScript compiles clean (`tsc --noEmit` on all 5 files: zero errors).

---

## Next sprint setup

With locale isolation in place, `Customer-Web-1` (port of the same
three surfaces to `/app/web-app/`) becomes a near-mechanical
transposition:

- Same projection tables → import from this module directly (it has
  zero React-Native dependencies — pure data + pure TS helpers).
- Same lexicon firewall test passes there too (it's pure node, runs
  regardless of surface).
- Only container/layout differs.
