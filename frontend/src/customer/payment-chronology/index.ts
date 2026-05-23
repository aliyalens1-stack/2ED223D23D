/**
 * P0.b.C.i — public surface of the customer payment chronology consumer.
 *
 * Importers MUST come from the customer surface only. The admin
 * forensic consumer (`src/admin/payment-forensic/`) has its own
 * symbols with its own names — there is no shared kit.
 */
export { useCustomerPaymentChronology } from './usePaymentChronology';
export { dedupKey } from './reducer';
export type {
  ConnectionStatus,
  CustomerPaymentChronologySnapshot,
  CustomerPaymentChronologyWsEnvelope,
  CustomerPaymentEvent,
  CustomerPaymentKind,
  CustomerPaymentTone,
} from './types';
