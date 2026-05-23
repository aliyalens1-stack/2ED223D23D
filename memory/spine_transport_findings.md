# Spine Transport Findings

> Read-only audit. Output of step β before identity quarantine starts.
> Goal: confirm there is exactly **one** canonical import prefix for `/app/shared/domain/` across all surfaces, and identify any drift before it can spread.

Date: 2026-05-09
Companion to: `/app/memory/spine_adoption_map.md`, `/app/memory/identity_quarantine_plan.md`
Method: read tsconfig / bundler config / actual import statements / live `tsc --noEmit` for each surface.

---

## 1. Headline

**The canonical prefix is already chosen: `@platform/*` → `/app/shared/*`.**

It is fully wired in 2 of 3 client surfaces. Adoption is **not blocked by missing infrastructure** — it is blocked by 1 surface (admin) and 1 backend (NestJS) that never received the alias.

> **Do not invent a new prefix.** The mechanism exists. The work is parity, not design.

---

## 2. The transport matrix

| Surface | tsconfig path alias | Bundler resolver | `@platform/*` import works today? | Importer count |
|---|---|---|:-:|:-:|
| **Expo (frontend)** | `"@platform/*": ["../shared/*"]` ✅ | Metro: `extraNodeModules['@platform']` + `watchFolders` ✅ | ✅ confirmed by live `tsc` + spine importers | 5 files |
| **Web-app** | `"@platform/*": ["../shared/*"]` ✅ | Vite: `resolve.alias['@platform']` + `server.fs.allow: ['..']` ✅ | ✅ confirmed by live `tsc` + spine importers | 9 files |
| **Admin** | ❌ — only `@/*` → `src/*` (in `jsconfig.json`) | Vite: no `resolve.alias` block at all. craco.config.js: webpack alias only `@` → `src` | ❌ — `@platform/*` does not resolve | 0 files |
| **NestJS (backend/src)** | ❌ — only `@/*` → `src/*` | n/a (uses `tsc` directly) | ❌ — `@platform/*` does not resolve | 0 files |
| **FastAPI (backend/app)** | n/a — Python | n/a | n/a — Python cannot import TypeScript | "0 files" (see § 5) |

Existing importers spell the path consistently as `@platform/domain/...`:

```
frontend/app/provider/workbench.tsx         from '@platform/domain/contracts/provider-work-item'
frontend/app/provider/earnings-clarity.tsx  from '@platform/domain/contracts/provider-earnings-item'
web-app/src/main.tsx                        from '@platform/domain'
web-app/src/pages/inspector/InspectorWorkspace.tsx
                                            from '@platform/domain/contracts/inspection-job'
…
```

**No drift.** Every existing importer uses the same prefix. There is no `@shared/`, no `@app/shared/`, no relative `../shared/...` import in production code.

---

## 3. Where the mechanism lives (per-surface, today)

### 3.1 Expo (`/app/frontend`)
- `tsconfig.json` extends `expo/tsconfig.base`, declares `"@platform/*": ["../shared/*"]`, includes `../shared/**/*.ts` in compilation graph.
- `metro.config.js` block:
  ```js
  config.watchFolders = [...(config.watchFolders || []), sharedRoot];
  config.resolver.extraNodeModules = { ...prev, '@platform': sharedRoot };
  ```
- Comment in metro.config.js: *"Phase 0A — multi-surface architecture: allow imports from /app/shared via the `@platform/*` alias."*
- Two layers (TypeScript path resolution + Metro module resolution) are wired separately and consistently.

### 3.2 Web-app (`/app/web-app`)
- `tsconfig.json` declares `"@platform/*": ["../shared/*"]`, includes `../shared/**/*.ts`.
- `vite.config.ts` block:
  ```ts
  resolve: { alias: { '@platform': path.resolve(__dirname, '..', 'shared') } },
  server: { fs: { allow: ['..'] } },
  ```
- Comment: *"Phase 0A — multi-surface architecture: shared behavioral truth lives at /app/shared (no JSX, no React). Imported as @platform/*."*
- Two layers (tsc + Vite) wired separately and consistently.

### 3.3 Shared package (`/app/shared`)
- `package.json`: `"name": "@platform/shared"`, `"private": true`. No build, no dist.
- `tsconfig.json` exists; `eslint.config.js` enforces "shared is a sink" (no React, no transport, no globals).
- No `index.ts` re-exports beyond `domain/index.ts`. Imports go directly to subpaths like `@platform/domain/contracts/*`, not to a single barrel — this is intentional and consistent with how identity importers spell it.

