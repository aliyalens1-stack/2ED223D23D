// ReportsShowcasePage — /reports — fully i18n'd (RU/DE/EN).
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, ChevronLeft, ChevronRight, ShieldCheck, Camera,
  Filter, ArrowUpDown, X, Activity, Euro, AlertOctagon, Search,
} from 'lucide-react';
import { CASES, VERDICT_META } from '../../data/cases';

type Verdict = 'all' | 'pass' | 'risk' | 'reject';
type Sort = 'newest' | 'savings' | 'expensive' | 'findings';
type TFn = (k: string, opts?: any) => string;

const BRANDS = Array.from(new Set(CASES.map(c => c.make))).sort();
const CITIES = Array.from(new Set(CASES.map(c => c.city))).sort();

const COLLECTIONS: { id: string; filter: { verdict?: Verdict; brand?: string; sort?: Sort } }[] = [
  { id: 'reject',    filter: { verdict: 'reject' } },
  { id: 'savings',   filter: { sort: 'savings' } },
  { id: 'risk',      filter: { verdict: 'risk' } },
  { id: 'premium',   filter: { brand: 'Porsche' } },
  { id: 'pass',      filter: { verdict: 'pass' } },
  { id: 'expensive', filter: { sort: 'expensive' } },
];

const PAGE = 9;

