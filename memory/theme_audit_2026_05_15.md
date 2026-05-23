# Theme Audit — *Light token cleanup (2026-05-15)

> Follow-up to Workbench dark-mode fix. Audit + remediation of all
> screens that hardcoded `*Light` palette tokens, forcing them to
> render light regardless of the global `ThemeContext`.

---

## What was audited

`grep -rn "C\.bgLight\|C\.cardLight\|C\.textLight\|C\.subtextLight\|C\.borderLight\|C\.brandSoftLight" /app/frontend/app /app/frontend/src`

Result: **7 files** had hardcoded `*Light` tokens at module-level
`StyleSheet.create({...})` and inline JSX colour attributes.

| File | Issue |
|---|---|
| `app/provider/workbench.tsx` | Already fixed in prior sprint (Day 4 audit) |
| `app/customer/request/new.tsx` | Full screen forced light |
| `app/customer/request/[id]/establishment.tsx` | Full screen forced light |
| `app/customer/inspection/[jobId]/continuity.tsx` | Full screen forced light |
| `app/customer/inspection/[jobId]/report-cognition.tsx` | Full screen forced light |
| `app/customer/inspection/[jobId]/timeline.tsx` | Full screen forced light |
| `app/provider/earnings-clarity.tsx` | Full screen forced light + STATE_COLOR module-level |

---

## What was fixed

### Pattern applied (matches the workbench precedent)

For each file:

1. **Import update** — added
   ```ts
   import { useThemeContext } from '<rel>/src/context/ThemeContext';
   ```
   and added `useMemo` to the React import if missing.

2. **`StyleSheet.create({...})` → `makeStyles(isDark)` factory** —
   each `*Light` token inside the styles block was replaced with a
   theme-aware local:
   ```ts
   function makeStyles(isDark: boolean) {
     const bg        = isDark ? C.bgDark        : C.bgLight;
     const card      = isDark ? C.cardDark      : C.cardLight;
     const text      = isDark ? C.textDark      : C.textLight;
     const subtext   = isDark ? C.subtextDark   : C.subtextLight;
     const border    = isDark ? C.borderDark    : C.borderLight;
     const brandSoft = isDark ? C.brandSoftDark : C.brandSoftLight;
     return StyleSheet.create({ ...all styles use bg/card/text/... });
   }
   ```

3. **Main component hook injection**:
   ```ts
   export default function Screen() {
     const { isDark } = useThemeContext();
     const styles = useMemo(() => makeStyles(isDark), [isDark]);
     // ...
   }
   ```

4. **Inline JSX colours** (e.g. `<Ionicons color={C.textLight} />`,
   `placeholderTextColor={C.subtextLight}`) — replaced with the
   `isDark ? C.<X>Dark : C.<X>Light` ternary inside the main component
   scope.

5. **STATE_COLOR objects** (workbench + earnings-clarity) — converted
   from module-level `const` to `stateColors(isDark)` factory; main
   component memoises with `useMemo(() => stateColors(isDark), [isDark])`.

6. **Module-level fallback** — `const styles = makeStyles(false);` and
   (where applicable) `const STATE_COLOR = stateColors(false);` are
   exported at module scope so that **sub-components** (e.g. `Section`,
   `Field`, `CurrencyCard`, `EarningsRow`) that were defined outside
   the main component still compile. The main component shadows these
   fallbacks with the themed versions in its scope. Sub-components
   stay light-mode for now — see "Known deferral" below.

### Semantic colours stay theme-invariant

`C.brand`, `C.success`, `C.warning`, `C.error`, `C.onBrand` — these
encode intent (action / success / warning / error / contrast-on-brand),
not surface. They are identical in both palettes and are NOT swapped.

---

## Verified

- TypeScript transpiles cleanly on all 7 files (only pre-existing
  errors remain — `@platform/domain/contracts/*` path alias, JSON
  module resolution — none introduced by this audit).
- Visual check: both `provider/workbench` and `customer/request/new`
  render correctly in:
  - **Dark** (default): `bg #0A0E14`, `card #1A222D`, white text
  - **Light**: `bg #F6F7F9`, `card #FFFFFF`, near-black text
- Theme switch via `@auto_search:theme_mode` localStorage key flips
  instantly on next render (within the existing `useMemo` deps loop).

---

## Known deferral — sub-component parity

The following module-level sub-components (rendered outside the main
component scope) **still render in light only**:

| File | Sub-components |
|---|---|
| `customer/request/new.tsx` | `Section`, `Field` |
| `customer/request/[id]/establishment.tsx` | `Section` |
| `customer/inspection/[jobId]/continuity.tsx` | `Section` |
| `provider/earnings-clarity.tsx` | `CurrencyCard`, `EarningsRow` |

Why deferred: theming these requires either (a) moving the declaration
inside the main component body (closes over `styles`/`STATE_COLOR`),
or (b) adding `styles` + `STATE_COLOR` as props at every call site.
Both are mechanical but non-trivial; the **page chrome** (header,
sections, KPI tiles, primary buttons) is fully themed and that is what
the user perceives as "the page". The remaining sub-components are
internal content cards that inherit text colour from their themed
parent's `<Text>` cascade where possible.

A future sprint can address this by passing `styles` via a single
shared `ThemedStyles` prop or by moving declarations inline.

---

## Files touched

- **MOD** `app/provider/workbench.tsx` — STATE_COLOR converted to `stateColors(isDark)`; module fallback added
- **MOD** `app/customer/request/new.tsx`
- **MOD** `app/customer/request/[id]/establishment.tsx`
- **MOD** `app/customer/inspection/[jobId]/continuity.tsx`
- **MOD** `app/customer/inspection/[jobId]/report-cognition.tsx`
- **MOD** `app/customer/inspection/[jobId]/timeline.tsx`
- **MOD** `app/provider/earnings-clarity.tsx`
- **NEW** `memory/theme_audit_2026_05_15.md` (this file)

Helper scripts (kept under `/tmp/`, not committed):
- `themeify.py` — bulk transformation
- `themeify_fixup.py` — post-pass that adds fallbacks + STATE_COLOR rewrites
