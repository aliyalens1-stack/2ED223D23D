/**
 * P0.b.C.i — Admin payment forensic reducer.
 *
 * Surface-local. Deliberately different in shape, naming, and action
 * set from the customer chronology reducer. This is the SECOND species
 * — `payment-forensic.admin` — not a variant of
 * `payment-chronology.customer`.
 *
 * Admin-specific invariants:
 *
 *   1. BURST INSERT — `appendMany` handles many rows arriving as one
 *      catch-up batch after a reconnect gap. We dedup once, sort once.
 *   2. DUPLICATE TOLERANCE — every row has a globally unique `id`
 *      minted by `append_payment_event()`. Dedup set is the source
 *      of truth.
 *   3. OUT-OF-ORDER TOLERANCE — sort by `at` ascending; tiebreak by id
 *      lex ascending so list keys stay stable across renders.
 *   4. HYDRATE REPLACES — same REST-wins discipline as the customer
 *      reducer (parallel files, not shared code).
 */

import type { ForensicPaymentRow } from './types';

export interface ForensicPaymentStreamState {
  rows: ForensicPaymentRow[];
  seenIds: Set<string>;
}

export type ForensicPaymentStreamAction =
  | { type: 'hydrate'; rows: ForensicPaymentRow[] }
  | { type: 'append'; row: ForensicPaymentRow }
  | { type: 'appendMany'; rows: ForensicPaymentRow[] }
  | { type: 'reset' };

export const initialForensicPaymentStreamState: ForensicPaymentStreamState = {
  rows: [],
  seenIds: new Set(),
};

function sortForensic(rows: ForensicPaymentRow[]): ForensicPaymentRow[] {
  return [...rows].sort((a, b) => {
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

export function forensicPaymentStreamReducer(
  state: ForensicPaymentStreamState,
  action: ForensicPaymentStreamAction
): ForensicPaymentStreamState {
  switch (action.type) {
    case 'hydrate': {
      const seen = new Set<string>();
      const kept: ForensicPaymentRow[] = [];
      for (const r of action.rows) {
        if (!r?.id) continue;
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
      return {
        rows: sortForensic([...state.rows, action.row]),
        seenIds: seen,
      };
    }

    case 'appendMany': {
      const incoming = action.rows.filter(
        (r) => r?.id && !state.seenIds.has(r.id)
      );
      if (incoming.length === 0) return state;
      const burstSet = new Set<string>();
      const dedupedBurst: ForensicPaymentRow[] = [];
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
      return initialForensicPaymentStreamState;

    default:
      return state;
  }
}
