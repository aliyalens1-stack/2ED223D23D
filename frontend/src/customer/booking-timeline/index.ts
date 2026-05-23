/**
 * P0.b.C.d.UI.a — public surface for the customer booking timeline.
 *
 * Importers MUST come from the customer surface only. Do not import
 * from `app/provider/...`, `app/inspector/...`, `app/admin/...`. Each
 * surface owns its own projection consumer.
 */
export {
  useCustomerBookingTimeline,
} from './useCustomerBookingTimeline';
export type {
  CustomerTimelineEvent,
  CustomerTimelineKey,
  CustomerTimelineTone,
  CustomerTimelineSnapshot,
  CustomerTimelineWsEnvelope,
  ConnectionStatus,
} from './types';
export { dedupKey } from './reducer';
