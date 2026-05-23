/**
 * Payments-2A — Mobile pay-button helpers.
 *
 * Thin typed wrapper around the snapshot-bound checkout (Payments-1).
 * Frontend NEVER sends an `amount`: the backend reads it from
 * `car_requests.pricing.customerTotal` (confirmed snapshot) and the
 * frontend gets back the figure to display.
 *
 * Anti-drift invariant carried up to the UI:
 *   "Pay €X" — X comes from the snapshot, not from local pricing math.
 */
import { api } from './api';

export interface SnapshotCheckoutResponse {
  sessionId: string;
  url: string;
  amount: number;
  currency: string;
  provider: 'stripe' | 'mock';
  pricingSnapshot: Record<string, any>;
}

export interface SnapshotTxStatus {
  sessionId: string;
  requestId: string;
  amount: number;
  currency: string;
  status: 'initiated' | 'paid' | 'failed' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  paid: boolean;
  pricingSnapshot: Record<string, any> | null;
  createdAt: string;
  paidAt: string | null;
}

/** Create a snapshot-bound checkout session. Refuses (409) if the
 *  request has no confirmed pricing snapshot — by design. */
export async function createSnapshotCheckout(
  requestId: string,
  originUrl: string,
  method: 'stripe' | 'mock' = 'stripe',
): Promise<SnapshotCheckoutResponse> {
  const { data } = await api.post<SnapshotCheckoutResponse>(
    `/payments/snapshot/checkout/${encodeURIComponent(requestId)}`,
    { originUrl, method },
  );
  return data;
}

/** Poll endpoint. Returns null on 404 so payment-success can fall back
 *  to the legacy /payments/auto-request/status path. */
export async function getSnapshotTransaction(
  sessionId: string,
): Promise<SnapshotTxStatus | null> {
  try {
    const { data } = await api.get<SnapshotTxStatus>(
      `/payments/snapshot/transaction/${encodeURIComponent(sessionId)}`,
    );
    return data;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}
