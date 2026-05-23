/**
 * P0.b.C.d.UI.c — Surface-local reducer for inspector job timeline.
 *
 * Same recipe as customer + provider reducers, but in its own
 * module, operating on its own event shape. Field workflow surfaces
 * (this one) get a NEW reducer action — `drop` — used by the
 * inspector-specific stale-WS watchdog (see hook). Other surfaces
 * intentionally do not have this action.
 *
 * Invariants:
 *   * `hydrate` / `reconcile` REPLACE state — REST wins.
 *   * `append` is idempotent via dedup key `at|key`.
 *   * `drop` removes one row by dedup key — used ONLY by the watchdog
 *     to evict WS-appended events that REST never confirmed within
 *     the inspector's stale-WS window.
 *   * No optimistic updates.
 */

import type { InspectorTimelineEvent } from './types';

export interface InspectorTimelineState {
  events: InspectorTimelineEvent[];
}

export type InspectorTimelineAction =
  | { type: 'hydrate'; events: InspectorTimelineEvent[] }
  | { type: 'reconcile'; events: InspectorTimelineEvent[] }
  | { type: 'append'; event: InspectorTimelineEvent }
  | { type: 'drop'; key: string }
  | { type: 'reset' };

export const initialInspectorTimelineState: InspectorTimelineState = {
  events: [],
};

export function inspectorDedupKey(event: InspectorTimelineEvent): string {
  return `${event.at ?? '∅'}|${event.key}`;
}

function sortByAt(events: InspectorTimelineEvent[]): InspectorTimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at == null) return 1;
    if (b.at == null) return -1;
    return a.at < b.at ? -1 : 1;
  });
}

export function inspectorTimelineReducer(
  state: InspectorTimelineState,
  action: InspectorTimelineAction
): InspectorTimelineState {
  switch (action.type) {
    case 'hydrate':
    case 'reconcile':
      // REST authoritative. Locally-appended WS frames not in the
      // snapshot are dropped automatically by replacement.
      return { events: sortByAt(action.events) };

    case 'append': {
      const incomingKey = inspectorDedupKey(action.event);
      if (state.events.some((e) => inspectorDedupKey(e) === incomingKey)) {
        return state;
      }
      return { events: sortByAt([...state.events, action.event]) };
    }

    case 'drop': {
      // Watchdog eviction. Only used by inspector hook; documented in
      // useInspectorJobTimeline. Surface-local concept on purpose.
      const next = state.events.filter(
        (e) => inspectorDedupKey(e) !== action.key
      );
      if (next.length === state.events.length) return state;
      return { events: next };
    }

    case 'reset':
      return initialInspectorTimelineState;

    default:
      return state;
  }
}
