// MarketplaceHome — public marketplace surface (NOT a landing page).
// Inventory-first, feed-first, vehicle-first. Fully i18n'd (RU/DE/EN).
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, ShieldCheck, Camera, Clock, MapPin, Calendar, Gauge,
  Star, FileText, Euro, ChevronRight, Activity, Award,
} from 'lucide-react';
import { CASES, VERDICT_META } from '../../data/cases';
import { OPERATORS } from '../../data/operators';
import LinkIngestStrip from '../../components/LinkIngestStrip';

// ── Live state (synthesized; real feed plugs in later) ─────────────────
interface UnderReview {
  id: string;
  vehicle: string;
  year: number;
  city: string;
  operator: string;
  operatorSlug: string;
  status: 'enroute' | 'onsite' | 'reporting';
  startedAgoH: number;
  etaH: number;
  thumb: string;
}

const UNDER_REVIEW: UnderReview[] = [
  { id: 'r1', vehicle: 'Mercedes E450 4MATIC',     year: 2021, city: 'Berlin',     operator: 'Markus Kaufmann', operatorSlug: 'm-kaufmann-berlin', status: 'onsite',    startedAgoH: 1, etaH: 4,  thumb: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=600&q=80&auto=format&fit=crop' },
  { id: 'r2', vehicle: 'Porsche Macan S',          year: 2020, city: 'München',    operator: 'Thomas Albrecht', operatorSlug: 't-albrecht-munich', status: 'enroute',   startedAgoH: 0, etaH: 6,  thumb: 'https://images.unsplash.com/photo-1614026480209-a1d2cb37c20e?w=600&q=80&auto=format&fit=crop' },
  { id: 'r3', vehicle: 'BMW M340i xDrive',         year: 2022, city: 'Hamburg',    operator: 'Jens Weber',      operatorSlug: 'j-weber-hamburg',   status: 'reporting', startedAgoH: 5, etaH: 2,  thumb: 'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=600&q=80&auto=format&fit=crop' },
  { id: 'r4', vehicle: 'Audi RS6 Avant',           year: 2019, city: 'Frankfurt',  operator: 'Markus Kaufmann', operatorSlug: 'm-kaufmann-berlin', status: 'enroute',   startedAgoH: 0, etaH: 8,  thumb: 'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=600&q=80&auto=format&fit=crop' },
  { id: 'r5', vehicle: 'VW Golf 8 GTI',            year: 2021, city: 'Köln',       operator: 'Thomas Albrecht', operatorSlug: 't-albrecht-munich', status: 'onsite',    startedAgoH: 2, etaH: 3,  thumb: 'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=600&q=80&auto=format&fit=crop' },
  { id: 'r6', vehicle: 'Mercedes GLE Coupé',       year: 2020, city: 'Düsseldorf', operator: 'Jens Weber',      operatorSlug: 'j-weber-hamburg',   status: 'reporting', startedAgoH: 6, etaH: 1,  thumb: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=600&q=80&auto=format&fit=crop' },
];

interface Ownership {
  id: string;
  vehicle: string;
  year: number;
  city: string;
  ownedMonths: number;
  inspectionsDuringOwnership: number;
  lastInspectionMonthsAgo: number;
  thumb: string;
}

const OWNERSHIP_STORIES: Ownership[] = [
  { id: 'o1', vehicle: 'BMW X3 xDrive30d',  year: 2019, city: 'Berlin',     ownedMonths: 16, inspectionsDuringOwnership: 2, lastInspectionMonthsAgo: 7,  thumb: 'https://images.unsplash.com/photo-1542362567-b07e54358753?w=900&q=80&auto=format&fit=crop' },
  { id: 'o2', vehicle: 'VW Touareg V6 TDI', year: 2018, city: 'München',    ownedMonths: 28, inspectionsDuringOwnership: 3, lastInspectionMonthsAgo: 4,  thumb: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=900&q=80&auto=format&fit=crop' },
];

const TOTAL_SAVED = CASES.reduce((s, c) => s + c.saved, 0) + 387000;

const STATUS_DOT: Record<UnderReview['status'], string> = {
  enroute:   '#3b82f6',
  onsite:    '#10b981',
  reporting: '#f59e0b',
};

export default function MarketplaceHome() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.split('-')[0];
  const fmt = (n: number) => n.toLocaleString(locale === 'ru' ? 'ru-RU' : locale === 'de' ? 'de-DE' : 'en-US');

  const featured = CASES[0];
  const secondary = CASES[1];
  const recent = CASES;
  const savingsShowcase = CASES.filter(c => c.saved > 0).slice(0, 3);
  const liveCount = UNDER_REVIEW.length;

  return (
    <div className="bg-white" data-testid="marketplace-home">

      {/* 1. LIVE FEATURED ─────────────────────────────────────────── */}
      <section className="border-b border-[var(--border)]" data-testid="hero-live">
        <div className="mx-auto max-w-7xl px-4 md:px-6 pt-8 md:pt-10 pb-14">
          <div className="mb-6"><LinkIngestStrip /></div>

          <div className="flex flex-wrap items-baseline justify-between gap-3 mb-6">
            <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {t('home.live_label')} · {t('home.live_under_review', { count: liveCount })}
            </div>
            <Link to="/reports" className="inline-flex items-center gap-1.5 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)]">
              {t('home.all_reports')} <ChevronRight size={15} />
            </Link>
          </div>

          <div className="grid lg:grid-cols-12 gap-5">
            <PrimaryFeatured c={featured} fmt={fmt} />
            <SecondaryFeatured c={secondary} fmt={fmt} />
          </div>
        </div>
      </section>

      {/* 2. RECENT INSPECTIONS ────────────────────────────────────── */}
      <section className="bg-[var(--surface-soft)]" data-testid="feed-recent">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div className="max-w-2xl">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('home.recent_label')}</span>
              <h2 className="mt-3 text-4xl md:text-6xl font-black tracking-tight leading-[1.05] whitespace-pre-line">{t('home.recent_title')}</h2>
            </div>
            <Link to="/reports" className="hidden md:inline-flex items-center gap-1.5 text-sm font-bold">{t('home.open_archive')} <ArrowRight size={15} /></Link>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
            {recent.map(c => <CaseTile key={c.id} c={c} fmt={fmt} />)}
          </div>
        </div>
      </section>

      {/* 3. SAVINGS SHOWCASE ──────────────────────────────────────── */}
      <section className="bg-[#0b0b0d] text-white" data-testid="savings">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 md:py-28">
          <div className="grid lg:grid-cols-12 gap-12 items-end mb-14">
            <div className="lg:col-span-7">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-white/50">{t('home.saved_label')}</span>
              <div className="mt-4 text-7xl md:text-[10rem] font-black tracking-tight leading-none text-[var(--primary)]">
                €{(TOTAL_SAVED / 1000).toFixed(0)}k
              </div>
              <p className="mt-5 max-w-xl text-base md:text-lg text-white/65">{t('home.saved_caption')}</p>
            </div>
            <div className="lg:col-span-5 grid grid-cols-3 gap-3">
              <BlockMetric value={String(CASES.length + 47)} label={t('home.metric_reports')} />
              <BlockMetric value={String(OPERATORS.length + 9)}  label={t('home.metric_inspectors')} />
              <BlockMetric value="4" label={t('home.metric_cities')} />
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-4">
            {savingsShowcase.map(c => <SavingsCard key={c.id} c={c} fmt={fmt} t={t} />)}
          </div>
        </div>
      </section>

      {/* 4. INSPECTORS ────────────────────────────────────────────── */}
      <section className="bg-white border-t border-[var(--border)]" data-testid="inspectors-row">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div className="max-w-2xl">
              <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('home.experts_label')}</span>
              <h2 className="mt-3 text-4xl md:text-6xl font-black tracking-tight leading-[1.05]">{t('home.experts_title')}</h2>
              <p className="mt-4 text-base md:text-lg text-[var(--text-2)] max-w-2xl">{t('home.experts_caption')}</p>
            </div>
            <Link to="/specialists" className="hidden md:inline-flex items-center gap-1.5 text-sm font-bold">{t('home.all_experts')} <ArrowRight size={15} /></Link>
          </div>
          <div className="grid md:grid-cols-3 gap-5">
            {OPERATORS.map(o => <OperatorTile key={o.slug} o={o} t={t} />)}
          </div>
        </div>
      </section>

      {/* 5. UNDER REVIEW ──────────────────────────────────────────── */}
      <section className="bg-[var(--surface-soft)]" data-testid="under-review">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="flex items-end justify-between gap-4 mb-10">
            <div>
              <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                {t('home.now_label')}
              </div>
              <h2 className="mt-3 text-4xl md:text-6xl font-black tracking-tight leading-[1.05]">{t('home.now_title', { count: liveCount })}</h2>
            </div>
          </div>

          <div className="rounded-3xl border border-[var(--border)] bg-white overflow-hidden">
            <ul className="divide-y divide-[var(--border)]">
              {UNDER_REVIEW.map(r => <UnderReviewRow key={r.id} r={r} t={t} />)}
            </ul>
          </div>
        </div>
      </section>

      {/* 6. OWNERSHIP STORIES ─────────────────────────────────────── */}
      <section className="bg-white border-y border-[var(--border)]" data-testid="ownership">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20">
          <div className="max-w-3xl mb-10">
            <span className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('home.ownership_label')}</span>
            <h2 className="mt-3 text-4xl md:text-6xl font-black tracking-tight leading-[1.05] whitespace-pre-line">{t('home.ownership_title')}</h2>
            <p className="mt-4 text-base md:text-lg text-[var(--text-2)] max-w-2xl">{t('home.ownership_caption')}</p>
          </div>
          <div className="grid md:grid-cols-2 gap-5">
            {OWNERSHIP_STORIES.map(s => <OwnershipCard key={s.id} s={s} t={t} />)}
          </div>
        </div>
      </section>

      {/* 7. CONVERSION CTAs ───────────────────────────────────────── */}
      <section className="bg-[#0b0b0d] text-white" data-testid="cta-pair">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-20 grid md:grid-cols-2 gap-4">
          <div className="rounded-3xl bg-white text-[var(--text)] p-8 md:p-12">
            <div className="text-xs font-black uppercase tracking-[0.18em] text-[var(--text-soft)]">{t('home.cta_buyer_label')}</div>
            <h3 className="mt-4 text-3xl md:text-5xl font-black tracking-tight leading-[1.05] whitespace-pre-line">{t('home.cta_buyer_title')}</h3>
            <p className="mt-5 text-base text-[var(--text-2)]">{t('home.cta_buyer_caption')}</p>
            <Link to="/inspect" className="mt-8 inline-flex items-center justify-center gap-2 rounded-xl bg-[var(--primary)] hover:bg-[#facc15] h-14 px-7 text-base font-bold text-black" data-testid="home-cta-buyer">
              {t('home.cta_buyer_button')} <ArrowRight size={18} />
            </Link>
          </div>
          <div className="rounded-3xl bg-[#1a1a1d] p-8 md:p-12">
            <div className="text-xs font-black uppercase tracking-[0.18em] text-white/50">{t('home.cta_operator_label')}</div>
            <h3 className="mt-4 text-3xl md:text-5xl font-black tracking-tight leading-[1.05] text-white whitespace-pre-line">{t('home.cta_operator_title')}</h3>
            <p className="mt-5 text-base text-white/70">{t('home.cta_operator_caption')}</p>
            <Link to="/provider/onboarding" className="mt-8 inline-flex items-center justify-center gap-2 rounded-xl border border-white/40 hover:bg-white/10 h-14 px-7 text-base font-bold text-white" data-testid="home-cta-operator">
              {t('home.cta_operator_button')} <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}

