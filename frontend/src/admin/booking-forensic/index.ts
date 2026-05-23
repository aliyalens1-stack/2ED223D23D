/**
 * P0.b.C.d.UI.d — public surface for the admin booking forensic stream.
 *
 * Different namespace from `booking-timeline` is intentional. This
 * surface is NOT a timeline; it is a raw operational evidence
 * stream. Importers MUST come from the admin surface only.
 */
export {
  useAdminBookingForensicStream,
} from './useAdminBookingForensicStream';
export type {
  ForensicRow,
  ForensicSnapshot,
  ForensicWsEnvelope,
  ForensicConnectionStatus,
} from './types';
