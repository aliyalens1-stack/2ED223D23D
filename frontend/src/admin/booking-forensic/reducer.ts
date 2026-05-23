/**
 * P0.b.C.d.UI.d — Admin forensic stream reducer.
 *
 * Surface-local. Deliberately different from the 3 timeline reducers
 * in both name and action set. This is not "another timeline".
 *
 * Throughput invariants (admin-specific):
 *
 *   1. BURST INSERT — `appendMany` is O(n + m) on existing set size.
 *      Hub can deliver many rows after reconnect; we must not turn
 *      that into O(n*m).
 *
 *   2. DUPLICATE TOLERANCE — every row has a unique `id` (Mongo
 *      `booking_timeline._id` minted at write time, surfaced as `id`).
 *      Both REST hydrate and WS append flow through the same dedup
 *      gate: a `Set<id>` carried in state. Inserting the same row
 *      twice is a no-op.
 *
 *   3. OUT-OF-ORDER TOLERANCE — frames may arrive in any order
 *      relative to wall-clock. State stays sorted by `timestamp`
 *      ascending (null timestamps go to the tail). When ties occur,
 *      tiebreak is the row `id` lexicographically — stable and
 *      deterministic.
 *
 *   4. HYDRATE REPLACES — same REST-wins discipline as the timeline
 *      reducers. Locally appended frames not in the snapshot are
 *      dropped automatically by replacement.
 *
 * NO `drop` action here. Admin retains everything REST tells it to.
 */

import type { ForensicRow } from './types';

export interface ForensicStreamState {
  rows: ForensicRow[];
  /** Dedup index — exists for O(1) append checks. */
  seenIds: Set<string>;
}

export type ForensicStreamAction =
  | { type: 'hydrate'; rows: ForensicRow[] }
  | { type: 'append'; row: ForensicRow }
  | { type: 'appendMany'; rows: ForensicRow[] }
  | { type: 'reset' };

export const initialForensicStreamState: ForensicStreamState = {
  rows: [],
  seenIds: new Set(),
};

/**
 * Stable sort: timestamp ASC, null-last; tiebreak by id lex ASC.
 * Deterministic across renders — important for stable list keys.
 */
function sortForensic(rows: ForensicRow[]): ForensicRow[] {
  return [...rows].sort((a, b) => {
    const at = a.timestamp;
    const bt = b.timestamp;
    if (at !== bt) {
      if (at == null) return 1;
      if (bt == null) return -1;
      return at < bt ? -1 : 1;
    }
    // Tiebreak: row id, lex ascending.
    const ai = a.id || '';
    const bi = b.id || '';
    if (ai === bi) return 0;
    return ai < bi ? -1 : 1;
  });
}

export function forensicStreamReducer(
  state: ForensicStreamState,
  action: ForensicStreamAction
): ForensicStreamState {
  switch (action.type) {
    case 'hydrate': {
      // REST is authority. Rebuild seenIds from snapshot.
      const seen = new Set<string>();
      const kept: ForensicRow[] = [];
      for (const r of action.rows) {
        if (!r?.id) continue; // defensive — rows without id cannot dedup
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        kept.push(r);
      }
      return { rows: sortForensic(kept), seenIds: seen };
    }

    case 'append': {
      const id = action.row?.id;
      if (!id || state.seenIds.has(id)) return state;
      const seen = new Set(state.seenIds);
      seen.add(id);
      return { rows: sortForensic([...state.rows, action.row]), seenIds: seen };
    }

    case 'appendMany': {
      // Burst-tolerant: single sort at the end, single set rebuild.
      const incoming = action.rows.filter(
        (r) => r?.id && !state.seenIds.has(r.id)
      );
      if (incoming.length === 0) return state;
      // Dedup within the burst itself.
      const burstSet = new Set<string>();
      const dedupedBurst: ForensicRow[] = [];
      for (const r of incoming) {
        if (burstSet.has(r.id)) continue;
        burstSet.add(r.id);
        dedupedBurst.push(r);
      }
      const seen = new Set(state.seenIds);
      for (const r of dedupedBurst) seen.add(r.id);
      return {
        rows: sortForensic([...state.rows, ...dedupedBurst]),
        seenIds: seen,
      };
    }

    case 'reset':
      return initialForensicStreamState;

    default:
      return state;
  }
}