type CaseT = typeof CASES[number];
type TFn = (k: string, opts?: any) => string;
type FmtFn = (n: number) => string;

// ─── COMPONENTS ──────────────────────────────────────────────────────

function PrimaryFeatured({ c, fmt }: { c: CaseT; fmt: FmtFn }) {
  const { t } = useTranslation();
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group lg:col-span-8 block rounded-3xl overflow-hidden bg-[#0b0b0d] relative aspect-[16/10] lg:aspect-auto" data-testid="hero-primary">
      <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.04]" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <div className="absolute top-6 left-6 right-6 flex items-start justify-between gap-3">
        <span className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>
          <ShieldCheck size={13} /> {v.short}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 backdrop-blur px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white/90">
          Featured · {c.country} · {c.city}
        </span>
      </div>
      <div className="absolute bottom-6 left-6 right-6 lg:bottom-10 lg:left-10 lg:right-10 text-white">
        <h2 className="text-3xl md:text-5xl lg:text-6xl font-black tracking-tight leading-[1.05] max-w-3xl">{c.title}</h2>
        <p className="mt-3 max-w-2xl text-base md:text-lg text-white/80 line-clamp-2">{c.verdictHeadline}. {c.verdictSummary.split('.')[0]}.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          {c.saved > 0 && (
            <span className="inline-flex items-center gap-2 rounded-full bg-[var(--primary)] text-black px-3.5 py-1.5 text-sm font-black">
              {t('home.saved_amount', { amount: fmt(c.saved) })}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 text-sm text-white/70"><Calendar size={13} /> {c.year}</span>
          <span className="inline-flex items-center gap-1.5 text-sm text-white/70"><Gauge size={13} /> {fmt(c.km)} km</span>
          <span className="ml-auto hidden md:inline-flex items-center gap-1.5 text-sm font-bold text-white">{t('home.open_case')} <ArrowRight size={15} className="transition-transform group-hover:translate-x-1" /></span>
        </div>
      </div>
    </Link>
  );
}

function SecondaryFeatured({ c, fmt }: { c: CaseT; fmt: FmtFn }) {
  const { t } = useTranslation();
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group lg:col-span-4 block rounded-3xl overflow-hidden bg-[#0b0b0d] relative aspect-[16/10] lg:aspect-auto flex flex-col" data-testid="hero-secondary">
      <div className="relative aspect-[16/10] lg:aspect-[4/3] shrink-0 overflow-hidden">
        <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.04]" />
        <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>
          <ShieldCheck size={11} /> {v.short}
        </span>
      </div>
      <div className="flex-1 bg-white text-[var(--text)] p-6 md:p-7 flex flex-col">
        <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--text-soft)]">{c.city} · {c.year} · {fmt(c.km)} km</div>
        <h3 className="mt-2 text-xl md:text-2xl font-black tracking-tight leading-tight">{c.title}</h3>
        <p className="mt-2 text-sm text-[var(--text-2)] line-clamp-2">{c.verdictHeadline}</p>
        <div className="mt-auto pt-5 flex items-center justify-between">
          {c.saved > 0 ? (
            <span className="inline-flex items-center gap-1 text-sm font-extrabold text-emerald-700">
              <Euro size={14} /> {t('home.saved_amount', { amount: fmt(c.saved) })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-sm font-extrabold text-emerald-700">
              <ShieldCheck size={14} /> {t('home.case_pass')}
            </span>
          )}
          <ArrowRight size={16} className="text-[var(--text-soft)] transition-transform group-hover:translate-x-0.5" />
        </div>
      </div>
    </Link>
  );
}

