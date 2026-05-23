/**
 * P0.b.C.d.UI.b — Surface-local reducer for provider booking timeline.
 *
 * Deliberately a near-copy of `src/customer/booking-timeline/reducer.ts`
 * — but they are NOT the same module. Customer and provider reducers
 * live in different folders and import their own respective `*Event`
 * type. This duplication is the point.
 *
 * Invariants:
 *   * `hydrate` / `reconcile` REPLACE state — REST wins.
 *   * `append` is idempotent via dedup key `at|key`.
 *   * No optimistic updates. Mutation echo is NOT injected client-side.
 */

import type { ProviderTimelineEvent } from './types';

export interface ProviderTimelineState {
  events: ProviderTimelineEvent[];
}

export type ProviderTimelineAction =
  | { type: 'hydrate'; events: ProviderTimelineEvent[] }
  | { type: 'reconcile'; events: ProviderTimelineEvent[] }
  | { type: 'append'; event: ProviderTimelineEvent }
  | { type: 'reset' };

export const initialProviderTimelineState: ProviderTimelineState = { events: [] };

export function providerDedupKey(event: ProviderTimelineEvent): string {
  return `${event.at ?? '∅'}|${event.key}`;
}

function sortByAt(events: ProviderTimelineEvent[]): ProviderTimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.at === b.at) return 0;
    if (a.at == null) return 1;
    if (b.at == null) return -1;
    return a.at < b.at ? -1 : 1;
  });
}

export function providerTimelineReducer(
  state: ProviderTimelineState,
  action: ProviderTimelineAction
): ProviderTimelineState {
  switch (action.type) {
    case 'hydrate':
    case 'reconcile':
      // REST is authority. Locally-appended frames not present in the
      // snapshot are dropped — they were either superseded by a
      // corrected projection or invalidated by a later mutation.
      return { events: sortByAt(action.events) };

    case 'append': {
      const incomingKey = providerDedupKey(action.event);
      if (state.events.some((e) => providerDedupKey(e) === incomingKey)) {
        return state;
      }
      return { events: sortByAt([...state.events, action.event]) };
    }

    case 'reset':
      return initialProviderTimelineState;

    default:
      return state;
  }
}
