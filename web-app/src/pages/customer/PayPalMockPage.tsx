// Sprint 3 — Mock PayPal return page. Calls mock-complete and redirects to success.
import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Loader2, CheckCircle2 } from 'lucide-react';

export default function PayPalMockPage() {
  const [params] = useSearchParams();
  const paymentId = params.get('paymentId') || '';
  const [step, setStep] = useState<'confirm' | 'processing' | 'done'>('confirm');

  const confirm = async () => {
    setStep('processing');
    await fetch(`/api/payments/packages/mock-complete/${paymentId}`, { method: 'POST' });
    setStep('done');
    setTimeout(() => {
      window.location.href = `/api/web-app/packages/success?paymentId=${paymentId}`;
    }, 1200);
  };

  useEffect(() => { if (!paymentId) setStep('done'); }, [paymentId]);

  return (
    <div className="mx-auto max-w-md px-4 md:px-6 py-14" data-testid="paypal-mock-page">
      <div className="rounded-2xl border border-blue-300 bg-blue-50 p-7">
        <div className="flex items-center gap-2 mb-3">
          <span className="rounded-md bg-blue-600 text-white text-xs font-extrabold px-2 py-0.5">DEV</span>
          <span className="font-extrabold">PayPal mock checkout</span>
        </div>
        <p className="text-sm text-blue-900 mb-5">
          Production wiring of PayPal Orders API is planned for Sprint 4.
          For now this simulates a successful payment to keep the full flow testable end-to-end.
        </p>
        <div className="text-xs font-bold uppercase tracking-wider text-blue-700 mb-1">Payment ID</div>
        <div className="font-mono text-xs bg-white border border-blue-200 rounded-lg px-3 py-2 mb-5">{paymentId}</div>

        {step === 'confirm' && (
          <button onClick={confirm} className="btn-primary w-full" data-testid="paypal-mock-confirm">
            Approve mock payment
          </button>
        )}
        {step === 'processing' && (
          <button disabled className="btn-primary w-full opacity-80">
            <Loader2 size={16} className="animate-spin" /> Processing…
          </button>
        )}
        {step === 'done' && (
          <div className="text-center text-green-700">
            <CheckCircle2 size={36} className="mx-auto mb-2" />
            <Link to={`/packages/success?paymentId=${paymentId}`} className="underline font-bold">Continue</Link>
          </div>
        )}
      </div>
    </div>
  );
}