function CaseTile({ c, fmt }: { c: CaseT; fmt: FmtFn }) {
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group block rounded-2xl overflow-hidden bg-white border border-[var(--border)] hover:border-[var(--text)] transition" data-testid={`tile-${c.slug}`}>
      <div className="aspect-[4/3] bg-[#0b0b0d] relative overflow-hidden">
        <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.03]" />
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>
          {v.short}
        </span>
      </div>
      <div className="p-5">
        <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--text-soft)]">{c.city} · {c.year}</div>
        <h3 className="mt-1.5 text-lg font-extrabold tracking-tight leading-snug">{c.title}</h3>
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-[var(--text-2)]">€{fmt(c.askingPrice)}</span>
          {c.saved > 0 && <span className="font-bold text-emerald-700">−€{fmt(c.saved)}</span>}
        </div>
      </div>
    </Link>
  );
}

function SavingsCard({ c, fmt, t }: { c: CaseT; fmt: FmtFn; t: TFn }) {
  const v = VERDICT_META[c.verdict];
  return (
    <Link to={`/case/${c.slug}`} className="group block rounded-2xl overflow-hidden bg-[#1a1a1d] border border-white/10 hover:border-[var(--primary)] transition">
      <div className="aspect-[16/10] relative overflow-hidden">
        <img src={c.heroImage} alt={c.title} className="absolute inset-0 w-full h-full object-cover opacity-90 transition-transform duration-700 group-hover:scale-[1.03]" />
        <span className="absolute top-3 left-3 inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-white" style={{ background: v.accent }}>{v.short}</span>
      </div>
      <div className="p-5">
        <div className="text-[11px] font-black uppercase tracking-wider text-white/40">{c.city} · {c.year}</div>
        <h3 className="mt-1.5 text-base font-extrabold leading-snug text-white">{c.title}</h3>
        {c.saved > 0 && (
          <div className="mt-4 inline-flex items-center gap-1 rounded-full bg-[var(--primary)] text-black px-3 py-1 text-xs font-black">
            {t('home.saved_amount', { amount: fmt(c.saved) })}
          </div>
        )}
      </div>
    </Link>
  );
}