### 3.4 Admin (`/app/admin`) — gap
- `tsconfig.json`: no `paths` block at all. No `@platform`, no `@/*` either (the latter is in `jsconfig.json` only — there are TWO config files; `tsconfig.json` is the one Vite consults).
- `vite.config.ts`: no `resolve.alias` block at all. Default Vite resolution.
- `craco.config.js` is dead code — admin does not use CRA/craco at runtime, it uses Vite (`yarn build` runs `vite build`). craco.config.js is residue from an earlier scaffolding.
- Result: `@platform/*` does not resolve. 0 spine importers. Every adoption attempt today would fail at `vite build`.

### 3.5 NestJS (`/app/backend/src`) — gap
- `tsconfig.json` has `"paths": { "@/*": ["src/*"] }` only. No `@platform/*`.
- No `tsconfig-paths/register` in `main.ts`.
- Even if a `paths` entry were added, NestJS at runtime needs path mapping to be either resolved at compile time (e.g., `tsc-alias`) OR registered at startup (`tsconfig-paths/register`) — `paths` alone is a TypeScript-checker concept, not a Node.js runtime concept.
- For this quarantine: **TypeScript-level access to `@platform/*` is enough** (so ESLint and `tsc` see canonical types). Runtime resolution becomes a problem only when NestJS is enabled and actually executes those imports — and in that future moment, the fix is one line in `main.ts` or a `tsc-alias` build step.

### 3.6 FastAPI (`/app/backend/app`) — different category
- Python cannot import TypeScript files. Period.
- The 5 files previously reported as "spine importers" in `spine_adoption_map.md` § 4.1 actually reference the spine **only in docstrings and comments** ("mirror shared/domain/contracts/provider-work-item.ts"). They do not import or enforce.
- This is **shape-mirror parity**, not import adoption. It is voluntary and breakable.
- Out of scope for this transport plan. Bridging FastAPI to the spine requires either:
  - generating Python types from the TypeScript contracts (e.g., quicktype, json-schema bridge), or
  - inverting ownership so the contract source lives in a language-neutral schema (JSON Schema / Protobuf) with TypeScript and Python both consuming it.
- **This audit recommends accepting the asymmetry.** FastAPI continues with shape-mirror discipline; only TypeScript surfaces use `@platform/*` import. Identity quarantine does not need FastAPI to import the spine — the runtime wire format already enforces `kind` correctly (proven in spine_adoption_map.md §5.1).

---

## 4. Correction to spine_adoption_map.md

Audit revised the FastAPI count:

| Claim in spine_adoption_map.md | Corrected by this audit |
|---|---|
| "Files importing the spine: **13** (2.2%)" | **8** TypeScript files actually import via `@platform/*`. The 5 FastAPI files mirror by comment, not by import. |
| "Backend imports it" (✅ for `provider-work-item`, `provider-earnings-item`, `vehicle`) | downgraded to **comment-mirror only**. The runtime DTO matches the spine contract by discipline, not by enforcement. |

**Net effect on spine adoption:**
- TypeScript spine adoption: 8/~600 files (1.3%, not 2.2%).
- Cathedral domain (`provider-work-item`) remains canonical at the wire level — DTO does match the contract live (verified against `/api/provider/work-items` in §5.1 of the map). But the conformance is not type-checked at compile time on the producing side. It would survive a refactor only because of the comment + the consuming side's type assertion.

This does not change the conclusion of either prior document. It clarifies the cost of bringing FastAPI into the spine (high, blocked on cross-language schema) versus bringing admin and NestJS in (low, just paths + alias).

---

## 5. The two missing alias entries — exact diffs (read-only preview, NOT applied)

### 5.1 Admin

**`admin/tsconfig.json`** — add `paths`:
```json
{
  "compilerOptions": {
    ...,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@platform/*": ["../shared/*"]
    }
  },
  "include": ["src", "../shared/**/*.ts"]
}
```

**`admin/vite.config.ts`** — add `resolve.alias` + `server.fs.allow`:
```ts
import path from 'path';
…
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@platform': path.resolve(__dirname, '..', 'shared'),
    },
  },
  server: {
    fs: { allow: ['..'] },
    ...,
  },
  ...
});
```

These two changes mirror `web-app/`'s configuration verbatim. Same pattern, same prefix, same physical target.

