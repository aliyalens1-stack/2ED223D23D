/**
 * Provider contracts — provider-owned aggregates.
 *
 * Canonical prefix: /provider
 * See /app/shared/contracts/DOCTRINE.md §2.
 *
 * P3.5 — Provider surface stabilization (2026-02-22): expanded from the
 * 9-entry post-P2 baseline to mirror the actual backend surface area
 * (102 mounted /provider routes across 13 sub-aggregates). Inbox /
 * request-accept-reject routes live under /marketplace/provider/* —
 * provider doesn't own marketplace primitives, marketplace does.
 */
export const PROVIDER = {
  // ─── Identity / availability / presence ──────────────────────────
  status:             '/provider/status',
  presence:           '/provider/presence',
  pressure:           '/provider/pressure',
  pressureSummary:    '/provider/pressure-summary',
  availability:       '/provider/availability',
  availabilityOverride: '/provider/availability/override',
  skills:             '/provider/skills',
  tier:               '/provider/tier',

  // ─── Performance ─────────────────────────────────────────────────
  performance: {
    me:      '/provider/performance/me',
    explain: '/provider/performance/explain',
    preview: '/provider/performance/preview',
    summary: '/provider/performance',
  },

  // ─── Earnings (canonical) ────────────────────────────────────────
  earnings: {
    summary: '/provider/earnings/summary',
    items:   '/provider/earnings/items',
    root:    '/provider/earnings',
  },

  // ─── Topology / intelligence ─────────────────────────────────────
  topology: {
    me:                 '/provider/topology/me',
    marketplaceActive:  '/provider/topology/me/marketplace-active',
  },
  intelligence:    '/provider/intelligence',
  opportunities:   '/provider/intelligence/opportunities',
  profileClusters: '/provider/profile/clusters',

  // ─── Service requests / bids (provider POV) ──────────────────────
  serviceRequests: {
    feed:   '/provider/service-requests/feed',
    list:   '/provider/service-requests',
    myBids: '/provider/service-requests/my-bids',
    bids:        (requestId: string) => `/provider/service-requests/${requestId}/bids`,
    quickBid:    (requestId: string) => `/provider/service-requests/${requestId}/quick-bid`,
    withdraw:    (requestId: string) => `/provider/service-requests/${requestId}/withdraw`,
  },
  requestCandidates: (requestId: string) => `/provider/requests/${requestId}/candidates`,

  // ─── Booking actions (own bookings) ──────────────────────────────
  booking: {
    timeline: (bookingId: string) => `/provider/bookings/${bookingId}/timeline`,
    action:   (bookingId: string) => `/provider/booking/${bookingId}/action`,
  },

  // ─── Work items (job queue) ──────────────────────────────────────
  workItems: {
    list:   '/provider/work-items',
    action: (itemId: string) => `/provider/work-items/${itemId}/action`,
  },

  // ─── Retention ───────────────────────────────────────────────────
  retention: {
    hub:        '/provider/retention/hub',
    earnings:   '/provider/retention/earnings',
    missed:     '/provider/retention/missed',
    dailyGoal:  '/provider/retention/daily-goal',
  },

  // ─── Pre-engagement ──────────────────────────────────────────────
  preEngage: '/provider/pre-engage',
  preEngagement: (slug: string) => `/provider/pre-engagement/${slug}`,

  // ─── Behaviour tracking ──────────────────────────────────────────
  behaviorTrack: '/provider/behavior/track',

  // ─── Boost (paid visibility) ─────────────────────────────────────
  boost: {
    buy:              '/provider/boost/buy',
    bid:              '/provider/boost/bid',
    autoBid:          '/provider/boost/auto-bid',
    autoBidAggressive:'/provider/boost/auto-bid/aggressive',
    zoneAdvisor:      '/provider/boost/zone-advisor',
  },

  // ─── Billing / subscriptions ─────────────────────────────────────
  billing: {
    products:  '/provider/billing/products',
    checkout:  '/provider/billing/checkout',
    purchases: '/provider/billing/purchases',
    status:    '/provider/billing/status',
  },
  subscriptions: {
    me:        '/provider/subscriptions/me',
    plans:     '/provider/subscriptions/plans',
    subscribe: '/provider/subscriptions/subscribe',
    cancel:    '/provider/subscriptions/cancel',
  },

  // ─── Auto-money (auto-bidding system) ────────────────────────────
  autoMoney: {
    status:  '/provider/auto-money/status',
    enable:  '/provider/auto-money/enable',
    disable: '/provider/auto-money/disable',
  },

  // ─── Car selection (acting as inspector-tier provider) ───────────
  carSelection: {
    me:     '/provider/car-selection/me',
    byRequest: (requestId: string) => `/provider/car-selection/${requestId}`,
    status:    (requestId: string) => `/provider/car-selection/${requestId}/status`,
    thread:    (requestId: string) => `/provider/car-selection/${requestId}/thread`,
    artifacts: (requestId: string) => `/provider/car-selection/${requestId}/artifacts`,
    artifact:  (requestId: string, artifactId: string) =>
      `/provider/car-selection/${requestId}/artifacts/${artifactId}`,
    offerPackages:        (rid: string) => `/provider/car-selection/${rid}/offer-packages`,
    offerPackage:         (rid: string, pid: string) => `/provider/car-selection/${rid}/offer-packages/${pid}`,
    deliverOfferPackage:  (rid: string, pid: string) => `/provider/car-selection/${rid}/offer-packages/${pid}/deliver`,
    reviseOfferPackage:   (rid: string, pid: string) => `/provider/car-selection/${rid}/offer-packages/${pid}/revise`,
  },
  candidate: (candidateId: string) => `/provider/candidates/${candidateId}`,

  // ─── Chat (provider threads) ─────────────────────────────────────
  chat: {
    threads: '/provider/chat/threads',
    reply:   (threadId: string) => `/provider/chat/threads/${threadId}/reply`,
  },
} as const;
