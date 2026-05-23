# customer-grammar — trust grammar layer (NOT product i18n)

**Date:** 2026-05-14
**Sprint:** Customer-Loc-1
**Status:** narrative locales DE / EN / RU + lexicon firewall test

---

## What this module is

A **language firewall**, not a translation system.

The customer-facing surfaces (`continuity.tsx`, `timeline.tsx`,
`report-cognition.tsx`) speak in a **narrative grammar** that is
structurally different from the inspector workflow grammar or the
admin forensic grammar.

This module exists so that grammar stays:

- **explicit** — every customer-visible phrase is in a curated table,
  not generated from event payloads.
- **bounded** — adding a locale = copying the table shape, not
  inventing translation keys.
- **provable** — `node scripts/check-customer-lexicon.mjs` asserts no
  forbidden token leaked into any locale.

If a string needs to appear on a customer screen, it goes into this
module. If a string belongs to product chrome (tabs, profile, search…)
it stays in `src/i18n/locales/*.json` as before.

---

## Architecture (intentional)

```
eventType
  → projection key (in surface)
    → copy table (here, per-locale)
      → rendered narrative

NOT:

eventType
  → inline translated prose
```

Projection remains **canonical**. Language becomes **replaceable**.
Forbidden-lexicon validation is **automated per locale**.

---

## Files

```
customer-grammar/
├── copy/
│   ├── en.json                 # Curated copy table — English
│   ├── de.json                 # Curated copy table — German
│   └── ru.json                 # Curated copy table — Russian
├── forbidden-lexicon.json      # Per-locale forbidden words + universal tokens
├── types.ts                    # CustomerLang / EventCopyKey / UICopyKey types
├── narrative.ts                # getCopy() / getEventCopy() — surface API
└── README.md                   # this file
```

```
scripts/
└── check-customer-lexicon.mjs  # Pure-node test runner (no deps)
```

---

## Adding a locale

1. Copy `copy/en.json` → `copy/<lang>.json`.
2. Translate every value, **keep keys verbatim**.
3. Add the locale's forbidden translations to `forbidden-lexicon.json`
   under `perLocale.<lang>`.
4. Register the locale in `narrative.ts` `TABLES` map.
5. Run `node scripts/check-customer-lexicon.mjs` — must report
   `OK: 0 violations`.

The test will FAIL the build (via exit code) on any leak.

---

## What this module deliberately does NOT do

- **No `t('namespace.key')` calls from surfaces.** Surfaces call
  `getCopy(lang)` once and read fields directly.
- **No interpolation engine.** The only placeholder is `{{date}}` in
  `common.lastRead` / `cognition.lastInterpreted`, resolved by a
  trivial `.replace()`. No nested keys, no pluralization, no genders.
- **No reuse with the inspector or admin surfaces.** Those surfaces
  have different grammars by design. Cross-surface reuse would
  collapse the firewall.
- **No backend section titles.** `report-cognition.tsx` renders
  `sections[].title` and `sections[].body` *verbatim* from the
  backend mapper — that text is owned by the cognition pipeline, not
  by this module.
