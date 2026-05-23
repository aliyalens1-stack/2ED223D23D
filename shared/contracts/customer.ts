/**
 * Customer contracts — customer-owned aggregates accessed via /my projections.
 *
 * Canonical: identity-implicit (JWT subject) at the resource root.
 * See /app/shared/contracts/DOCTRINE.md §3.
 *
 * Note: /bookings, /quotes, /vehicles, /reviews, /notifications, /favorites,
 * /disputes are mounted at the resource root (NOT under /customer/*) because
 * the same routes serve both customer's "/my" and provider's "/incoming"
 * projections from a shared aggregate. This is the documented exception in
 * the doctrine — projections share a root, ownership is implied by suffix.
 */
export const CUSTOMER = {
  notifications: {
    my:          '/notifications/my',
    list:        '/notifications',                                    // compat alias
    unreadCount: '/notifications/unread-count',
    markRead:    (id: string) => `/notifications/${id}/read`,
  },
  favorites: {
    my:     '/favorites/my',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:   '/favorites',                                             // compat alias
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // toggle: '/favorites',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // remove: (id: string) => `/favorites/${id}`,
  },
  bookings: {
    my:       '/bookings/my',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // incoming: '/bookings/incoming',                                   // provider projection
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:     (id: string) => `/bookings/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // create:   '/bookings',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // cancel:   (id: string) => `/bookings/${id}/cancel`,
  },
  quotes: {
    my:         '/quotes/my',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // incoming:   '/quotes/incoming',                                   // provider projection
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // create:     '/quotes',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // quick:      '/quotes/quick',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // quickTypes: '/quotes/quick/types',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:       (id: string) => `/quotes/${id}`,
  },
  vehicles: {
    my:     '/vehicles/my',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:   (id: string) => `/vehicles/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // create: '/vehicles',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // remove: (id: string) => `/vehicles/${id}`,
  },
  garage: {
    byId: (id: string) => `/garage/${id}`,
  },
  reviews: {
    my:        '/reviews/my',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // create:    '/reviews',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byBooking: (id: string) => `/reviews/by-booking/${id}`,
  },
  disputes: {
    list:   '/disputes/my',
    create: '/disputes',
    byId:   (id: string) => `/disputes/${id}`,
  },
} as const;
