/**
 * telemetry — fire-and-forget event hook for conversion-physics measurement.
 *
 * Three events for the Bβ.contextual experiment:
 *
 *   vehicle_view             — user opened /vehicle/:id and data loaded
 *   vehicle_to_search_open   — user clicked "Следить за похожими" CTA
 *   vehicle_to_search_submit — user actually saved the subscription
 *
 * No analytics SDK, no batching, no PII. Just three calls to the existing
 * /api/system/track sink. Failures swallowed — telemetry never breaks UX.
 *
 * Conversion KPI (asked once, answered by data):
 *   submits / views    — does vehicle attention turn into market intent?
 */
import { api } from '../services/api';

export type TelemetryType =
  | 'vehicle_view'
  | 'vehicle_to_search_open'
  | 'vehicle_to_search_submit';

function readWatcherId(): string | undefined {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem('as_watcher_id')) || undefined;
  } catch {
    return undefined;
  }
}

export function track(type: TelemetryType, payload?: Record<string, unknown>): void {
  try {
    const watcherId = readWatcherId();
    // baseURL already ends with /api → endpoint relative.
    void api.post('/system/track', {
      type,
      userId: watcherId,
      payload: payload || {},
    }).catch(() => { /* swallow */ });
  } catch {
    /* telemetry must never throw */
  }
}