### 5.2 NestJS

**`backend/tsconfig.json`** — add `paths` only (runtime registration deferred until NestJS is enabled):
```json
{
  "compilerOptions": {
    ...,
    "paths": {
      "@/*": ["src/*"],
      "@platform/*": ["../shared/*"]
    }
  },
  "include": ["src/**/*", "../shared/**/*.ts"]
}
```

This unblocks ESLint and `tsc` for NestJS controllers. Runtime resolution stays out of scope of step α — it becomes relevant only when (and if) NestJS subprocess is enabled.

### 5.3 No additional infrastructure needed

- No base tsconfig at `/app/`. The four `tsconfig.json` files stay independent — adding a base shared config is **not** in scope (would be a separate refactor and a separate guardrail discussion).
- No yarn workspaces / lerna / nx. Each surface keeps its own `node_modules`. The `@platform/*` alias resolves through the bundler, not through package linking — by design, since `shared/` has no published artifacts.
- No symlink. No `npm link`. Path alias is sufficient.

---

## 6. Guardrail violations the audit looked for and did NOT find

| Drift type | Search | Result |
|---|---|---|
| Alternative prefix `@app/shared/*` | `grep -r '@app/shared'` | 0 hits in production code |
| Alternative prefix `@shared/` | `grep -r '@shared/'` (excluding `node_modules`, `__pycache__`) | 0 hits |
| Relative imports `../shared/...` to bypass alias | `grep -r "'\.\./shared"` and `'\.\./\.\./shared'` | 0 hits in TypeScript source |
| Two-different-aliases-for-same-target | inspect each tsconfig + bundler config | None — all aligned on `@platform/*` |
| Module resolver mismatch (TS sees vs bundler sees) | live `tsc --noEmit` for each surface | TypeScript errors exist, but none of them are "module not found" for `@platform/*`. Confirms TS resolution. Bundler resolution confirmed by the running web-app and Expo, both of which build and load successfully. |

**No drift today.** This is the optimal moment to standardize the remaining 2 surfaces — before any team member adds a second prefix in admin or NestJS by accident.

---

## 7. Decision recorded

> **Canonical import prefix for `/app/shared/domain/`: `@platform/*`.**
>
> This is the only legal way for any TypeScript surface to import the spine. Any other prefix introduced in any surface (`@shared/`, `@app/shared/`, relative `../shared/`) is a doctrine violation and shall be added to ESLint `no-restricted-imports` in the same package as the identity quarantine rules (a fifth rule, scope kept tiny).

---

## 8. Step α — exact scope (when greenlit)

Three file edits, no logic changes:
1. `admin/tsconfig.json` — add `baseUrl`, `paths`, extend `include`.
2. `admin/vite.config.ts` — add `resolve.alias` block, add `server.fs.allow: ['..']`.
3. `backend/tsconfig.json` — add `@platform/*` to `paths` and `../shared/**/*.ts` to `include`.

**Verification after edit:**
- `cd admin && yarn build` succeeds.
- `cd admin && npx tsc --noEmit` produces no `Cannot find module '@platform/...'` errors (other pre-existing errors are out of scope).
- `cd backend && npx tsc --noEmit` produces no `Cannot find module '@platform/...'` errors.
- Add a single throwaway test import in admin `src/main.tsx` (`import type { AccountKind } from '@platform/domain/identity/account'`), verify `yarn build` succeeds, then revert.

**Out of scope of step α:**
- Adding `tsconfig-paths/register` to NestJS `main.ts`. NestJS is disabled. Runtime resolution is deferred.
- Migrating any current admin / NestJS code to use the alias. Step α only **enables** the alias; **using** it is the next ESLint quarantine step.
- Adding the fifth ESLint rule (`no-non-platform-shared-import`). That ships with §6 of the identity quarantine plan, not now.
- Touching FastAPI or generating Python types. Out of scope by design.

**Total file diff: 3 small edits. Zero behavioral change.**

---

## 9. What this audit does not propose

- It does not propose a base tsconfig.
- It does not propose yarn workspaces.
- It does not propose a published `@platform/shared` npm package.
- It does not propose a runtime resolver bridge for FastAPI.
- It does not propose changing any existing `@platform/*` import.
- It does not propose touching `craco.config.js` (dead code) or removing `admin/jsconfig.json` (harmless).

It only proposes: **bring the 2 missing surfaces to the same alias parity that the other 2 already have.**
