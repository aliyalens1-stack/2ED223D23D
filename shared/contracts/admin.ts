/**
 * Admin contracts — operational console paths.
 *
 * Canonical prefix: /admin
 * Sub-domains grouped by aggregate (governance is its own namespace).
 *
 * This file is the source of truth for every URL string used by the
 * admin SPA (`/app/admin/src/services/api.ts`). Adding a backend admin
 * route MUST add a key here in the same PR.
 *
 * See /app/shared/contracts/DOCTRINE.md §2 + §5.
 */
export const ADMIN = {
  // ─── Dashboard / Live ────────────────────────────────────
  dashboard:        '/admin/dashboard',
  liveFeed:         '/admin/live-feed',
  alerts:           '/admin/alerts',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // auditLog:         '/admin/audit-log',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // search:           '/admin/search',

  // ─── Metrics ─────────────────────────────────────────────
  metrics: {
    market:     '/admin/metrics/market',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // response:   '/admin/metrics/response',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // categories: '/admin/metrics/categories',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // cities:     '/admin/metrics/cities',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // conversion: '/admin/metrics/conversion',
  },

  // ─── Users ───────────────────────────────────────────────
  users: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:       '/admin/users',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:       (id: string) => `/admin/users/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // activity:   (id: string) => `/admin/users/${id}/activity`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // block:      (id: string) => `/admin/users/${id}/block`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // unblock:    (id: string) => `/admin/users/${id}/unblock`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // addNote:    (id: string) => `/admin/users/${id}/notes`,
  },

  // ─── Organizations / Providers ───────────────────────────
  organizations: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:           '/admin/organizations',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:           (id: string) => `/admin/organizations/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // performance:    (id: string) => `/admin/organizations/${id}/performance`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // bookings:       (id: string) => `/admin/organizations/${id}/bookings`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // payouts:        (id: string) => `/admin/organizations/${id}/payouts`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // enable:         (id: string) => `/admin/organizations/${id}/enable`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // disable:        (id: string) => `/admin/organizations/${id}/disable`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // suspend:        (id: string) => `/admin/organizations/${id}/suspend`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // verify:         (id: string) => `/admin/organizations/${id}/verify`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setLocation:    (id: string) => `/organizations/${id}/location/admin`,        // compat: mounted flat
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // verifyLocation: (id: string) => `/organizations/${id}/location/verify`,       // compat
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setCommission:  (id: string) => `/admin/organizations/${id}/commission`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // addNote:        (id: string) => `/admin/organizations/${id}/notes`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setBoost:       (id: string) => `/admin/organizations/${id}/boost`,
  },

  // ─── Bookings ────────────────────────────────────────────
  bookings: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:        '/admin/bookings',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:        (id: string) => `/admin/bookings/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // timeline:    (id: string) => `/admin/bookings/${id}/timeline`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setStatus:   (id: string) => `/admin/bookings/${id}/status`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // reassign:    (id: string) => `/admin/bookings/${id}/reassign`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // refund:      (id: string) => `/admin/bookings/${id}/refund`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // addNote:     (id: string) => `/admin/bookings/${id}/notes`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // createFromRequest: '/bookings/create-from-request',                            // compat
  },

  // ─── Quotes / Requests ───────────────────────────────────
  quotes: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // all:          '/admin/quotes/all',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:         (id: string) => `/admin/quotes/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // details:      (id: string) => `/admin/quotes/${id}/details`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // responses:    (id: string) => `/admin/quotes/${id}/responses`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // manual:       '/admin/quotes/manual',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // distribute:   (id: string) => `/admin/quotes/${id}/distribute`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // close:        (id: string) => `/admin/quotes/${id}/close`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // escalate:     (id: string) => `/admin/quotes/${id}/escalate`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // addNote:      (id: string) => `/admin/quotes/${id}/notes`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // forceAction:  (id: string) => `/admin/quotes/${id}/force-action`,
  },

  // ─── Payments ────────────────────────────────────────────
  payments: {
    list:     '/admin/payments',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:     (id: string) => `/admin/payments/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // timeline: (id: string) => `/admin/payments/${id}/timeline`,
    retry:    (id: string) => `/admin/payments/${id}/retry`,
    refund:   (id: string) => `/admin/payments/${id}/refund`,
  },

  // ─── Payouts ─────────────────────────────────────────────
  payouts: {
    list:    '/admin/payouts',
    approve: (id: string) => `/admin/payouts/${id}/approve`,
    hold:    (id: string) => `/admin/payouts/${id}/hold`,
    process: (id: string) => `/admin/payouts/${id}/process`,
  },

  // ─── Disputes ────────────────────────────────────────────
  disputes: {
    list:            '/admin/disputes',
    byId:            (id: string) => `/admin/disputes/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // evidence:        (id: string) => `/admin/disputes/${id}/evidence`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // timeline:        (id: string) => `/admin/disputes/${id}/timeline`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // assign:          (id: string) => `/admin/disputes/${id}/assign`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setStatus:       (id: string) => `/admin/disputes/${id}/status`,
    resolve:         (id: string) => `/admin/disputes/${id}/resolve`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // requestEvidence: (id: string) => `/admin/disputes/${id}/request-evidence`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // freezePayout:    (id: string) => `/admin/disputes/${id}/freeze-payout`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // warn:            (id: string) => `/admin/disputes/${id}/warn`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // addNote:         (id: string) => `/admin/disputes/${id}/notes`,
  },

  // ─── Reviews ─────────────────────────────────────────────
  reviews: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:            '/admin/reviews',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:            (id: string) => `/admin/reviews/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // hide:            (id: string) => `/admin/reviews/${id}/hide`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // restore:         (id: string) => `/admin/reviews/${id}/restore`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // flag:            (id: string) => `/admin/reviews/${id}/flag`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // excludeRating:   (id: string) => `/admin/reviews/${id}/exclude-rating`,
  },

  // ─── Map / Geo ───────────────────────────────────────────
  map: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // nearby:  '/map/providers/nearby',                                              // compat: mounted flat
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // heatmap: '/admin/map/heatmap',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // zones:   '/admin/map/zones',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // zoneById: (id: string) => `/admin/map/zones/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // requestsLive: '/map/requests/live',                                            // compat
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // requestMatching: (id: string) => `/map/requests/${id}/matching`,               // compat
  },

  // ─── Assignment Engine ───────────────────────────────────
  assignment: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // matching:        (requestId: string) => `/requests/${requestId}/matching`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // distribute:      (requestId: string) => `/requests/${requestId}/distribute`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // distributeAuto:  (requestId: string) => `/requests/${requestId}/distribute/auto`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // distributions:   (requestId: string) => `/requests/${requestId}/distributions`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // assign:          (requestId: string) => `/requests/${requestId}/assign`,
  },

  // ─── Services & Categories CRUD (admin-only writes; reads under /services) ──
  servicesCategories: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:   '/services/categories',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // all:    '/services/categories/all',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // create: '/services/categories',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:   (id: string) => `/services/categories/${id}`,
  },
  services: {
    list:   '/services',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // all:    '/services/all',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:   (id: string) => `/services/${id}`,
  },
  providerServices: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byOrg: (orgId: string) => `/provider-services/organization/${orgId}`,
  },

  // ─── Settings / Config ───────────────────────────────────
  config: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // root:             '/admin/config',
    commissionTiers:  '/admin/config/commission-tiers',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // commissionTier:   (tier: string) => `/admin/config/commission-tiers/${tier}`,
    features:         '/admin/config/features',
  },

  // ─── Stripe Integration (encrypted credentials) ──────────
  stripe: {
    config:         '/admin/stripe/config',
    paymentMethods: '/admin/stripe/payment-methods',
    currencies:     '/admin/stripe/currencies',
    testKey:        '/admin/stripe/test-key',
  },

  // ─── Inspection Forensics ────────────────────────────────
  inspections: {
    timeline:  (jobId: string) => `/inspections/${jobId}/timeline`,
    media:     (jobId: string, mediaId: string) => `/inspections/${jobId}/media/${mediaId}`,
    adminJobs: '/inspections/admin/jobs',
  },

  // ─── Reports & Export ────────────────────────────────────
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // export:  (entity: string) => `/admin/export/${entity}`,
  reports: (type: string) => `/admin/reports/${type}`,

  // ─── Notifications (admin broadcasts) ────────────────────
  notifications: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // templates: '/admin/notifications/templates',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // template:  (id: string) => `/admin/notifications/templates/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // bulk:      '/admin/notifications/bulk',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // history:   '/admin/notifications/history',
  },

  // ─── Provider Metrics ────────────────────────────────────
  providers: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // metrics:        (id: string) => `/admin/providers/${id}/metrics`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // reputation:     (id: string) => `/admin/providers/${id}/reputation`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // adjustRating:   (id: string) => `/admin/providers/${id}/reputation/rating`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // trustFlag:      (id: string) => `/admin/providers/${id}/reputation/trust-flag`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // penalize:       (id: string) => `/admin/providers/${id}/reputation/penalize`,
    behavior:       '/admin/providers/behavior',
    behaviorBulk:   '/admin/providers/behavior/bulk-action',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // quality:        '/admin/providers/quality',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // qualityAction:  (id: string) => `/admin/providers/${id}/quality-action`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // lifecycle:      '/admin/providers/lifecycle',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // lifecycleAction:(id: string) => `/admin/providers/${id}/lifecycle-action`,
  },

  // ─── Zones (admin city-level) ────────────────────────────
  zones: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:    '/admin/zones',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:    (id: string) => `/admin/zones/${id}`,
    heatmap: '/admin/zones/heatmap',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // hot:     '/admin/zones/hot',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // dead:    '/admin/zones/dead',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // kpis:    '/admin/zones/kpis',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // control: '/admin/zones/control',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // action:  (id: string) => `/admin/zones/${id}/action`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // supplyPull: (id: string) => `/admin/zones/${id}/supply-pull`,
  },

  // ─── Demand ──────────────────────────────────────────────
  demand: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // metrics:        '/admin/demand/metrics',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // heatmap:        '/admin/demand/heatmap',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // hotAreas:       '/admin/demand/hot-areas',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // surge:          '/admin/demand/surge',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // control:        '/admin/demand/control',
    pushProviders:  '/admin/demand/push-providers',
    boostSupply:    (id: string) => `/admin/demand/${id}/boost-supply`,
    recommendations:'/admin/demand/actions/recommendations',
    run:            '/admin/demand/actions/run',
    history:        '/admin/demand/actions/history',
  },

  // ─── Market Automation ───────────────────────────────────
  market: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // rules:        '/admin/market/rules',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // rule:         (id: string) => `/admin/market/rules/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // toggleRule:   (id: string) => `/admin/market/rules/${id}/toggle`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // stats:        '/admin/market/stats',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // autoMode:     '/admin/market/auto-mode',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // executions:   '/admin/market/executions',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // trigger:      (zoneId: string) => `/admin/market/trigger/${zoneId}`,
    learning: {
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // stats:       '/admin/market/learning/stats',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // performance: '/admin/market/learning/performance',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // kpis:        '/admin/market/learning/kpis',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // startExp:    (id: string) => `/admin/market/learning/experiments/${id}/start`,
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // measure:     (execId: string) => `/admin/market/learning/measure/${execId}`,
    },
  },

  // ─── Experiments ─────────────────────────────────────────
  experiments: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:      '/admin/experiments',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setStatus: (id: string) => `/admin/experiments/${id}/status`,
  },

  // ─── Feature Flags ───────────────────────────────────────
  featureFlags: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:    '/admin/feature-flags',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // byId:    (id: string) => `/admin/feature-flags/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // toggle:  (key: string) => `/admin/feature-flags/${key}/toggle`,
  },

  // ─── Suggestions ─────────────────────────────────────────
  suggestions: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // list:    '/admin/suggestions',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // execute: (id: string) => `/admin/suggestions/${id}/execute`,
  },

  // ─── Governance (sub-namespace of admin) ─────────────────
  governance: {
    actions:       '/admin/governance/actions',
    score:         '/admin/governance/score',
    scoreZones:    '/admin/governance/score/zones',
    scoreHistory:  '/admin/governance/score/history',
  },

  // ─── Reconciliation (P3.3 cross-truth divergence detector + P5.2 persistence) ──
  reconciliation: {
    report:    '/admin/reconciliation/report',
    taxonomy:  '/admin/reconciliation/taxonomy',
    history:   '/admin/reconciliation/history',
    snapshot:  (id: string) => `/admin/reconciliation/history/${id}`,
  },

  // ─── Attribution (P5.1 — admin_audit_log read access) ────
  attribution: {
    byActor:  (actorId: string) => `/admin/attribution/by-actor/${actorId}`,
    byEntity: (entityId: string) => `/admin/attribution/by-entity/${entityId}`,
    recent:   '/admin/attribution/recent',
  },

  // ─── Forensic navigation graph (P3.4) ────────────────────
  forensicGraph: {
    describe: '/admin/forensic-graph/',
    byEntity: (entityType: 'booking' | 'payment' | 'dispute', entityId: string) =>
      `/admin/forensic-graph/${entityType}/${entityId}`,
  },

  // ─── Flow Control ────────────────────────────────────────
  flow: {
    config:  '/admin/flow/config',
    metrics: '/admin/flow/metrics',
  },

  // ─── Revenue ─────────────────────────────────────────────
  revenue: {
    experiments: '/admin/revenue/experiments',
    start:       (id: string) => `/admin/revenue/experiments/${id}/start`,
    stop:        (id: string) => `/admin/revenue/experiments/${id}/stop`,
    results:     (id: string) => `/admin/revenue/experiments/${id}/results`,
  },

  // ─── Quality auto-rules ──────────────────────────────────
  quality: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // autoRules: '/admin/quality/auto-rules',
  },

  // ─── Economy / Distribution / Incidents / System Health ──
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // economy:      '/admin/economy',
  distribution: '/admin/distribution/config',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // incidents:    '/admin/incidents',
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // incidentAction: (id: string) => `/admin/incidents/${id}/action`,
  // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
  // systemHealth: '/admin/system/health',

  // ─── Automation Engine ───────────────────────────────────
  automation: {
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // dashboard:       '/admin/automation/dashboard',
    replay:          '/admin/automation/replay',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // replayHistory:   '/admin/automation/replay/history',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // rules:           '/admin/automation/rules',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // rule:            (id: string) => `/admin/automation/rules/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // toggleRule:      (id: string) => `/admin/automation/rules/${id}/toggle`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // runTestRule:     (id: string) => `/admin/automation/rules/${id}/run-test`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // setRuleMode:     (id: string) => `/admin/automation/rules/${id}/set-mode`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // promoteRule:     (id: string) => `/admin/automation/rules/${id}/promote`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // bulkPromote:     '/admin/automation/rules/bulk-promote',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // executions:      '/admin/automation/executions',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // chains:          '/admin/automation/chains',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // chain:           (id: string) => `/admin/automation/chains/${id}`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // toggleChain:     (id: string) => `/admin/automation/chains/${id}/toggle`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // runTestChain:    (id: string) => `/admin/automation/chains/${id}/run-test`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // chainExecutions: (id: string) => `/admin/automation/chains/${id}/executions`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // config:          '/admin/automation/config',
    engine: {
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // monitor: '/admin/automation/engine/monitor',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // history: '/admin/automation/engine/history',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // start:   '/admin/automation/engine/start',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // stop:    '/admin/automation/engine/stop',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // pause:   '/admin/automation/engine/pause',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // resume:  '/admin/automation/engine/resume',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // config:  '/admin/automation/engine/config',
    },
    shadow: {
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // history:    '/admin/automation/shadow/history',
      // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
      // comparison: '/admin/automation/shadow/comparison',
    },
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // roi:          '/admin/automation/roi',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // roiSummary:   '/admin/automation/roi/summary',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // idempotency:  '/admin/automation/idempotency',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // idempotencyConfig: '/admin/automation/idempotency/config',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // idempotencyClear:  '/admin/automation/idempotency/clear',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // unifiedState:        '/admin/automation/unified-state',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // unifiedStateSync:    '/admin/automation/unified-state/sync',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // unifiedStateHealth:  '/admin/automation/unified-state/health',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // failsafeRules:     '/admin/automation/failsafe/rules',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // failsafeIncidents: '/admin/automation/failsafe/incidents',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // failsafeResolve:   (id: string) => `/admin/automation/failsafe/incidents/${id}/resolve`,
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // failsafeRunTest:   '/admin/automation/failsafe/run-test',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // feedback:        '/admin/automation/feedback',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // feedbackSummary: '/admin/automation/feedback/summary',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // dryRun:          '/admin/automation/dry-run',
    // DRIFT-RETIRED P2: backend route missing — restore when backend adds it
    // performance:     '/admin/automation/performance',
  },
} as const;