export default function ReportsShowcasePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.split('-')[0];
  const fmt = (n: number) => n.toLocaleString(locale === 'ru' ? 'ru-RU' : locale === 'de' ? 'de-DE' : 'en-US');

  const [verdict, setVerdict] = useState<Verdict>('all');
  const [brand, setBrand] = useState<string>('all');
  const [city, setCity] = useState<string>('all');
  const [sort, setSort] = useState<Sort>('newest');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(() => {
    let arr = CASES.slice();
    if (verdict !== 'all') arr = arr.filter(c => c.verdict === verdict);
    if (brand !== 'all')   arr = arr.filter(c => c.make === brand);
    if (city !== 'all')    arr = arr.filter(c => c.city === city);
    if (query.trim()) {
      const q = query.toLowerCase();
      arr = arr.filter(c => `${c.make} ${c.model} ${c.city}`.toLowerCase().includes(q));
    }
    if      (sort === 'savings')   arr.sort((a, b) => b.saved - a.saved);
    else if (sort === 'expensive') arr.sort((a, b) => b.askingPrice - a.askingPrice);
    else if (sort === 'findings')  arr.sort((a, b) => b.findings.length - a.findings.length);
    else                           arr.sort((a, b) => b.inspectionDate.localeCompare(a.inspectionDate));
    return arr;
  }, [verdict, brand, city, sort, query]);

  const trending = useMemo(() => CASES.slice().sort((a, b) => b.saved - a.saved).slice(0, 6), []);
  const totalSaved = CASES.reduce((s, c) => s + c.saved, 0);
  const passRate = Math.round(CASES.filter(c => c.verdict === 'pass').length / CASES.length * 100);

  const applyCollection = (f: typeof COLLECTIONS[number]['filter']) => {
    setVerdict(f.verdict ?? 'all');
    setBrand(f.brand ?? 'all');
    setSort(f.sort ?? 'newest');
    setShown(PAGE);
    requestAnimationFrame(() => {
      document.getElementById('feed-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const clearAll = () => { setVerdict('all'); setBrand('all'); setCity('all'); setSort('newest'); setQuery(''); setShown(PAGE); };
  const hasFilter = verdict !== 'all' || brand !== 'all' || city !== 'all' || query.length > 0;

  return (
    <div className="bg-white" data-testid="reports-discovery">

      {/* ── 1. SCALE HERO ─── */}
      <section className="border-b border-[var(--border)]">
        <div className="mx-auto max-w-7xl px-4 md:px-6 pt-12 md:pt-16 pb-12">
          <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">
            <span className="relative inline-flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
            {t('reports.discovery_eyebrow')} · {t('reports.in_base', { count: CASES.length })}
          </div>
          <h1 className="mt-5 text-5xl md:text-7xl lg:text-[5.5rem] font-black tracking-tight leading-[1.02] max-w-4xl whitespace-pre-line">{t('reports.title')}</h1>
          <p className="mt-6 max-w-2xl text-lg text-[var(--text-2)]">{t('reports.subtitle')}</p>

          <div className="mt-10 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            <ScaleStat value={String(CASES.length + 1224)}                          label={t('reports.stat_total')} />
            <ScaleStat value={`€${fmt(totalSaved + 1183000)}`}                      label={t('reports.stat_saved')} highlight />
            <ScaleStat value={String(BRANDS.length + 18)}                           label={t('reports.stat_brands')} />
            <ScaleStat value={String(CITIES.length + 12)}                           label={t('reports.stat_cities')} />
          </div>
        </div>
      </section>

      {/* ── 2. TRENDING ─── */}
      <section className="bg-[var(--surface-soft)]" data-testid="trending">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-14">
          <div className="flex items-end justify-between gap-4 mb-7">
            <div>
              <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('reports.trending_eyebrow')}</span>
              <h2 className="mt-2 text-3xl md:text-4xl font-black tracking-tight">{t('reports.trending_title')}</h2>
            </div>
            <div className="hidden md:flex gap-2">
              <ScrollBtn target="trend-rail" dir="-1" />
              <ScrollBtn target="trend-rail" dir="+1" />
            </div>
          </div>
          <div id="trend-rail" className="flex gap-4 overflow-x-auto pb-4 -mx-4 md:-mx-6 px-4 md:px-6 snap-x snap-mandatory" style={{ scrollbarWidth: 'thin' }}>
            {trending.map(c => <TrendCard key={c.id} c={c} fmt={fmt} />)}
          </div>
        </div>
      </section>

      {/* ── 3. DISCOVER BY INTENT ─── */}
      <section className="bg-white border-y border-[var(--border)]" data-testid="collections">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-14">
          <div className="max-w-2xl mb-7">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('reports.discover_eyebrow')}</span>
            <h2 className="mt-2 text-3xl md:text-4xl font-black tracking-tight">{t('reports.discover_title')}</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {COLLECTIONS.map(coll => (
              <button
                key={coll.id}
                onClick={() => applyCollection(coll.filter)}
                className="text-left group rounded-2xl border border-[var(--border)] bg-white hover:border-[var(--text)] hover:shadow-md transition p-5"
                data-testid={`collection-${coll.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="text-lg font-extrabold tracking-tight">{t(`reports.coll_${coll.id}_label`)}</div>
                  <ArrowRight size={16} className="text-[var(--text-soft)] mt-1 transition-transform group-hover:translate-x-0.5" />
                </div>
                <div className="mt-1.5 text-sm text-[var(--text-2)]">{t(`reports.coll_${coll.id}_sub`)}</div>
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* ── 4. FILTER BAR ─── */}
      <div id="feed-anchor" />
      <section className="sticky top-16 z-30 bg-white/95 backdrop-blur border-y border-[var(--border)]" data-testid="filter-bar">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wider text-[var(--text-soft)]"><Filter size={14} /> {t('reports.filter')}</div>

          <div className="hidden md:flex items-center rounded-lg border border-[var(--border)] bg-white px-3 h-9 min-w-[180px]">
            <Search size={14} className="text-[var(--text-soft)]" />
            <input value={query} onChange={e => { setQuery(e.target.value); setShown(PAGE); }} placeholder={t('reports.filter_placeholder')} className="ml-2 w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-soft)]" data-testid="filter-search" />
          </div>

          <div className="flex gap-1">
            {(['all','pass','risk','reject'] as Verdict[]).map(v => (
              <button key={v} onClick={() => { setVerdict(v); setShown(PAGE); }} className={`inline-flex items-center rounded-lg px-3 h-9 text-xs font-bold transition ${verdict===v ? 'bg-[var(--text)] text-white' : 'bg-[var(--surface-soft)] text-[var(--text-2)] hover:bg-[var(--border)]'}`} data-testid={`filter-verdict-${v}`}>
                {v === 'all' ? t('reports.filter_all') : VERDICT_META[v].short}
              </button>
            ))}
          </div>

          <Select label={t('reports.filter_brand')} value={brand} onChange={v => { setBrand(v); setShown(PAGE); }} options={['all', ...BRANDS]} testid="filter-brand" t={t} />
          <Select label={t('reports.filter_city')}  value={city}  onChange={v => { setCity(v);  setShown(PAGE); }} options={['all', ...CITIES]} testid="filter-city" t={t} />

          <div className="ml-auto inline-flex items-center gap-2">
            <ArrowUpDown size={14} className="text-[var(--text-soft)]" />
            <select value={sort} onChange={e => setSort(e.target.value as Sort)} className="rounded-lg border border-[var(--border)] bg-white h-9 px-2.5 text-xs font-bold outline-none cursor-pointer" data-testid="filter-sort">
              <option value="newest">{t('reports.sort_newest')}</option>
              <option value="savings">{t('reports.sort_savings')}</option>
              <option value="expensive">{t('reports.sort_expensive')}</option>
              <option value="findings">{t('reports.sort_findings')}</option>
            </select>
            {hasFilter && (
              <button onClick={clearAll} className="inline-flex items-center gap-1 rounded-lg bg-[var(--text)] text-white h-9 px-3 text-xs font-bold" data-testid="filter-clear">
                <X size={13} /> {t('reports.clear')}
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ── 5. MAIN FEED ─── */}
      <section className="bg-[var(--surface-soft)]" data-testid="feed-main">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-12 md:py-16">
          <div className="flex items-baseline justify-between gap-4 mb-8">
            <h2 className="text-2xl md:text-4xl font-black tracking-tight">{t('reports.count', { count: filtered.length })}</h2>
            <span className="text-sm text-[var(--text-soft)]">{t('reports.shown', { count: Math.min(shown, filtered.length) })}</span>
          </div>

          {filtered.length === 0 ? (
            <div className="rounded-3xl border border-[var(--border)] bg-white p-12 text-center">
              <div className="text-lg font-bold">{t('reports.empty_title')}</div>
              <div className="mt-2 text-sm text-[var(--text-2)]">{t('reports.empty_hint')}</div>
              <button onClick={clearAll} className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--text)] text-white h-11 px-5 text-sm font-bold">{t('reports.empty_reset')}</button>
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filtered.slice(0, shown).map(c => <FeedTile key={c.id} c={c} fmt={fmt} t={t} />)}
              </div>
              {shown < filtered.length && (
                <div className="mt-10 text-center">
                  <button onClick={() => setShown(s => s + PAGE)} className="inline-flex items-center gap-2 rounded-xl bg-[var(--text)] hover:bg-black text-white h-12 px-7 text-sm font-bold" data-testid="feed-more">
                    {t('reports.show_more', { count: Math.min(PAGE, filtered.length - shown) })} <ArrowRight size={15} />
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ── 6. LIVE INSPECTIONS ─── */}
      <section className="bg-white border-y border-[var(--border)]" data-testid="live-panel">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-14 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-7">
            <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">
              <span className="relative inline-flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" /><span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" /></span>
              {t('reports.live_now')}
            </div>
            <h2 className="mt-3 text-3xl md:text-5xl font-black tracking-tight leading-[1.05] whitespace-pre-line">{t('reports.live_title', { count: 6 })}</h2>
            <p className="mt-4 text-base text-[var(--text-2)] max-w-xl">{t('reports.live_caption')}</p>
            <Link to="/" className="mt-6 inline-flex items-center gap-1.5 text-sm font-bold">{t('reports.live_link')} <ArrowRight size={14} /></Link>
          </div>
          <div className="lg:col-span-5 grid grid-cols-2 gap-3">
            <PanelStat icon={<Activity size={16} />} value="6" label={t('reports.panel_in_work')} />
            <PanelStat icon={<Camera size={16} />}   value="3" label={t('reports.panel_onsite')} />
            <PanelStat icon={<AlertOctagon size={16} />} value="2" label={t('reports.panel_enroute')} />
            <PanelStat icon={<Euro size={16} />}     value={`€${Math.round(totalSaved / 1000)}k`} label={t('reports.panel_saved')} />
          </div>
        </div>
      </section>

      {/* ── 7. CTA ─── */}
      <section className="bg-[#0b0b0d] text-white">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 grid lg:grid-cols-12 gap-8 items-center">
          <div className="lg:col-span-8">
            <h2 className="text-3xl md:text-5xl font-black tracking-tight">{t('reports.cta_title')}</h2>
            <p className="mt-3 text-lg text-white/70 max-w-2xl">{t('reports.cta_caption', { passRate })}</p>
          </div>
          <div className="lg:col-span-4 flex flex-col sm:flex-row lg:justify-end gap-3">
            <Link to="/inspect" className="inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] px-7 h-14 text-base font-bold text-black">
              {t('reports.cta_button')} <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

// ─── COMPONENTS ──────────────────────────────────────────────────────

function ScaleStat({ value, label, highlight }: { value: string; label: string; highlight?: boolean }) {
  return (
    <div className={`rounded-2xl border p-5 md:p-6 ${highlight ? 'bg-[var(--primary)] border-[var(--primary)] text-black' : 'bg-white border-[var(--border)]'}`}>
      <div className="text-3xl md:text-5xl font-black tracking-tight leading-none">{value}</div>
      <div className="mt-2 text-[10px] md:text-xs font-bold uppercase tracking-wider opacity-70">{label}</div>
    </div>
  );
}

function ScrollBtn({ target, dir }: { target: string; dir: '-1' | '+1' }) {
  const onClick = () => {
    const el = document.getElementById(target); if (!el) return;
    el.scrollBy({ left: (dir === '+1' ? 1 : -1) * Math.round(el.clientWidth * 0.85), behavior: 'smooth' });
  };
  return (
    <button onClick={onClick} className="h-10 w-10 rounded-full border border-[var(--border)] bg-white hover:bg-[var(--surface-soft)] flex items-center justify-center" aria-label={dir === '+1' ? 'Next' : 'Prev'}>
      {dir === '+1' ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
    </button>
  );
}

function TrendCard({ c, fmt }: { c: typeof CASES[number]; fmt: (n: number) => string }) {
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group shrink-0 w-[78%] sm:w-[55%] md:w-[42%] lg:w-[33%] snap-start rounded-2xl overflow-hidden bg-[#0b0b0d] relative aspect-[4/5]" data-testid={`trend-${c.slug}`}>
      <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.04]" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>
        <ShieldCheck size={11} /> {v.short}
      </span>
      {c.saved > 0 && (
        <span className="absolute top-4 right-4 inline-flex items-center rounded-full bg-[var(--primary)] text-black px-2.5 py-1 text-[10px] font-black">
          −€{fmt(c.saved)}
        </span>
      )}
      <div className="absolute bottom-0 inset-x-0 p-5 text-white">
        <div className="text-[10px] font-black uppercase tracking-[0.18em] text-white/70">{c.city} · {c.year}</div>
        <h3 className="mt-1.5 text-xl md:text-2xl font-black tracking-tight leading-tight">{c.title}</h3>
      </div>
    </Link>
  );
}

function FeedTile({ c, fmt, t }: { c: typeof CASES[number]; fmt: (n: number) => string; t: TFn }) {
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group block rounded-2xl overflow-hidden bg-white border border-[var(--border)] hover:border-[var(--text)] transition" data-testid={`feed-tile-${c.slug}`}>
      <div className="aspect-[16/10] bg-[#0b0b0d] relative overflow-hidden">
        <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>{v.short}</span>
        {c.saved > 0 && <span className="absolute top-3 right-3 inline-flex items-center rounded-full bg-[var(--primary)] text-black px-2 py-0.5 text-[10px] font-black">−€{fmt(c.saved)}</span>}
      </div>
      <div className="p-5">
        <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--text-soft)]">{c.make} · {c.city} · {c.year}</div>
        <h3 className="mt-1.5 text-lg font-extrabold tracking-tight leading-snug">{c.title}</h3>
        <p className="mt-2 text-sm text-[var(--text-2)] line-clamp-2">{c.verdictHeadline}</p>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-[var(--text-2)]">€{fmt(c.askingPrice)}</span>
          <span className="text-xs text-[var(--text-soft)]">{t('reports.findings', { count: c.findings.length })}</span>
        </div>
      </div>
    </Link>
  );
}

function Select({ label, value, onChange, options, testid, t }: { label: string; value: string; onChange: (v: string) => void; options: string[]; testid: string; t: TFn }) {
  return (
    <div className="inline-flex items-center gap-1.5">
      <span className="text-xs font-bold text-[var(--text-soft)] hidden lg:inline">{label}:</span>
      <select value={value} onChange={e => onChange(e.target.value)} className="rounded-lg border border-[var(--border)] bg-white h-9 px-2.5 text-xs font-bold outline-none cursor-pointer max-w-[140px]" data-testid={testid}>
        {options.map(o => <option key={o} value={o}>{o === 'all' ? t('reports.filter_all_of', { label: label.toLowerCase() }) : o}</option>)}
      </select>
    </div>
  );
}

function PanelStat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-white p-5">
      <div className="text-[var(--text-soft)] inline-flex items-center gap-1.5">{icon}<span className="text-[10px] font-bold uppercase tracking-wider">{label}</span></div>
      <div className="mt-1.5 text-2xl md:text-3xl font-black tracking-tight">{value}</div>
    </div>
  );
}
