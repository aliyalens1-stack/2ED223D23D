/**
 * P0.b.C.d.UI.b — public surface for the provider booking timeline.
 *
 * Importers MUST come from the provider surface only. Do not import
 * from customer / inspector / admin code. Each surface owns its own
 * projection consumer.
 */
export { useProviderBookingTimeline } from './useProviderBookingTimeline';
export type {
  ProviderTimelineEvent,
  ProviderTimelineKey,
  ProviderTimelineTone,
  ProviderTimelineSnapshot,
  ProviderTimelineWsEnvelope,
  ProviderConnectionStatus,
} from './types';
export { providerDedupKey } from './reducer';
