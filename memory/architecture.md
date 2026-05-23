# Architecture Anchor — Multi-Surface Operational Platform

**Status:** living document. Update when a law changes, not when an
implementation changes. Keep concise.

---

## A. Surface philosophy — what each surface is for

| Surface  | Question it answers          | Mode                                   |
|----------|------------------------------|----------------------------------------|
| Expo     | "What do I do *right now*?"  | execution · realtime · on-the-go       |
| Web      | "How do I *deeply work*?"    | operations · multi-pane · documents    |
| Admin    | "How do I *run the system*?" | governance · automation · ops          |
| Backend  | "What is *true*?"            | persistence · authority · state of record |
| Shared   | "How does the *domain behave*?" | behavioral truth · framework-free    |

If a screen answers a different question than its surface — it is on the
wrong surface.

---

## B. Shared boundary law — the one rule

> **No JSX. No React. No platform imports.** If `node /tmp/foo.js` cannot
> execute it, it does not belong in `/app/shared/`.

Concretely banned in `shared/`:
- `react`, `react-native`, `react-dom`, `react-router-*`
- `expo*`, `@expo/*`
- DOM globals (`window`, `document`, `localStorage`)
- Native modules (`AsyncStorage`, `expo-*`)
- Any JSX file (`*.tsx` is not allowed in `shared/`)

Allowed in `shared/`:
- Plain TypeScript (`*.ts` only)
- `zod` (validators)
- `date-fns` (formatters)
- Pure type imports from `axios` (typing only — instances live per-surface)

---

## C. Truth hierarchy

```
Backend           →  persistence truth     (state of record)
Shared domain     →  behavioral truth      (how state evolves)
Surface           →  presentation truth    (how state is shown)
```

Backend remains the source of record. Shared owns the **rules**: state
transitions, permissions, validation, formatters, contracts. Surfaces
own only rendering, navigation, and platform UX.

When two surfaces disagree on behavior — **shared wins**, both surfaces
adapt. When shared and backend disagree — **backend wins**, shared
adapts. That is the conflict resolution order.

---

## D. Domain ownership — what shared owns

| Module                          | Owns                                              |
|---------------------------------|---------------------------------------------------|
| `shared/domain/contracts/`      | Request/response types, IDs, enums                |
| `shared/domain/state-machines/` | Lifecycle of business entities (booking, quote, …)|
| `shared/domain/identity/`       | `Account`, `Kind`, `Capability`, persona-switch   |
| `shared/domain/formatters/`     | Currency, date, mileage, plate, VIN               |
| `shared/domain/validators/`     | Zod schemas, URL parsers (mobile.de etc.)         |
| `shared/domain/events/`         | Event taxonomy + reducer (added in 0B)            |
| `shared/domain/permissions/`    | `canDoX(action, account)` predicates              |
| `shared/domain/api-client/`     | Typed HTTP resource wrappers (added in 0B)        |

---

## E. Surface ownership — what each surface owns

| Surface | Owns                                                       |
|---------|------------------------------------------------------------|
| Expo    | `View/Text/TouchableOpacity` components, `app/` routes, RN gestures, native sensors, push registration, mobile layouts |
| Web     | `div/span/button` components, react-router routes, dense layouts, document viewers, multi-pane shells |
| Admin   | Same as Web + governance widgets, automation control panels, audit trails |

---

## F. Anti-goals — explicitly out of scope

These have been considered and **deliberately rejected**:

1. **No shared UI kit.** Forcing a unified component layer kills
   desktop-native UX and produces lowest-common-denominator components.
   `react-native-web` for web-app is rejected for the same reason.
2. **No state-machine framework.** No `xstate`, no `createMachine`, no
   transition graphs. Each entity gets a plain `*.ts` file with explicit
   functions. Boring beats clever.
3. **No npm workspaces / turborepo / packaging infrastructure.** Until
   we have 5–10 stable shared modules with real consumers, packaging is
   premature. We ship via tsconfig path aliases + bundler aliases. Zero
   build pipeline.
