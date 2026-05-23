# `/app/shared` — Behavioral Truth Layer

This directory holds the **single source of behavioral truth** shared
across all surfaces of the platform (Expo, Web, Admin).

## The one rule

> **No JSX. No React. No platform imports.**
> If `node` cannot execute it, it does not belong here.

If you are tempted to add a `*.tsx` file or import from `react`,
`react-native`, or `expo-*` — stop. That code belongs in the surface
that needs it, not here.

## What lives here

| Folder              | Purpose                                            |
|---------------------|----------------------------------------------------|
| `domain/contracts/` | API request/response types and entity shapes      |
| `domain/state-machines/` | Lifecycle of business entities (booking, …)   |
| `domain/identity/`  | `Account`, `Kind`, `Capability`, persona logic    |
| `domain/formatters/`| Currency, date, mileage, plate, VIN formatters    |

Future (added when consumers exist, not before):
`validators/`, `events/`, `permissions/`, `api-client/`.

## How surfaces consume this

Every surface adds the alias `@platform/*` → `/app/shared/*` in its
tsconfig and bundler config. Imports look like:

```ts
import { canCancel, statusLabel } from '@platform/domain/state-machines/booking';
import type { Booking } from '@platform/domain/contracts/booking';
```

**Import from concrete file paths**, not from a barrel. If you need
to re-export, add an explicit named re-export — never `export *`.

## Source of truth conflict resolution

```
Backend  (state of record)   →  wins over Shared
Shared   (behavior rules)    →  wins over Surfaces
Surface  (presentation)      →  must adapt
```

When you see a divergence between Expo and Web — fix it in `shared/`,
then propagate. Never leave the divergence alive "for now".

## The boundary test

Before adding anything here, ask:

> *"Could this file run in `node` with `tsx` and a single MongoDB
> connection — without a browser, without React, without an emulator?"*

Yes → here. No → into the surface.

See [`/app/memory/architecture.md`](../memory/architecture.md) for the
full anchor document.
