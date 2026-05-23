/**
 * P2 (2026-02-22): single-source-of-truth re-export.
 *
 * The canonical catalogue lives at /app/shared/contracts/. This file
 * exists only for backward-compat with surface-level imports of the
 * form `from '../shared/api-contracts'`. New code should prefer
 * `from '@platform/contracts'`.
 *
 * Do NOT add new path strings here. Add them under
 * /app/shared/contracts/{domain}.ts and the namespaced exports.
 */
export { API, default } from '@platform/contracts';
export type { ApiCatalogue } from '@platform/contracts';
export * from '@platform/contracts';