4. **No shared lint/test runner.** Each surface keeps its own. Shared
   gets type-checked transitively when surfaces compile.
5. **No re-export barrels at module level.** Import from concrete file
   paths (`@platform/domain/state-machines/booking`), not from
   `@platform/domain`. Barrels create circular import traps and obscure
   ownership.
6. **No "abstract base" types or generic factories.** When a second
   entity needs the same shape as the first — copy, don't abstract.
   Premature abstraction is the root of all platform debt.

---

## G. Boundary test — the one-line check

Before adding a file to `shared/`, ask:

> *"Could I run this file in `node` with `tsx` and a single MongoDB
> connection, without a browser, without React, without an emulator?"*

If yes → it goes in shared.
If no → it goes in the surface that needs it.

---

## H. File-system layout

```
/app/
├── shared/                       ← single source of behavioral truth
│   ├── domain/
│   │   ├── contracts/
│   │   ├── state-machines/
│   │   ├── identity/
│   │   ├── formatters/
│   │   └── (validators, events, permissions, api-client — added later)
│   ├── tsconfig.json             ← strict, ES2020, no DOM lib
│   └── README.md                 ← boundary law reminder
├── backend/                      ← FastAPI + MongoDB (state of record)
├── frontend/                     ← Expo (execution surface)
├── web-app/                      ← Vite/React (operations surface)
└── admin/                        ← Vite/React (governance surface)
```

Path alias `@platform/*` resolves to `/app/shared/*` in every surface.

---

## I. Migration discipline

When migrating an existing piece of logic into `shared/`:

1. Find the **divergent implementations** across surfaces (if only one
   surface has it — it's not yet shared-worthy).
2. Pick the **most accurate** implementation as the seed (usually the
   backend's behavior is the reference).
3. Write the shared module **first**, with at minimum one example call
   in a comment.
4. Migrate **one surface** to consume it. Do not try to migrate all
   surfaces in one pass.
5. Delete the surface-local copy only after the new code is exercised
   in production at least once.

---

## K. Hard law — shared cannot become a "smart layer"

Banned in `/app/shared/`, enforced at review:

- **Dependency injection** — no `container.resolve(...)`, no IoC.
- **Registries** — no `registerEntity('booking', ...)`. Each domain is
  imported by name from its concrete file path.
- **Plugin systems** — no `extendMachine(...)`, no `pluginHooks`.
- **Runtime decorators** — no `@stateful class …`, no metadata tricks.
- **Auto-generated transitions** — no `buildGraphFrom(schema)`. State
  machines are written by hand, every transition is a literal in the
  source.
- **`Proxy` / `Reflect.metadata`** — never. The behavior of a function
  must be fully visible from its source code without a runtime trace.
- **Dynamic imports of domain code** — `await import('./booking')` is
  banned. Static imports only.
- **Generic abstractions for "future entities"** — no `BaseEntity`,
  `AbstractWorkflow`, `MachineFactory`, `EntityRegistry`. When a
  second entity needs the same shape, **copy** the explicit version,
  do not abstract.

Why: every "smart" mechanism in shared replaces explicit domain code
with implicit runtime code. Implicit code is not greppable, not
debuggable in CI, and not safely refactorable when the team grows.
Shared exists to make domain truth **visible**. Abstractions hide it.

If you find yourself thinking "this would be cleaner with a small
factory" — stop. Write it explicitly. The repetition is the feature,
not the bug.

---

## J. What `0A` (this sprint) delivers

1. This document.
2. `/app/shared/domain/{contracts,state-machines,identity,formatters}/`
   skeleton — one real file per directory, no stubs.
3. `state-machines/booking.ts` — first migration, fully usable.
4. tsconfig path aliases in Expo and web-app.
5. Bundler aliases (Metro `resolver.extraNodeModules`, Vite
   `resolve.alias`).
6. **One real consumer:** `web-app/.../BookingDetailPage.tsx` reads
   labels and capability flags from `@platform/domain/state-machines/booking`.

What `0A` does **not** deliver: events, api-client, permissions module,
admin migration, Expo migration of the same machine. Those are 0B/0C.
