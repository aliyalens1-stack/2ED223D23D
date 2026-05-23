// SpecialistsPage — public catalog of certified inspectors.
// Fetches from existing /api/marketplace/providers. Style: white, black/yellow.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Star, MapPin, ShieldCheck, ArrowRight, Award } from 'lucide-react';
import { marketplaceAPI } from '../../services/api';

interface Specialist {
  id?: string;
  slug: string;
  name: string;
  city?: string;
  ratingAvg?: number;
  reviewsCount?: number;
  bookingsCount?: number;
  isPromoted?: boolean;
  description?: string;
  yearsExperience?: number;
}

export default function SpecialistsPage() {
  const { t } = useTranslation();
  const [list, setList] = useState<Specialist[]>([]);
  const [loading, setLoading] = useState(true);
  const [city, setCity] = useState<string>('all');

  useEffect(() => {
    marketplaceAPI.getProviders()
      .then(r => {
        const data = r.data?.providers ?? r.data ?? [];
        setList(Array.isArray(data) ? data : []);
      })
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  }, []);

  const cities = Array.from(new Set(list.map(s => s.city).filter(Boolean) as string[])).sort();
  const visible = city === 'all' ? list : list.filter(s => s.city === city);

  return (
    <div className="bg-white" data-testid="specialists-page">
      {/* Hero */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-16">
          <span className="inline-flex items-center gap-2 rounded-full bg-[var(--primary-soft)] px-3 py-1 text-xs font-bold uppercase tracking-wider">{t('specialists.eyebrow', { defaultValue: 'Каталог инспекторов' })}</span>
          <h1 className="mt-4 text-4xl md:text-6xl font-black tracking-tight">{t('specialists.title', { defaultValue: 'Сертифицированные инспекторы' })}</h1>
          <p className="mt-5 max-w-2xl text-lg text-[var(--text-2)]">{t('specialists.sub', { defaultValue: 'TÜV-сертификация, опыт от 5 лет, проверенные платформой. Выберите специалиста или закажите проверку — мы подберём ближайшего.' })}</p>

          {/* City filter */}
          <div className="mt-8 flex flex-wrap gap-2">
            <FilterChip active={city === 'all'} onClick={() => setCity('all')}>{t('specialists.all', { defaultValue: 'Все города' })} · {list.length}</FilterChip>
            {cities.map(c => (
              <FilterChip key={c} active={city === c} onClick={() => setCity(c)}>{c}</FilterChip>
            ))}
          </div>
        </div>
      </section>

      {/* Grid */}
      <section className="bg-[var(--surface-soft)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-16">
          {loading ? (
            <div className="text-center py-12 text-[var(--text-soft)]">{t('common.loading', { defaultValue: 'Загрузка…' })}</div>
          ) : visible.length === 0 ? (
            <div className="rounded-2xl border border-[var(--border)] bg-white p-10 text-center">
              <div className="text-lg font-bold">{t('specialists.empty_title', { defaultValue: 'Пока никого нет' })}</div>
              <div className="mt-2 text-sm text-[var(--text-2)]">{t('specialists.empty_sub', { defaultValue: 'Закажите проверку — мы подберём ближайшего инспектора.' })}</div>
              <Link to="/inspect" className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] px-5 h-12 text-sm font-bold text-black">
                {t('specialists.empty_cta', { defaultValue: 'Проверить авто' })} <ArrowRight size={15} />
              </Link>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
              {visible.map(s => (
                <article key={s.slug || s.id} className="rounded-2xl border border-[var(--border)] bg-white p-6 flex flex-col" data-testid={`specialist-${s.slug}`}>
                  <div className="flex items-start gap-4">
                    <div className="h-14 w-14 rounded-2xl bg-[var(--primary)] text-black flex items-center justify-center font-black text-xl shrink-0">
                      {(s.name || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-extrabold leading-tight truncate">{s.name}</h3>
                        {s.isPromoted && <span className="inline-flex items-center gap-1 rounded-full bg-[var(--primary-soft)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"><Award size={10} /> Top</span>}
                      </div>
                      {s.city && <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-[var(--text-soft)]"><MapPin size={12} /> {s.city}</div>}
                    </div>
                  </div>

                  {s.description && (
                    <p className="mt-4 text-sm text-[var(--text-2)] line-clamp-3">{s.description}</p>
                  )}

                  <div className="mt-5 grid grid-cols-3 gap-2 text-center">
                    <Metric label={t('specialists.rating', { defaultValue: 'Рейтинг' })} value={s.ratingAvg ? s.ratingAvg.toFixed(1) : '—'} icon={<Star size={12} />} />
                    <Metric label={t('specialists.reviews', { defaultValue: 'Отзывы' })} value={String(s.reviewsCount ?? 0)} />
                    <Metric label={t('specialists.bookings', { defaultValue: 'Проверок' })} value={String(s.bookingsCount ?? 0)} />
                  </div>

                  <div className="mt-5 inline-flex items-center gap-2 text-xs text-[var(--text-soft)]"><ShieldCheck size={14} className="text-[var(--primary)]" /> {t('specialists.certified', { defaultValue: 'TÜV-сертифицирован' })}</div>

                  <div className="mt-5 pt-5 border-t border-[var(--border)] flex gap-2">
                    <Link to={`/operator/${s.slug}`} className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] h-11 text-sm font-bold hover:bg-[var(--surface-soft)]">
                      {t('specialists.profile', { defaultValue: 'Профиль' })}
                    </Link>
                    <Link to="/inspect" className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-black text-white h-11 text-sm font-bold hover:bg-[#1f2937]">
                      {t('specialists.book', { defaultValue: 'Заказать' })} <ArrowRight size={14} />
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'inline-flex items-center rounded-full px-4 h-9 text-sm font-bold transition-colors',
        active
          ? 'bg-black text-white'
          : 'bg-white border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--surface-soft)]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Metric({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-[var(--surface-soft)] py-2.5">
      <div className="text-base font-extrabold inline-flex items-center justify-center gap-1">
        {icon && <span className="text-[var(--primary)]">{icon}</span>}
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
    </div>
  );
}
