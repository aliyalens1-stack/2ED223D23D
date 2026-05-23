// Sprint 3 — Stripe / PayPal return handler. Polls status.
//
// E2 — Payment 0B: branches on the customer-visibility projection from
// `@platform/domain/state-machines/payment` instead of raw backend
// `status` strings. The page no longer collapses 'cancelled' into
// 'failed' silently nor invents its own ladder.
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, AlertCircle, Package, Undo2 } from 'lucide-react';
import {
  customerVisibilityFor,
  customerRefundNoticeFor,
  mergeMonotonic,
  normalizeBackendPaymentStatus,
} from '@platform/domain/state-machines/payment';
import type { PaymentStatus } from '@platform/domain/contracts/payment';

const MAX_POLLS = 10;

interface PaymentDtoFromBackend {
  amount?: number;
  credits?: number;
  status?: string | null;
  paymentStatus?: string | null;
  [k: string]: unknown;
}

export default function PaymentSuccessPage() {
  const [params] = useSearchParams();
  const paymentId = params.get('paymentId') || '';
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [exhausted, setExhausted] = useState(false);
  const [payment, setPayment] = useState<PaymentDtoFromBackend | null>(null);
  const pollRef = useRef(0);

  useEffect(() => {
    if (!paymentId) { setExhausted(true); return; }
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/payments/packages/status/${paymentId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        const pay = (data.payment ?? null) as PaymentDtoFromBackend | null;
        setPayment(pay);
        // Backend returns either a top-level `status` ('paid'|'pending'|...)
        // or nested in `payment`. Prefer payment-level when present.
        const rawStatus = (pay?.status ?? data.status) as string | undefined | null;
        const rawGateway = pay?.paymentStatus as string | undefined | null;
        const next = normalizeBackendPaymentStatus(rawStatus, rawGateway);
        // Refuse silent downgrades from out-of-order polls.
        setStatus(prev => mergeMonotonic(prev, next));
        // Stop polling on terminal customer state. We stop on
        // 'completed' (paid OR refunded) and 'failed'; keep polling
        // while 'processing' or 'hidden'.
        const visibility = customerVisibilityFor(next);
        if (visibility === 'completed' || visibility === 'failed') return;
        pollRef.current += 1;
        if (pollRef.current >= MAX_POLLS) { setExhausted(true); return; }
        setTimeout(tick, 2000);
      } catch (_e) {
        if (alive) setExhausted(true);
      }
    };
    tick();
    return () => { alive = false; };
  }, [paymentId]);

  const visibility = customerVisibilityFor(status);
  const isRefundNotice = customerRefundNoticeFor(status);
  // Exhausted polling without a terminal answer = degrade to 'failed'
  // for UX; the user can retry. Do NOT corrupt `status` itself —
  // backend may still resolve later.
  const showFailed = visibility === 'failed' || (exhausted && visibility !== 'completed');
  const showProcessing = !showFailed && (visibility === 'processing' || visibility === 'hidden');
  const showCompleted = visibility === 'completed';

  return (
    <div className="mx-auto max-w-xl px-4 md:px-6 py-14" data-testid="payment-success-page">
      {showProcessing && (
        <div className="rounded-2xl border border-[var(--border)] bg-white p-8 text-center shadow-[var(--shadow-card)]" data-testid="payment-processing">
          <Loader2 size={36} className="animate-spin mx-auto text-[var(--primary-h)] mb-4" />
          <h1 className="text-xl font-extrabold">Confirming payment…</h1>
          <p className="mt-2 text-sm text-[var(--text-2)]">This usually takes a few seconds.</p>
        </div>
      )}
      {showCompleted && payment && (
        <div className="rounded-2xl border border-[var(--success)] bg-[var(--success-soft)] p-8 text-center" data-testid="payment-paid">
          <CheckCircle2 size={44} className="mx-auto text-[var(--success)] mb-3" />
          <h1 className="text-2xl font-extrabold">Payment received ✓</h1>
          <p className="mt-2 text-[var(--text-2)]">
            +{payment.credits} inspection credit{(payment.credits ?? 0) > 1 ? 's' : ''} added · €{payment.amount}
          </p>
          {isRefundNotice && (
            <div
              className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-1 text-xs font-semibold text-[var(--warning)]"
              data-testid="payment-refund-notice"
            >
              <Undo2 size={12} /> Refund issued — credits already redeemed remain valid
            </div>
          )}
          <div className="mt-6 flex justify-center gap-3">
            <Link to="/selection-request" className="btn-primary" data-testid="payment-create-request-btn">
              <Package size={16} /> Create a request
            </Link>
            <Link to="/dashboard/requests" className="btn-dark">
              My requests
            </Link>
          </div>
        </div>
      )}
      {showFailed && (
        <div className="rounded-2xl border border-[var(--danger)] bg-[var(--danger-soft)] p-8 text-center" data-testid="payment-failed">
          <AlertCircle size={44} className="mx-auto text-[var(--danger)] mb-3" />
          <h1 className="text-xl font-extrabold">Payment not confirmed</h1>
          <p className="mt-2 text-sm text-[var(--text-2)]">We couldn&apos;t confirm your payment. If money was charged, credits will appear after sync.</p>
          <Link to="/packages" className="btn-primary mt-5 inline-flex">Retry</Link>
        </div>
      )}
    </div>
  );
}
