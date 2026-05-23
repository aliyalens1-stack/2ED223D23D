/**
 * PricingPreviewPage — web counterpart of mobile `pricing-preview.tsx`.
 *
 * Interactive distance/radius pricing calculator.
 * Hooked to:
 *   GET  /api/pricing/tiers         → tier table
 *   POST /api/pricing/project       → live projection from {basePrice, distanceKm}
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MapPin, Coins, Info, Loader2 } from 'lucide-react';

interface Tier {
  tier: string;
  minKm: number;
  maxKm: number | null;
  ratePerKm: number;
  minimumFee: number;
  manualReview?: boolean;
}
interface TiersResponse {
  includedKm: number;
  inspectorPayoutPct: number;
  platformFeePct: number;
  tiers: Tier[];
}
interface Projection {
  pricingVersion: string;
  basePrice: number;
  currency: string;
  includedKm: number;
  distanceKm: number;
  extraKm: number;
  remoteTier: string;
  distanceRate: number;
  distanceSurcharge: number;
  manualReview: boolean;
  customerTotal: number;
  inspectorDistancePayout: number;
  platformDistanceFee: number;
  digest?: string;
}

const PRESETS = [80, 120, 180, 220, 300, 504];

export default function PricingPreviewPage() {
  const { t } = useTranslation();
  const [basePrice, setBasePrice] = useState(199);
  const [distanceKm, setDistanceKm] = useState(220);
  const [projection, setProjection] = useState<Projection | null>(null);
  const [tiers, setTiers] = useState<TiersResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load tier table once
  useEffect(() => {
    fetch('/api/pricing/tiers')
      .then((r) => r.json())
      .then((d) => setTiers(d))
      .catch(() => setTiers(null));
  }, []);

  // Live projection (debounced)
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    const handle = setTimeout(() => {
      fetch('/api/pricing/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ basePrice, distanceKm }),
      })
        .then((r) => r.json())
        .then((d) => { if (!cancel) { setProjection(d); setError(null); } })
        .catch((e) => { if (!cancel) setError(String(e)); })
        .finally(() => { if (!cancel) setLoading(false); });
    }, 200);
    return () => { cancel = true; clearTimeout(handle); };
  }, [basePrice, distanceKm]);

  const breakdown = useMemo(() => {
    if (!projection) return [];
    return [
      { label: t('pricing_preview.base_price'), value: projection.basePrice },
      { label: t('pricing_preview.included_distance'), value: 0, note: t('pricing_preview.free_km', { km: projection.includedKm }) },
      { label: `${t('pricing_preview.billable_distance')} (${projection.extraKm} km × €${projection.distanceRate}/km · ${projection.remoteTier})`, value: projection.distanceSurcharge },
    ];
  }, [projection, t]);

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 py-8" data-testid="pricing-preview-page">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('region.back')}
      </Link>

      <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary-h)] mb-2">{t('pricing_preview.label')}</p>
      <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">{t('pricing_preview.title')}</h1>
      <p className="mt-2 text-[var(--text-2)] max-w-2xl">
        {t('pricing_preview.subtitle', { km: tiers?.includedKm ?? 100 })}
      </p>

      <div className="mt-8 grid gap-6 md:grid-cols-2">
        {/* Inputs */}
        <div className="rounded-2xl border border-[var(--border)] bg-white p-6 space-y-6" data-testid="pricing-inputs">
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)] mb-2 flex items-center gap-1">
              <Coins size={12} /> {t('pricing_preview.base_price')}
            </div>
            <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] px-4 h-12 focus-within:border-[var(--primary)]">
              <span className="text-lg font-extrabold mr-2">€</span>
              <input
                type="number"
                value={basePrice}
                onChange={(e) => setBasePrice(Math.max(0, parseInt(e.target.value || '0', 10)))}
                min={0}
                max={9999}
                className="flex-1 bg-transparent text-lg font-extrabold outline-none"
                data-testid="pricing-base-input"
              />
            </div>
          </div>

          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)] mb-2 flex items-center gap-1">
              <MapPin size={12} /> {t('pricing_preview.distance')}
            </div>
            <div className="flex items-center rounded-xl border border-[var(--border)] bg-[var(--surface-soft)] px-4 h-12 focus-within:border-[var(--primary)]">
              <input
                type="number"
                value={distanceKm}
                onChange={(e) => setDistanceKm(Math.min(9999, Math.max(0, parseInt(e.target.value || '0', 10))))}
                min={0}
                max={9999}
                className="flex-1 bg-transparent text-lg font-extrabold outline-none"
                data-testid="pricing-distance-input"
              />
              <span className="text-sm font-semibold text-[var(--text-soft)] ml-2">km</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setDistanceKm(p)}
                  data-testid={`pricing-preset-${p}`}
                  className={`rounded-full border px-3 py-1.5 text-xs font-bold ${
                    distanceKm === p
                      ? 'border-[var(--primary)] bg-[var(--primary)] text-black'
                      : 'border-[var(--border)] bg-white text-[var(--text-2)] hover:border-[var(--text-soft)]'
                  }`}
                >
                  {p} km
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Live breakdown */}
        <div className="rounded-2xl border border-[var(--border)] bg-white p-6" data-testid="pricing-breakdown">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('pricing_preview.live_breakdown')}</div>
            {loading && <Loader2 size={14} className="animate-spin text-[var(--text-soft)]" />}
          </div>
          {error ? (
            <div className="mt-4 text-sm text-[var(--danger)] font-bold">{error}</div>
          ) : projection ? (
            <>
              <div className="mt-4 space-y-2.5 text-sm">
                {breakdown.map((row, i) => (
                  <div key={i} className="flex items-start justify-between gap-3">
                    <div className="text-[var(--text-2)]">
                      {row.label}
                      {row.note && <div className="text-[11px] text-[var(--text-soft)] mt-0.5">{row.note}</div>}
                    </div>
                    <div className="font-semibold tabular-nums">€{row.value.toFixed(2)}</div>
                  </div>
                ))}
              </div>
              <hr className="my-4 border-[var(--border)]" />
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('pricing_preview.total')}</span>
                <span className="text-3xl font-extrabold tabular-nums" data-testid="pricing-total">€{projection.customerTotal.toFixed(2)}</span>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-[var(--surface-soft)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('pricing_preview.inspector_pay')}</div>
                  <div className="text-lg font-extrabold tabular-nums">€{projection.inspectorDistancePayout.toFixed(2)}</div>
                </div>
                <div className="rounded-xl bg-[var(--surface-soft)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('pricing_preview.platform_fee')}</div>
                  <div className="text-lg font-extrabold tabular-nums">€{projection.platformDistanceFee.toFixed(2)}</div>
                </div>
              </div>
              {projection.manualReview && (
                <div className="mt-4 rounded-xl border border-[var(--warning)] bg-[var(--warning-soft)] px-3 py-2 text-xs font-bold text-[var(--warning)] flex items-center gap-2">
                  <Info size={14} /> {t('pricing_preview.manual_review_note')}
                </div>
              )}
            </>
          ) : (
            <div className="mt-4 text-sm text-[var(--text-soft)]">{t('pricing_preview.no_projection')}</div>
          )}
        </div>
      </div>

      {/* Tier table */}
      {tiers && (
        <div className="mt-8 rounded-2xl border border-[var(--border)] bg-white p-6" data-testid="pricing-tiers">
          <div className="text-sm font-extrabold mb-1">{t('pricing_preview.tier_table')}</div>
          <p className="text-xs text-[var(--text-soft)] mb-4">{t('pricing_preview.tier_table_hint', { km: tiers.includedKm })}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">
                  <th className="py-2 pr-3">{t('pricing_preview.tier_col')}</th>
                  <th className="py-2 pr-3">{t('pricing_preview.range_col')}</th>
                  <th className="py-2 pr-3">{t('pricing_preview.rate_col')}</th>
                  <th className="py-2 pr-3">{t('pricing_preview.min_fee_col')}</th>
                  <th className="py-2 pr-3">{t('pricing_preview.notes_col')}</th>
                </tr>
              </thead>
              <tbody>
                {tiers.tiers.map((t2) => (
                  <tr key={t2.tier} className="border-t border-[var(--border)]" data-testid={`tier-row-${t2.tier}`}>
                    <td className="py-2.5 pr-3 font-bold capitalize">{t2.tier}</td>
                    <td className="py-2.5 pr-3 text-[var(--text-2)]">{t2.maxKm == null ? `${t2.minKm}+ km` : `${t2.minKm}–${t2.maxKm} km`}</td>
                    <td className="py-2.5 pr-3 tabular-nums">€{t2.ratePerKm.toFixed(2)}</td>
                    <td className="py-2.5 pr-3 tabular-nums">€{t2.minimumFee.toFixed(0)}</td>
                    <td className="py-2.5 pr-3">
                      {t2.manualReview && (
                        <span className="rounded-full bg-[var(--warning-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--warning)]">
                          {t('pricing_preview.manual_review')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 text-[11px] italic text-[var(--text-soft)]">
            {t('pricing_preview.payout_split', { inspector: Math.round(tiers.inspectorPayoutPct * 100), platform: Math.round(tiers.platformFeePct * 100) })}
          </p>
        </div>
      )}
    </div>
  );
}
