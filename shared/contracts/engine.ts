/**
 * Engine contracts — zones, demand, orchestrator, feedback.
 *
 * Mounted flat (not under /admin) because the orchestrator/strategy loops
 * read these endpoints internally. Admin-only access is enforced by
 * capability gates, not by path nesting.
 *
 * See /app/shared/contracts/DOCTRINE.md §2 ("Non-domain prefixes").
 */
export const ZONES = {
  list:      '/zones',
  liveState: '/zones/live-state',
  byId:      (id: string) => `/zones/${id}`,
  analytics: (id: string) => `/zones/${id}/analytics`,
} as const;

export const DEMAND = {
  heatmap: '/demand/heatmap',
} as const;

export const ORCHESTRATOR = {
  state:     '/orchestrator/state',
  rules:     '/orchestrator/rules',
  overrides: '/orchestrator/overrides',
  logs:      '/orchestrator/logs',
} as const;

export const FEEDBACK = {
  dashboard:       '/feedback/dashboard',
  strategy:        '/feedback/strategy',
  recommendations: '/feedback/recommendations',
} as const;
