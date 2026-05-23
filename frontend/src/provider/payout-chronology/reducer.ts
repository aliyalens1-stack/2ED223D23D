/**
 * P6.2 — Surface-local reducer for provider payout chronology.
 *
 * Discipline (copied DOCTRINALLY from customer payment-chronology reducer,
 * but with its OWN file and its OWN state shape — not a shared kit):
 *
 *   * REST snapshot is authoritative. `hydrate` and `reconcile` REPLACE
 *     state, they never merge "best of both".
 *   * `append` inserts a single WS-delivered event ONLY when its `id` is
 *     unseen. Dedup is by row id (uuid4 from writer — globally unique).
 *   * No optimistic updates. No invented rows.
 *   * Sort order: ascending by `at`. Rows with falsy `at` go to the tail.
 *
 * This file is INTENTIONALLY local to `src/provider/payout-chronology/`.
 * Do NOT move it to `src/shared/`. Customer surface has its OWN reducer
 * in `src/customer/payment-chronology/reducer.ts`, because that surface
 * speaks a different ontology (`payment-activity.customer` ≠
 * `payout-activity.provider`).
 */

import type { ProviderPayoutEvent } from './types';

export interface ProviderPayoutChronologyState {
  events: ProviderPayoutEvent[];
  /** Dedup index — O(1) append check. */
  seenIds: Set<string>;
}

export type ProviderPayoutChronologyAction =
  | { type: 'hydrate'; events: ProviderPayoutEvent[] }
  | { type: 'reconcile'; events: ProviderPayoutEvent[] }
  | { type: 'append'; event: ProviderPayoutEvent }
  | { type: 'reset' };

export const initialProviderPayoutChronologyState: ProviderPayoutChronologyState = {
  events: [],
  seenIds: new Set(),
};

/**
 * Stable sort: timestamp ascending, null-last. Tiebreak by row id
 * lexicographically — deterministic across renders, so FlatList keeps
 * stable keys when two rows share `at`.
 */
function sortByAt(events: ProviderPayoutEvent[]): ProviderPayoutEvent[] {
  return [...events].sort((a, b) => {
    const at = a.at;
    const bt = b.at;
    if (at !== bt) {
      if (!at) return 1;
      if (!bt) return -1;
      return at < bt ? -1 : 1;
    }
    const ai = a.id || '';
    const bi = b.id || '';
    if (ai === bi) return 0;
    return ai < bi ? -1 : 1;
  });
}

/** Stable React list key — exported so the screen does not invent its own. */
export function dedupKey(event: ProviderPayoutEvent): string {
  return event.id;
}

export function providerPayoutChronologyReducer(
  state: ProviderPayoutChronologyState,
  action: ProviderPayoutChronologyAction
): ProviderPayoutChronologyState {
  switch (action.type) {
    case 'hydrate':
    case 'reconcile': {
      // REST wins. Drop any locally appended WS frames that the server
      // does not include in the new snapshot.
      const seen = new Set<string>();
      const kept: ProviderPayoutEvent[] = [];
      for (const e of action.events) {
        if (!e?.id) continue;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        kept.push(e);
      }
      return { events: sortByAt(kept), seenIds: seen };
    }

    case 'append': {
      const id = action.event?.id;
      if (!id) return state;
      if (state.seenIds.has(id)) return state;
      const seen = new Set(state.seenIds);
      seen.add(id);
      return {
        events: sortByAt([...state.events, action.event]),
        seenIds: seen,
      };
    }

    case 'reset':
      return initialProviderPayoutChronologyState;

    default:
      return state;
  }
}
