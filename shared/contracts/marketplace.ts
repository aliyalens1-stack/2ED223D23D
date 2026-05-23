/**
 * Marketplace contracts — public catalogue + cross-actor matching.
 *
 * Canonical prefix: /marketplace
 * Adjacent: /organizations, /services, /matching, /slots, /experiments
 *   — these are non-bordered marketplace primitives that pre-date the
 *   /marketplace prefix. They remain mounted at root for compat.
 *
 * See /app/shared/contracts/DOCTRINE.md §2.
 */
export const MARKETPLACE = {
  // /marketplace/* canonical
  providers:       '/marketplace/providers',
  services:        '/marketplace/services',
  stats:           '/marketplace/stats',
  quickRequest:    '/marketplace/quick-request',
  createBooking:   '/marketplace/bookings',
  booking:         (id: string) => `/marketplace/bookings/${id}`,
  providerInbox:   '/marketplace/provider/inbox',
  providerStats:   '/marketplace/provider/stats',
  providerCurrent: '/marketplace/provider/current-job',
} as const;

export const ORGANIZATIONS = {
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // list:   '/organizations',
  search: '/organizations/search',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // byId:   (id: string) => `/organizations/${id}`,
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // bySlug: (slug: string) => `/organizations/slug/${slug}`,
} as const;

export const SERVICES = {
  list:       '/services',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // all:        '/services/all',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // categories: '/services/categories',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // byId:       (id: string) => `/services/${id}`,
} as const;

export const MATCHING = {
  nearby:    '/matching/nearby',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // providers: '/matching/providers',
} as const;

export const SLOTS = {
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // reserve: '/slots/reserve',
} as const;

export const EXPERIMENTS = {
  active: '/experiments/active',
} as const;