function OperatorTile({ o, t }: { o: typeof OPERATORS[number]; t: TFn }) {
  return (
    <Link to={`/operator/${o.slug}`} className="group block rounded-3xl overflow-hidden bg-white border border-[var(--border)] hover:border-[var(--text)] transition" data-testid={`op-tile-${o.slug}`}>
      <div className="aspect-[4/5] bg-[#0b0b0d] relative overflow-hidden">
        <img src={o.portrait} alt={o.name} className="absolute inset-0 w-full h-full object-cover transition-transform duration-[1200ms] group-hover:scale-[1.03]" />
        <span className="absolute top-4 left-4 inline-flex items-center gap-1.5 rounded-full bg-[var(--primary)] px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-black">
          <Award size={11} /> TÜV
        </span>
        <div className="absolute inset-x-0 bottom-0 p-5 bg-gradient-to-t from-black/85 to-transparent">
          <div className="text-[11px] font-black uppercase tracking-[0.16em] text-white/70">{o.cities[0]}</div>
          <h3 className="mt-1 text-2xl md:text-3xl font-black tracking-tight text-white">{o.name}</h3>
        </div>
      </div>
      <div className="p-5 grid grid-cols-3 gap-2">
        <SmallMetric value={String(o.inspectionsCount)} label={t('home.inspections_label')} />
        <SmallMetric value={`€${(o.savedTotalEur / 1000).toFixed(0)}k`} label={t('home.saved_short')} highlight />
        <SmallMetric value={o.ratingAvg.toFixed(1)} label={t('home.rating_label')} icon={<Star size={11} className="text-[var(--primary)]" fill="currentColor" />} />
      </div>
    </Link>
  );
}

