/**
 * P0.b.C.i — Admin payment forensic stream types.
 *
 * THIS IS NOT A SHARED CHRONOLOGY KIT.
 *
 *   * Customer surface speaks `payment-activity.customer`: 11 kinds,
 *     whitelisted meta, redacted actor.id, humanized labels at the
 *     screen level.
 *   * Admin surface speaks `payment-forensic.admin`: 19 kinds incl.
 *     `:rejected` variants, FULL meta dict, FULL actor.id, raw kind
 *     literals shown verbatim. No prettification.
 *
 * These are TWO ontology species. Frontend files reflect that — the
 * admin stack lives in `src/admin/payment-forensic/`, names are
 * different, even the reducer action set differs (`appendMany` exists
 * here for burst hydration after reconnect, absent from customer).
 *
 * Wire identity: REST `GET /api/admin/payments/{id}/chronology` returns
 * `{ surface: 'payment-forensic.admin', paymentId, rows: ForensicPaymentRow[] }`.
 * WS frame `event` field is the same raw row.
 */

/** Raw `payment_events` row, exactly as Mongo stored it (sans `_id`). */
export interface ForensicPaymentRow {
  /** Row identifier (uuid4 from writer). Dedup key. */
  id: string;
  paymentId: string;
  /**
   * One of the 19 frozen taxonomy literals, including `:rejected`
   * suffix forms (e.g. `admin.force_release:rejected`). Shown
   * verbatim — admin reads operational evidence, not UX.
   */
  kind: string;
  /** ISO-8601. */
  at: string;
  /** RAW actor — both id and role present. */
  actor: {
    id: string;
    role: string;
  };
  /** Raw meta dict — UNFILTERED. May contain platformCut, internalNotes, etc. */
  meta: Record<string, unknown>;
  /** stripe_webhook_events.id when row was translated from a webhook. */
  sourceWebhookId: string | null;
  /** Writer schema version. */
  schemaVersion: number;
  /** Forward-compat. */
  [extra: string]: unknown;
}

/** REST envelope: `GET /api/admin/payments/{id}/chronology`. */
export interface ForensicPaymentSnapshot {
  surface: 'payment-forensic.admin';
  paymentId: string;
  rows: ForensicPaymentRow[];
}

/** WS envelope on the admin hub. `event` is the raw row. */
export interface ForensicPaymentWsEnvelope {
  type: 'payment.chronology.updated';
  scope: 'admin';
  paymentId: string;
  event: ForensicPaymentRow;
}

export type ForensicPaymentConnectionStatus =
  | 'idle'
  | 'hydrating'
  | 'live'
  | 'reconnecting'
  | 'offline';
