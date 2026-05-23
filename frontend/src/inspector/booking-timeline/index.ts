/**
 * P0.b.C.d.UI.c — public surface for the inspector job timeline.
 *
 * Importers MUST come from the inspector surface only. Do not import
 * from customer / provider / admin code. Each surface owns its own
 * projection consumer.
 *
 * Identity reminder: this API speaks **jobId**, never bookingId or
 * requestId. Server resolves the underlying request internally.
 */
export { useInspectorJobTimeline } from './useInspectorJobTimeline';
export type {
  InspectorTimelineEvent,
  InspectorTimelineKey,
  InspectorTimelineTone,
  InspectorTimelineSnapshot,
  InspectorTimelineWsEnvelope,
  InspectorConnectionStatus,
} from './types';
export { inspectorDedupKey } from './reducer';