function SmallMetric({ value, label, highlight, icon }: { value: string; label: string; highlight?: boolean; icon?: React.ReactNode }) {
  return (
    <div className="text-center rounded-lg bg-[var(--surface-soft)] py-2.5 px-2">
      <div className={`text-base font-black inline-flex items-center justify-center gap-1 ${highlight ? 'text-[var(--text)]' : 'text-[var(--text)]'}`}>
        {icon}{value}
      </div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
    </div>
  );
}

function UnderReviewRow({ r, t }: { r: UnderReview; t: TFn }) {
  const dotColor = STATUS_DOT[r.status];
  const statusLabel = t(`home.status_${r.status}`);
  return (
    <li className="flex items-center gap-4 p-4 md:p-5 hover:bg-[var(--surface-soft)] transition" data-testid={`live-${r.id}`}>
      <div className="h-14 w-20 md:h-16 md:w-24 rounded-xl overflow-hidden bg-[#0b0b0d] shrink-0">
        <img src={r.thumb} alt="" className="w-full h-full object-cover" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-black uppercase tracking-wider text-[var(--text-soft)]">{r.year} · {r.city}</div>
        <div className="mt-0.5 text-base md:text-lg font-extrabold truncate">{r.vehicle}</div>
        <div className="mt-1 text-xs text-[var(--text-soft)]">
          {t('home.inspector_label')}: <Link to={`/operator/${r.operatorSlug}`} className="font-bold text-[var(--text-2)] hover:text-[var(--text)]">{r.operator}</Link>
        </div>
      </div>
      <div className="hidden md:flex flex-col items-end shrink-0">
        <div className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider" style={{ color: dotColor }}>
          <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
          {statusLabel}
        </div>
        <div className="mt-1 text-[11px] text-[var(--text-soft)] inline-flex items-center gap-1"><Clock size={11} /> {t('home.eta_to_report', { hours: r.etaH })}</div>
      </div>
      <span className="md:hidden h-2.5 w-2.5 rounded-full shrink-0" style={{ background: dotColor }} title={statusLabel} />
    </li>
  );
}

