// Sprint 1 — Repositioning placeholder. Full logic → Sprint 7 (Car Comparison).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Scale, ArrowLeft, Sparkles } from 'lucide-react';

export default function ComparisonPage() {
  const { t } = useTranslation();

  const demo = [
    { id: 'A', score: 8.2, risk: 'low', priceLabel: '€18 500', risks: ['минор. ЛКП'], color: 'var(--success)' },
    { id: 'B', score: 6.1, risk: 'medium', priceLabel: '€16 200', risks: ['двигатель — подтёк', 'подвеска — стук'], color: 'var(--warning)' },
    { id: 'C', score: 7.4, risk: 'low', priceLabel: '€19 000', risks: ['OBD — 1 ошибка (старая)'], color: 'var(--success)' },
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 md:px-6 py-12" data-testid="comparison-page">
      <Link to="/" className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6" data-testid="comparison-back">
        <ArrowLeft size={16} /> {t('common.back')}
      </Link>

      <div className="inline-flex items-center gap-2 rounded-full bg-[var(--primary-soft)] text-[var(--primary-h)] px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] mb-4">
        <Sparkles size={14} /> {t('comparison.soon')}
      </div>

      <h1 className="text-3xl md:text-4xl font-extrabold leading-tight" data-testid="comparison-title">
        {t('comparison.title')}
      </h1>
      <p className="mt-3 text-[var(--text-2)] max-w-2xl">
        {t('comparison.subtitle')}
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-3" data-testid="comparison-demo">
        {demo.map((car) => (
          <div key={car.id} className="rounded-2xl border border-[var(--border)] bg-white p-5 shadow-[var(--shadow-card)]" data-testid={`comparison-car-${car.id}`}>
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('comparison.car')} {car.id}</div>
              <div className="text-xl font-extrabold">{car.priceLabel}</div>
            </div>
            <div className="mt-4 flex items-end gap-2">
              <Scale size={22} style={{ color: car.color as string }} />
              <div className="text-4xl font-extrabold">{car.score}</div>
              <div className="text-sm text-[var(--text-soft)] mb-1">/ 10</div>
            </div>
            <div className="mt-3 text-xs font-bold uppercase tracking-wider" style={{ color: car.color as string }}>
              {t(`comparison.risks_${car.risk}`)}
            </div>
            <ul className="mt-3 space-y-1.5 text-sm text-[var(--text-2)]">
              {car.risks.map((r, i) => (
                <li key={i}>· {r}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-6 text-xs text-[var(--text-soft)]">{t('comparison.demo_hint')}</p>
    </div>
  );
}
