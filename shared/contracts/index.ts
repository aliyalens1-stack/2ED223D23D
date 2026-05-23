/**
 * @platform/contracts — Single Source of Truth for HTTP API paths.
 *
 * Cross-surface canonical catalogue. Replaces the three byte-identical
 * `src/shared/api-contracts.ts` copies that lived in admin/, frontend/,
 * web-app/ before P2 (Contract Normalization, 2026-02-22).
 *
 * RULES
 *   • Never hardcode URL strings in pages or services — import from here.
 *   • Dynamic segments → functions: `byId: (id) => \`/resource/${id}\``.
 *   • Adding/changing a backend route requires updating the catalogue in
 *     the same PR.
 *   • Smoke verification: `/app/ops/smoke-api-contracts.sh` must pass.
 *
 * STRUCTURE
 *   Domain-split files (auth, customer, provider, marketplace, admin,
 *   engine, realtime) compose the legacy-shape `API` object that
 *   surface-level code already consumes. Backward-compatible.
 *
 * See /app/shared/contracts/DOCTRINE.md for the doctrine that frames
 * every decision in this file.
 */

import { AUTH } from './auth';
import { CUSTOMER } from './customer';
import { PROVIDER } from './provider';
import {
  MARKETPLACE,
  ORGANIZATIONS,
  SERVICES,
  MATCHING,
  SLOTS,
  EXPERIMENTS,
} from './marketplace';
import { ZONES, DEMAND, ORCHESTRATOR, FEEDBACK } from './engine';
import { ADMIN } from './admin';
import { REALTIME, SYSTEM, HEALTH } from './realtime';

export { AUTH, CUSTOMER, PROVIDER };
export {
  MARKETPLACE,
  ORGANIZATIONS,
  SERVICES,
  MATCHING,
  SLOTS,
  EXPERIMENTS,
};
export { ZONES, DEMAND, ORCHESTRATOR, FEEDBACK };
export { ADMIN };
export { REALTIME, SYSTEM, HEALTH };

/**
 * Legacy-shape catalogue (backward-compat with the pre-P2
 * `api-contracts.ts` shape). Existing surface code imports `API` and
 * keeps working with no migration.
 *
 * New code should prefer the namespaced exports above
 * (`AUTH.login`, `ADMIN.payments.list`, …) for better tree-shaking
 * and clearer domain ownership.
 */
export const API = {
  auth: AUTH,

  notifications:   CUSTOMER.notifications,
  favorites:       CUSTOMER.favorites,
  bookings:        CUSTOMER.bookings,
  quotes:          CUSTOMER.quotes,
  vehicles:        CUSTOMER.vehicles,
  garage:          CUSTOMER.garage,
  reviews:         CUSTOMER.reviews,
  disputes:        CUSTOMER.disputes,

  organizations:   ORGANIZATIONS,
  services:        SERVICES,
  marketplace:     MARKETPLACE,
  matching:        MATCHING,
  slots:           SLOTS,
  experiments:     EXPERIMENTS,

  provider:        {
    inbox:           PROVIDER.inbox,
    currentJob:      PROVIDER.currentJob,
    earnings:        PROVIDER.earnings,
    pressureSummary: PROVIDER.pressureSummary,
    availability:    PROVIDER.availability,
    presenceUpdate:  PROVIDER.presenceUpdate,
    intelligence:    PROVIDER.intelligence,
    opportunities:   PROVIDER.opportunities,
    billingProducts: PROVIDER.billingProducts,
    billingCheckout: PROVIDER.billingCheckout,
  },

  zones:           ZONES,
  demand:          DEMAND,
  orchestrator:    ORCHESTRATOR,
  feedback:        FEEDBACK,

  admin:           {
    /**
     * Legacy flat shape — kept for the small set of mobile/admin call-sites
     * that still consume `API.admin.X`. Only fields whose backend route is
     * mounted in /openapi.json are exposed. Retired fields (see
     * /app/shared/contracts/RETIRED_P2_2026_02_22.md) are intentionally
     * absent — referencing them yields a TypeScript error, surfacing dead
     * call-sites at compile time.
     */
    dashboard:        ADMIN.dashboard,
    liveFeed:         ADMIN.liveFeed,
    alerts:           ADMIN.alerts,
    governance:       ADMIN.governance.score,
    commissionTiers:  ADMIN.config.commissionTiers,
    automation:       ADMIN.automation.dashboard,
    automationReplay: ADMIN.automation.replay,
  },

  realtime:        REALTIME,
  system:          SYSTEM,
  health:          HEALTH,
} as const;

export type ApiCatalogue = typeof API;
export default API;
