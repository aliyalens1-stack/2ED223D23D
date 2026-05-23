/**
 * Realtime + system contracts.
 *
 * Mounted flat — internal observability and websocket transport.
 * Not eligible canonical prefixes per DOCTRINE.md §2.
 */
export const REALTIME = {
  status:     '/realtime/status',
  events:     '/realtime/events',
  emit:       '/realtime/emit',
  socketPath: '/api/socket.io/',
  namespace:  '/realtime',
} as const;

export const SYSTEM = {
  health:        '/system/health',
  errors:        '/system/errors',
  errorStats:    '/system/errors/stats',
} as const;

export const HEALTH = '/health' as const;
