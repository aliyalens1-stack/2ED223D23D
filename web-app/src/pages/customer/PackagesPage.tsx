// Sprint 3 — Packages + Payments (Web).
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, CreditCard, ArrowLeft, Check, Sparkles, Loader2 } from 'lucide-react';

interface PackageT { id: string; title: string; credits: number; price: number; currency: string; savings: number; badge: string | null; }

export default function PackagesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [packages, setPackages] = useState<PackageT[]>([]);
  const [balance, setBalance] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/packages').then((r) => r.json()).then(setPackages).catch((e) => setError(String(e)));
    loadBalance();
  }, []);

  async function loadBalance() {
    const token = localStorage.getItem('token') || '';
    if (!token) return;
    const res = await fetch('/api/customer/credits', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setBalance(await res.json());
  }

  const buy = async (pkg: PackageT, provider: 'stripe' | 'paypal') => {
    setError(null);
    setBusy(`${pkg.id}:${provider}`);
    try {
      const token = localStorage.getItem('token') || '';
      const res = await fetch('/api/payments/packages/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ packageId: pkg.id, provider, origin: window.location.origin }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      window.location.href = data.checkoutUrl;
    } catch (e: any) {
      setError(e?.message || 'failed');
      setBusy(null);
    }
  };

  const canceled = params.get('canceled') === '1';

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-6 py-10" data-testid="packages-page">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('common.back')}
      </Link>

      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary-h)] mb-2">
            {t('packages.eyebrow')}
          </p>
          <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">{t('packages.title')}</h1>
          <p className="mt-2 text-[var(--text-2)] max-w-2xl">{t('packages.subtitle')}</p>
        </div>
        {balance && (
          <div className="rounded-2xl border border-[var(--primary)] bg-[var(--primary-soft)] px-4 py-3" data-testid="packages-balance">
            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--primary-h)]">{t('packages.your_credits')}</div>
            <div className="flex items-baseline gap-1">
              <span className="text-3xl font-extrabold text-[var(--text)]">{balance.available}</span>
              <span className="text-sm text-[var(--text-soft)]">/ {balance.balance}</span>
            </div>
            <div className="text-[11px] text-[var(--text-soft)] font-semibold">
              {balance.reserved > 0 ? `${balance.reserved} ${t('packages.reserved')}` : t('packages.ready_to_use')}
            </div>
          </div>
        )}
      </div>

      {canceled && (
        <div className="mt-6 rounded-xl border border-[var(--warning)] bg-[var(--warning-soft)] text-[var(--warning)] px-4 py-3 text-sm font-bold">
          {t('packages.canceled')}
        </div>
      )}
      {error && (
        <div className="mt-6 rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] px-4 py-3 text-sm font-bold" data-testid="packages-error">
          {error}
        </div>
      )}

      <div className="mt-8 grid gap-5 md:grid-cols-3" data-testid="packages-grid">
        {packages.map((p) => (
          <div
            key={p.id}
            className={`relative rounded-2xl border p-6 ${
              p.badge
                ? 'border-[var(--primary)] bg-white shadow-[0_14px_40px_-20px_rgba(234,179,8,0.45)]'
                : 'border-[var(--border)] bg-white shadow-[var(--shadow-card)]'
            }`}
            data-testid={`pkg-card-${p.id}`}
          >
            {p.badge && (
              <span className="absolute -top-3 left-6 rounded-full bg-[var(--primary)] px-3 py-1 text-[11px] font-bold text-black uppercase tracking-wider">
                {p.badge}
              </span>
            )}
            <div className="text-sm font-bold uppercase tracking-wider text-[var(--text-soft)]">{p.title}</div>
            <div className="mt-2 flex items-end gap-2">
              <span className="text-4xl font-extrabold">€{p.price}</span>
              {p.savings > 0 && (
                <span className="text-xs font-bold text-[var(--success)] mb-1.5">
                  − €{p.savings}
                </span>
              )}
            </div>
            <div className="mt-1 text-xs font-semibold text-[var(--text-soft)]">
              {p.credits} × {t('packages.inspection')} · €{(p.price / p.credits).toFixed(0)} / {t('packages.per_unit')}
            </div>

            <ul className="mt-5 space-y-2 text-sm text-[var(--text-2)]">
              <Li>{t('packages.perks.tuv')}</Li>
              <Li>{t('packages.perks.checklist')}</Li>
              <Li>{t('packages.perks.photos_videos')}</Li>
              {p.credits >= 3 && <Li>{t('packages.perks.compare')}</Li>}
              {p.credits >= 5 && <Li>{t('packages.perks.priority')}</Li>}
            </ul>

            <div className="mt-6 space-y-2">
              <button
                onClick={() => buy(p, 'stripe')}
                disabled={!!busy}
                className="btn-primary w-full disabled:opacity-60"
                data-testid={`pkg-buy-stripe-${p.id}`}
              >
                {busy === `${p.id}:stripe` ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
                <span>{t('packages.pay_card')}</span>
              </button>
              <button
                onClick={() => buy(p, 'paypal')}
                disabled={!!busy}
                className="btn-dark w-full disabled:opacity-60"
                data-testid={`pkg-buy-paypal-${p.id}`}
              >
                {busy === `${p.id}:paypal` ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                <span>PayPal</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 text-xs text-[var(--text-soft)]">
        <ShieldCheck size={14} className="inline-block mr-1 -mt-0.5" />
        {t('packages.safety_note')}
      </div>
    </div>
  );
}

function Li({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check size={16} className="text-[var(--success)] mt-0.5 shrink-0" />
      <span>{children}</span>
    </li>
  );
}