function OwnershipCard({ s, t }: { s: Ownership; t: TFn }) {
  const yrs = (s.ownedMonths / 12).toFixed(1);
  return (
    <div className="rounded-3xl overflow-hidden bg-[var(--surface-soft)] grid md:grid-cols-12" data-testid={`own-${s.id}`}>
      <div className="md:col-span-5 aspect-[16/10] md:aspect-auto bg-[#0b0b0d] relative overflow-hidden">
        <img src={s.thumb} alt="" className="absolute inset-0 w-full h-full object-cover" />
      </div>
      <div className="md:col-span-7 p-6 md:p-8">
        <div className="text-[11px] font-black uppercase tracking-[0.16em] text-[var(--text-soft)]">{s.city} · {s.year}</div>
        <h3 className="mt-2 text-xl md:text-2xl font-black tracking-tight">{s.vehicle}</h3>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <MiniStat value={t('home.owned_for_years', { years: yrs })} label={t('home.owned_label')} />
          <MiniStat value={String(s.inspectionsDuringOwnership)} label={t('home.inspections_label')} />
          <MiniStat value={t('home.last_inspection_months', { months: s.lastInspectionMonthsAgo })} label={t('home.last_inspection_label')} />
        </div>
        <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-white border border-[var(--border)] px-3 py-1 text-[11px] font-black uppercase tracking-wider text-[var(--text-soft)]">
          <Activity size={11} /> {t('home.vehicle_memory_soon')}
        </div>
      </div>
    </div>
  );
}

function MiniStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-lg bg-white p-3">
      <div className="text-base font-black tracking-tight">{value}</div>
      <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{label}</div>
    </div>
  );
}

function BlockMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-4 md:p-5">
      <div className="text-3xl md:text-4xl font-black tracking-tight text-white">{value}</div>
      <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wider text-white/50">{label}</div>
    </div>
  );
}
