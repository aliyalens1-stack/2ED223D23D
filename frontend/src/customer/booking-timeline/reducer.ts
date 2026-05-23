/**
 * P0.b.C.d.UI.a — Surface-local reducer for customer booking timeline.
 *
 * Doctrine:
 *   * REST snapshot is authoritative. `hydrate()` and `reconcile()`
 *     REPLACE state — they never merge "best-of-both".
 *   * `append()` adds a single WS-delivered event ONLY if no row with
 *     the same dedup key (`at|key`) is already present. This protects
 *     against the race where REST and WS both deliver the same event
 *     during reconciliation.
 *   * No optimistic updates. The reducer never invents events the
 *     server didn't send.
 *   * Sort order: ascending by `at`. Rows with `at == null` (legacy)
 *     are appended in arrival order at the end.
 *
 * This file is INTENTIONALLY local to `src/customer/booking-timeline/`.
 * Do NOT move it to `src/shared/` — provider / inspector / admin will
 * each own their own reducer because their projections have already
 * diverged at the backend.
 */

import type { CustomerTimelineEvent } from './types';

export interface TimelineState {
  events: CustomerTimelineEvent[];
}

export type TimelineAction =
  | { type: 'hydrate'; events: CustomerTimelineEvent[] }
  | { type: 'reconcile'; events: CustomerTimelineEvent[] }
  | { type: 'append'; event: CustomerTimelineEvent }
  | { type: 'reset' };

export const initialTimelineState: TimelineState = { events: [] };

/** Stable dedup key. `at` is ISO-8601 string; backend ensures uniqueness per row. */
export function dedupKey(event: CustomerTimelineEvent): string {
  return `${event.at ?? '∅'}|${event.key}`;
}

function sortByAt(events: CustomerTimelineEvent[]): CustomerTimelineEvent[] {
  // Stable sort with null-last semantics.
  return [...events].sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at == null) return 1;
    if (b.at == null) return -1;
    return a.at < b.at ? -1 : 1;
  });
}

export function timelineReducer(
  state: TimelineState,
  action: TimelineAction
): TimelineState {
  switch (action.type) {
    case 'hydrate':
    case 'reconcile':
      // REST wins. Drop any locally-appended WS frames that the server
      // does not include in the snapshot — they were either replaced
      // by a corrected projection or invalidated by a later mutation.
      return { events: sortByAt(action.events) };

    case 'append': {
      const incomingKey = dedupKey(action.event);
      // Skip if already known. Cheap: timelines are small (< 50 rows).
      if (state.events.some((e) => dedupKey(e) === incomingKey)) {
        return state;
      }
      return { events: sortByAt([...state.events, action.event]) };
    }

    case 'reset':
      return initialTimelineState;

    default:
      return state;
  }
}
