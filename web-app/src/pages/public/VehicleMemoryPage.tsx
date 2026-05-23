/**
 * VehicleMemoryPage — public /vehicle/:id.
 *
 * This is NOT a report page. /case/:id renders one event;
 * /vehicle/:id renders the **digital life** of a single car.
 *
 * Layers (top → bottom of the page):
 *   1. Hero · large image + identity + verdict pill
 *   2. Ownership console · Apple-Wallet style strip (mileage, owned for,
 *      TÜV, insurance, value)
 *   3. Memory timeline · vertical, year-grouped, Notion-archive feel
 *   4. Inspection cases · multi-report layering
 *   5. Comparative intelligence · model-level statistics (sidebar)
 *   6. Documents · expirable artefacts
 *   7. Operators · lineage of people who touched this car
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Car, AlertTriangle, AlertCircle, CheckCircle2,
  Shield, FileText, Wrench, Clock, Calendar, Tag, CreditCard,
  TrendingDown, TrendingUp, Users, MapPin, Globe, AlertOctagon, Truck,
  ScrollText, BookOpen, EyeOff, RotateCcw, Gauge, Bell,
} from 'lucide-react';
import { api } from '../../services/api';
import WatchToggle from '../../components/WatchToggle';
import SaveSearchModal from '../../components/SaveSearchModal';
import { vehicleToFilter, similarHeadline, similarSubline } from '../../lib/vehicleToFilter';
import { track } from '../../lib/telemetry';

// ─────────────────────────────────────────────────────────────────
// Wire types
// ─────────────────────────────────────────────────────────────────

interface Operator {
  id: string;
  name: string;
  rating?: number;
  city?: string;
  avatar?: string;
  totalInspections?: number;
  interactions?: number;
  lastInteractionAt?: string;
}

interface Finding { label: string; severity?: string; }

interface Report {
  id: string;
  submittedAt: string;
  verdict: string;
  verdictLabel: string;
  verdictTone: 'success' | 'warning' | 'danger' | 'info';
  score?: number;
  summary?: string;
  savingsEur?: number;
  operator?: Operator;
  thumbnail?: string;
  mileageAt?: number;
  findings?: Finding[];
  city?: string;
}

interface TimelineItem {
  id: string;
  atIso: string;
  kind: string;
  severity: string;
  title: string;
  body?: string;
  operator?: Operator;
  savingsEur?: number;
  mileage?: number;
  costEur?: number;
  amountEur?: number;
  reportId?: string;
}

interface DocumentItem {
  id: string;
  kind: string;
  label: string;
  issuer?: string;
  issuedAtIso?: string;
  expiresAtIso?: string;
  daysLeft?: number;
  status: 'valid' | 'expiring' | 'expired';
  documentNumber?: string;
}

interface VehicleMemory {
  vehicle: {
    id: string;
    brand: string;
    model: string;
    trim?: string;
    year?: number;
    mileage?: number;
    price?: number;
    currency?: string;
    location?: string;
    fuel?: string;
    transmission?: string;
    color?: string;
    engine?: string;
    bodyType?: string;
    thumbnail?: string;
    gallery?: string[];
    vinTail?: string;
    registeredCountry?: string;
    importedFrom?: string;
    importedOn?: string;
    ownedSince?: string;
  };
  verdict: {
    label: string;
    tone: 'success' | 'warning' | 'danger' | 'info';
    score?: number;
    summary?: string;
    lastInspectionAt?: string;
    totalInspections: number;
  };
  ownership: {
    mileageNow?: number;
    ownedSinceIso?: string;
    monthsOwned?: number;
    tuvUntilIso?: string;
    tuvDaysLeft?: number;
    insuranceUntilIso?: string;
    insuranceDaysLeft?: number;
    purchasePriceEur?: number;
    estimatedValueEur?: number;
    estimatedDeltaEur?: number;
    totalSpentEur?: number;
  };
  timeline: TimelineItem[];
  reports: Report[];
  comparative: {
    modelKey: string;
    totalCases: number;
    riskRate: number;
    rejectRate: number;
    passRate: number;
    avgSavingsEur: number;
    topFindings: { label: string; occurrences: number; percent: number }[];
  };
  documents: DocumentItem[];
  operators: Operator[];
  valueTrajectory: { monthIso: string; eur: number }[];
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function fmtEur(v?: number | null): string {
  if (v == null) return '—';
  return `€${v.toLocaleString('de-DE')}`;
}
function fmtKm(v?: number | null): string {
  if (v == null) return '—';
  return `${v.toLocaleString('de-DE')} км`;
}
function fmtMonths(months?: number): string {
  if (!months || months <= 0) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y && m) return `${y} г · ${m} мес`;
  if (y) return `${y} ${y === 1 ? 'год' : y < 5 ? 'года' : 'лет'}`;
  return `${m} мес`;
}
function fmtDays(days?: number | null): string {
  if (days == null) return '—';
  if (days < 0) return `просрочено ${Math.abs(days)} дн`;
  if (days === 0) return 'истекает сегодня';
  if (days < 30) return `${days} дн`;
  if (days < 365) return `${Math.floor(days / 30)} мес`;
  return `${Math.floor(days / 365)} г · ${Math.floor((days % 365) / 30)} мес`;
}
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch { return iso; }
}
function yearOf(iso?: string | null): string {
  if (!iso) return '—';
  try { return String(new Date(iso).getFullYear()); } catch { return '—'; }
}
function monthOf(iso?: string | null): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('ru-RU', { month: 'long' }); } catch { return ''; }
}

const KIND_ICON_MAP: Record<string, React.ReactNode> = {
  imported: <Truck size={14} />,
  import: <Truck size={14} />,
  purchased: <Tag size={14} />,
  ownership_started: <Tag size={14} />,
  saved: <Tag size={14} />,
  inspection: <FileText size={14} />,
  inspection_completed: <FileText size={14} />,
  inspection_requested: <FileText size={14} />,
  mileage_anomaly: <AlertOctagon size={14} />,
  repair: <Wrench size={14} />,
  repair_required: <Wrench size={14} />,
  service: <Wrench size={14} />,
  tuv_passed: <Shield size={14} />,
  tuv_renewal: <Shield size={14} />,
  insurance_renewed: <Shield size={14} />,
  documents_updated: <ScrollText size={14} />,
  payment: <CreditCard size={14} />,
  recall: <AlertOctagon size={14} />,
  // ── Temporal evolution events (refresh worker) ──────────────────
  price_drop: <TrendingDown size={14} />,
  price_increase: <TrendingUp size={14} />,
  mileage_update: <Gauge size={14} />,
  listing_disappeared: <EyeOff size={14} />,
  relisted: <RotateCcw size={14} />,
  viewed: <Clock size={14} />,
};

function severityBg(severity: string): string {
  switch (severity) {
    case 'success': return 'rgba(34,197,94,0.10)';
    case 'warning': return 'rgba(255,176,32,0.12)';
    case 'danger':  return 'rgba(239,68,68,0.12)';
    default:        return 'rgba(125,211,252,0.10)';
  }
}
function severityFg(severity: string): string {
  switch (severity) {
    case 'success': return '#22C55E';
    case 'warning': return '#FFB020';
    case 'danger':  return '#EF4444';
    default:        return '#7DD3FC';
  }
}
function verdictBg(tone: string): string {
  switch (tone) {
    case 'success': return 'linear-gradient(135deg, #22C55E 0%, #16A34A 100%)';
    case 'warning': return 'linear-gradient(135deg, #FFB020 0%, #F97316 100%)';
    case 'danger':  return 'linear-gradient(135deg, #EF4444 0%, #B91C1C 100%)';
    default:        return 'linear-gradient(135deg, #7DD3FC 0%, #0EA5E9 100%)';
  }
}

// ─────────────────────────────────────────────────────────────────
// Sparkline (no library — minimal SVG path)
// ─────────────────────────────────────────────────────────────────

function ValueSparkline({ data }: { data: { monthIso: string; eur: number }[] }) {
  if (!data || data.length < 2) return null;
  const w = 280, h = 64;
  const ys = data.map(d => d.eur);
  const min = Math.min(...ys), max = Math.max(...ys);
  const span = max - min || 1;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((d.eur - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = `M ${pts.join(' L ')}`;
  const areaPath = `${linePath} L ${w},${h} L 0,${h} Z`;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="vsl-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FFB020" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#FFB020" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#vsl-grad)" />
      <path d={linePath} fill="none" stroke="#FFB020" strokeWidth="1.5" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────

export default function VehicleMemoryPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [data, setData] = useState<VehicleMemory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribeOpen, setSubscribeOpen] = useState(false);
  // Telemetry: ensure we count one vehicle_view per (mounted vehicleId), not per render.
  const viewedRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.get(`/public/vehicles/${id}/memory`);
        if (!cancelled) {
          const memory = res.data as VehicleMemory;
          setData(memory);
          // Telemetry: vehicle_view (once per id within this mount cycle)
          if (id && viewedRef.current !== id) {
            viewedRef.current = id;
            track('vehicle_view', {
              vehicleId: memory.vehicle.id,
              brand: memory.vehicle.brand,
              model: memory.vehicle.model,
              year: memory.vehicle.year,
            });
          }
        }
      } catch (e: unknown) {
        if (!cancelled) {
          const status = (e as { response?: { status?: number } }).response?.status;
          setError(status === 404 ? 'Авто не найдено' : 'Не удалось загрузить машину');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center" data-testid="vehicle-memory-loading">
        <div className="animate-spin rounded-full h-9 w-9 border-b-2 border-yellow-400" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-12" data-testid="vehicle-memory-error">
        <Link to="/" className="btn-secondary btn-sm mb-4 inline-flex items-center">
          <ArrowLeft size={12} /> Главная
        </Link>
        <div className="card text-center py-16">
          <AlertCircle size={36} className="mx-auto mb-3" style={{ color: '#FFB020' }} />
          <h3 className="font-display tracking-bebas text-2xl mb-1">{error ?? 'Ошибка'}</h3>
        </div>
      </div>
    );
  }

  const { vehicle: v, verdict, ownership, timeline, reports, comparative, documents, operators, valueTrajectory } = data;

  // Group timeline by year (newest year first).
  const byYear: Record<string, TimelineItem[]> = {};
  timeline.forEach(it => {
    const y = yearOf(it.atIso);
    (byYear[y] = byYear[y] || []).push(it);
  });
  const years = Object.keys(byYear).sort().reverse();

  return (
    <div className="bg-[#0A0A0A] text-white min-h-screen" data-testid="vehicle-memory">
      {/* ── HERO ─────────────────────────────────────────────────── */}
      <div className="relative">
        <div className="absolute inset-0 -z-10 overflow-hidden">
          {v.thumbnail && (
            <img
              src={v.thumbnail}
              alt={`${v.brand} ${v.model}`}
              className="w-full h-full object-cover opacity-60"
              style={{ filter: 'saturate(1.05)' }}
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(180deg, rgba(10,10,10,0.45) 0%, rgba(10,10,10,0.78) 55%, #0A0A0A 100%)',
            }}
          />
        </div>

        <div className="max-w-[1200px] mx-auto px-4 lg:px-8 pt-6 pb-10">
          <Link to="/" className="text-2xs uppercase tracking-widest inline-flex items-center gap-1 text-white/70 hover:text-white" data-testid="vehicle-memory-back">
            <ArrowLeft size={12} /> К поиску
          </Link>

          <div className="mt-8 flex flex-col md:flex-row md:items-end md:justify-between gap-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-2xs uppercase tracking-[0.2em] text-white/60 mb-3">
                <span>VEHICLE MEMORY</span>
                <span>·</span>
                <span data-testid="vehicle-memory-id">{v.id.slice(-12)}</span>
                {v.registeredCountry && (
                  <>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1"><Globe size={11} /> {v.registeredCountry}</span>
                  </>
                )}
              </div>
              <h1 className="font-display tracking-bebas text-[44px] sm:text-[64px] leading-[0.92]">
                {v.brand} <span className="text-amber">{v.model}</span>
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-white/80" data-testid="vehicle-identity-line">
                {v.year && <span>{v.year}</span>}
                {v.trim && <span>· {v.trim}</span>}
                {v.engine && <span>· {v.engine}</span>}
                {v.transmission && <span>· {v.transmission}</span>}
                {v.color && <span>· {v.color}</span>}
                {v.location && (
                  <span className="inline-flex items-center gap-1"><MapPin size={12} /> {v.location}</span>
                )}
                {v.vinTail && <span>· VIN …{v.vinTail}</span>}
              </div>
            </div>

            {/* Verdict pill + Watch */}
            <div className="shrink-0 flex items-center gap-3">
              <WatchToggle vehicleId={v.id} />
              <div
                className="inline-flex items-center gap-3 px-5 py-3 rounded-2xl shadow-2xl"
                style={{ background: verdictBg(verdict.tone), boxShadow: '0 10px 40px rgba(0,0,0,.45)' }}
                data-testid="vehicle-verdict"
              >
                {verdict.tone === 'success' && <CheckCircle2 size={22} />}
                {verdict.tone === 'warning' && <AlertTriangle size={22} />}
                {verdict.tone === 'danger'  && <AlertCircle  size={22} />}
                <div>
                  <div className="font-display tracking-bebas text-[28px] leading-none">{verdict.label}</div>
                  <div className="text-2xs opacity-90 mt-1">
                    {verdict.totalInspections} {verdict.totalInspections === 1 ? 'осмотр' : 'осмотров'}
                    {verdict.score != null && ` · ${verdict.score}/100`}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* ── OWNERSHIP CONSOLE (Apple Wallet strip) ───────────── */}
          <div
            className="mt-9 grid grid-cols-2 md:grid-cols-4 gap-3"
            data-testid="ownership-console"
          >
            <OwnershipCard
              label="Пробег"
              value={fmtKm(ownership.mileageNow)}
              hint={ownership.ownedSinceIso ? `на ${fmtDate(new Date().toISOString())}` : undefined}
              icon={<Wrench size={14} />}
            />
            <OwnershipCard
              label="Во владении"
              value={fmtMonths(ownership.monthsOwned)}
              hint={ownership.ownedSinceIso ? `с ${fmtDate(ownership.ownedSinceIso)}` : 'не указано'}
              icon={<Calendar size={14} />}
            />
            <OwnershipCard
              label="TÜV"
              value={ownership.tuvDaysLeft != null ? fmtDays(ownership.tuvDaysLeft) : '—'}
              hint={ownership.tuvUntilIso ? `до ${fmtDate(ownership.tuvUntilIso)}` : 'не указан'}
              icon={<Shield size={14} />}
              tone={
                ownership.tuvDaysLeft != null && ownership.tuvDaysLeft < 0 ? 'danger' :
                ownership.tuvDaysLeft != null && ownership.tuvDaysLeft <= 60 ? 'warning' : 'success'
              }
            />
            <OwnershipCard
              label="Оценка"
              value={fmtEur(ownership.estimatedValueEur)}
              hint={
                ownership.estimatedDeltaEur != null
                  ? `${ownership.estimatedDeltaEur >= 0 ? '+' : ''}${fmtEur(ownership.estimatedDeltaEur)} с покупки`
                  : ownership.purchasePriceEur ? `куплено за ${fmtEur(ownership.purchasePriceEur)}` : undefined
              }
              icon={<TrendingDown size={14} />}
              tone={(ownership.estimatedDeltaEur ?? 0) < 0 ? 'warning' : 'info'}
            />
          </div>
        </div>
      </div>

      {/* ── MAIN GRID ────────────────────────────────────────────── */}
      <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-10">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-8">
          {/* ── LEFT COLUMN ──────────────────────────────────────── */}
          <div className="min-w-0 space-y-10">

            {/* MEMORY TIMELINE — vertical, year-grouped, archive feel */}
            <section data-testid="memory-timeline">
              <div className="flex items-baseline justify-between mb-5">
                <div>
                  <div className="text-2xs uppercase tracking-[0.2em] text-white/40">MEMORY</div>
                  <h2 className="font-display tracking-bebas text-3xl mt-1">Хронология жизни</h2>
                </div>
                <div className="text-2xs text-white/40">{timeline.length} событий</div>
              </div>

              {timeline.length === 0 ? (
                <div className="rounded-xl py-12 text-center text-white/50 text-sm" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  События появятся, как только машина пройдёт первый осмотр.
                </div>
              ) : (
                <div className="relative">
                  {/* spine */}
                  <div className="absolute left-[15px] top-2 bottom-2 w-px bg-white/10" />
                  {years.map(y => (
                    <div key={y} className="relative pl-12 mb-7">
                      <div className="text-2xs uppercase tracking-[0.2em] text-white/40 mb-3 -ml-12 pl-12">{y}</div>
                      <ol className="space-y-3">
                        {byYear[y].map(it => (
                          <li key={it.id} className="relative" data-testid={`timeline-${it.kind}`}>
                            {/* dot */}
                            <div
                              className="absolute -left-[39px] top-3 w-[14px] h-[14px] rounded-full ring-4 ring-[#0A0A0A]"
                              style={{ background: severityFg(it.severity) }}
                            />
                            <article
                              className="rounded-xl p-4"
                              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                            >
                              <div className="flex items-start gap-3">
                                <span
                                  className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
                                  style={{ background: severityBg(it.severity), color: severityFg(it.severity) }}
                                >
                                  {KIND_ICON_MAP[it.kind] || <Wrench size={14} />}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                                    <span className="font-semibold text-[15px]">{it.title}</span>
                                    <span className="text-2xs text-white/40">
                                      {monthOf(it.atIso)} · {fmtDate(it.atIso)}
                                    </span>
                                  </div>
                                  {it.body && (
                                    <p className="text-xs leading-relaxed mt-1.5 text-white/70">{it.body}</p>
                                  )}
                                  <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-white/60">
                                    {it.mileage != null && (
                                      <span className="inline-flex items-center gap-1">
                                        <Wrench size={11} /> {fmtKm(it.mileage)}
                                      </span>
                                    )}
                                    {it.savingsEur != null && it.savingsEur > 0 && (
                                      <span className="inline-flex items-center gap-1 text-amber">
                                        <Tag size={11} /> сэкономлено {fmtEur(it.savingsEur)}
                                      </span>
                                    )}
                                    {it.costEur != null && it.costEur > 0 && (
                                      <span className="inline-flex items-center gap-1">
                                        <CreditCard size={11} /> {fmtEur(it.costEur)}
                                      </span>
                                    )}
                                    {it.amountEur != null && (
                                      <span className="inline-flex items-center gap-1">
                                        <CreditCard size={11} /> {fmtEur(it.amountEur)}
                                      </span>
                                    )}
                                    {it.operator && (
                                      <span className="inline-flex items-center gap-1">
                                        <Users size={11} /> {it.operator.name}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            </article>
                          </li>
                        ))}
                      </ol>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* INSPECTION CASES — multi-report layering */}
            {reports.length > 0 && (
              <section data-testid="multi-report-stack">
                <div className="flex items-baseline justify-between mb-5">
                  <div>
                    <div className="text-2xs uppercase tracking-[0.2em] text-white/40">INSPECTIONS</div>
                    <h2 className="font-display tracking-bebas text-3xl mt-1">Слои осмотров</h2>
                  </div>
                  <div className="text-2xs text-white/40">{reports.length} {reports.length === 1 ? 'отчёт' : 'отчётов'}</div>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  {reports.map(r => (
                    <article
                      key={r.id}
                      className="rounded-2xl overflow-hidden relative group"
                      style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                      data-testid={`report-card-${r.id}`}
                    >
                      <div className="relative h-44 overflow-hidden">
                        {r.thumbnail ? (
                          <img src={r.thumbnail} alt={r.id} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-white/5">
                            <Car size={48} className="text-white/20" />
                          </div>
                        )}
                        <div className="absolute top-3 left-3">
                          <span
                            className="px-3 py-1 rounded-full text-2xs font-bold tracking-widest"
                            style={{ background: verdictBg(r.verdictTone), boxShadow: '0 4px 12px rgba(0,0,0,.35)' }}
                          >
                            {r.verdictLabel}
                            {r.score != null && ` · ${r.score}`}
                          </span>
                        </div>
                        {r.savingsEur != null && r.savingsEur > 0 && (
                          <div className="absolute top-3 right-3 px-3 py-1 rounded-full text-2xs font-bold bg-amber text-black">
                            −{fmtEur(r.savingsEur)}
                          </div>
                        )}
                      </div>

                      <div className="p-4">
                        <div className="flex items-baseline justify-between text-2xs text-white/50">
                          <span>{fmtDate(r.submittedAt)}</span>
                          {r.mileageAt != null && <span>{fmtKm(r.mileageAt)}</span>}
                        </div>
                        {r.summary && (
                          <p className="text-sm leading-relaxed mt-2 text-white/85 line-clamp-3">{r.summary}</p>
                        )}
                        {r.findings && r.findings.length > 0 && (
                          <ul className="mt-3 space-y-1">
                            {r.findings.slice(0, 4).map((f, i) => (
                              <li key={i} className="flex items-center gap-2 text-2xs text-white/70">
                                <span
                                  className="w-1.5 h-1.5 rounded-full"
                                  style={{ background: severityFg(f.severity || 'info') }}
                                />
                                {f.label}
                              </li>
                            ))}
                          </ul>
                        )}
                        {r.operator && (
                          <div className="mt-4 pt-3 border-t border-white/10 flex items-center gap-2.5">
                            {r.operator.avatar ? (
                              <img src={r.operator.avatar} alt={r.operator.name} className="w-7 h-7 rounded-full" />
                            ) : (
                              <div className="w-7 h-7 rounded-full bg-white/10" />
                            )}
                            <div className="min-w-0">
                              <div className="text-2xs font-semibold truncate">{r.operator.name}</div>
                              <div className="text-2xs text-white/50">
                                {r.operator.rating != null && `★ ${r.operator.rating.toFixed(1)}`}
                                {r.operator.city && ` · ${r.operator.city}`}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {/* DOCUMENTS */}
            {documents.length > 0 && (
              <section data-testid="documents-archive">
                <div className="flex items-baseline justify-between mb-5">
                  <div>
                    <div className="text-2xs uppercase tracking-[0.2em] text-white/40">PAPERWORK</div>
                    <h2 className="font-display tracking-bebas text-3xl mt-1">Документы</h2>
                  </div>
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {documents.map(d => {
                    const tone = d.status === 'expired' ? 'danger' : d.status === 'expiring' ? 'warning' : 'success';
                    return (
                      <div
                        key={d.id}
                        className="rounded-xl p-4 flex items-start gap-3"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                        data-testid={`doc-${d.kind}`}
                      >
                        <span
                          className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
                          style={{ background: severityBg(tone), color: severityFg(tone) }}
                        >
                          {d.kind === 'tuv' && <Shield size={16} />}
                          {d.kind === 'insurance' && <Shield size={16} />}
                          {d.kind === 'registration' && <ScrollText size={16} />}
                          {d.kind === 'service_book' && <BookOpen size={16} />}
                          {!['tuv', 'insurance', 'registration', 'service_book'].includes(d.kind) && <FileText size={16} />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">{d.label}</div>
                          {d.issuer && <div className="text-2xs text-white/50 truncate">{d.issuer}</div>}
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
                            {d.expiresAtIso && (
                              <span style={{ color: severityFg(tone) }}>
                                {d.status === 'expired' ? 'просрочен' : 'действует до '}{fmtDate(d.expiresAtIso)}
                              </span>
                            )}
                            {!d.expiresAtIso && d.issuedAtIso && (
                              <span className="text-white/50">с {fmtDate(d.issuedAtIso)}</span>
                            )}
                            {d.documentNumber && (
                              <span className="text-white/40 font-mono">№{d.documentNumber}</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>

          {/* ── RIGHT COLUMN ─────────────────────────────────────── */}
          <aside className="space-y-6">
            {/* COMPARATIVE INTELLIGENCE */}
            <section data-testid="comparative-intelligence">
              <div className="rounded-2xl p-5" style={{ background: 'linear-gradient(180deg, rgba(255,176,32,0.06) 0%, rgba(255,255,255,0.02) 100%)', border: '1px solid rgba(255,176,32,0.18)' }}>
                <div className="text-2xs uppercase tracking-[0.2em] text-amber mb-1">MARKET INTELLIGENCE</div>
                <div className="font-display tracking-bebas text-2xl">{comparative.modelKey}</div>
                <div className="text-2xs text-white/55 mt-1" data-testid="comparative-cases">
                  {comparative.totalCases} {comparative.totalCases === 1 ? 'случай' : 'случаев'} в нашей базе
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-2xs text-white/50">PASS</div>
                    <div className="text-xl font-display tracking-bebas" style={{ color: '#22C55E' }}>
                      {Math.round(comparative.passRate * 100)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs text-white/50">RISK</div>
                    <div className="text-xl font-display tracking-bebas" style={{ color: '#FFB020' }}>
                      {Math.round(comparative.riskRate * 100)}%
                    </div>
                  </div>
                  <div>
                    <div className="text-2xs text-white/50">REJECT</div>
                    <div className="text-xl font-display tracking-bebas" style={{ color: '#EF4444' }}>
                      {Math.round(comparative.rejectRate * 100)}%
                    </div>
                  </div>
                </div>

                {comparative.avgSavingsEur > 0 && (
                  <div className="mt-4 p-3 rounded-md text-center" style={{ background: 'rgba(255,176,32,0.10)' }}>
                    <div className="text-2xs uppercase text-white/60">средний торг</div>
                    <div className="text-2xl font-display tracking-bebas text-amber">
                      {fmtEur(comparative.avgSavingsEur)}
                    </div>
                  </div>
                )}

                {comparative.topFindings.length > 0 && (
                  <>
                    <div className="text-2xs uppercase tracking-[0.2em] text-white/40 mt-5 mb-2">TOP FINDINGS</div>
                    <ul className="space-y-2">
                      {comparative.topFindings.slice(0, 5).map((f, i) => (
                        <li key={i} className="text-2xs">
                          <div className="flex justify-between text-white/80">
                            <span className="truncate pr-2">{f.label}</span>
                            <span className="text-amber font-semibold">{f.percent}%</span>
                          </div>
                          <div className="h-1 rounded-full bg-white/8 overflow-hidden mt-1">
                            <div className="h-full bg-amber/70" style={{ width: `${Math.min(100, f.percent)}%` }} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {/* ── Contextual market subscription CTA ───────────────────
                    Vehicle becomes query generator. One click turns
                    single-vehicle interest into persistent market intent. */}
                <button
                  type="button"
                  onClick={() => {
                    track('vehicle_to_search_open', { vehicleId: v.id });
                    setSubscribeOpen(true);
                  }}
                  className="mt-5 w-full inline-flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-left transition group"
                  style={{
                    background: 'rgba(255,176,32,0.10)',
                    border: '1px solid rgba(255,176,32,0.35)',
                  }}
                  data-testid="cta-subscribe-similar"
                >
                  <span className="flex items-start gap-3 min-w-0">
                    <span
                      className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 group-hover:scale-105 transition"
                      style={{ background: 'rgba(255,176,32,0.20)', color: '#FFB020' }}
                    >
                      <Bell size={16} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-2xs uppercase tracking-[0.2em] text-amber/90">Market sensing</span>
                      <span className="block font-semibold text-sm leading-snug truncate">
                        {similarHeadline(v)}
                      </span>
                      <span className="block text-2xs text-white/55 mt-0.5">
                        Сообщим, когда рынок выложит подходящий вариант.
                      </span>
                    </span>
                  </span>
                  <span className="text-amber text-lg shrink-0">→</span>
                </button>
              </div>
            </section>

            {/* VALUE TRAJECTORY */}
            {valueTrajectory.length > 1 && (
              <section data-testid="value-trajectory">
                <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-baseline justify-between">
                    <div>
                      <div className="text-2xs uppercase tracking-[0.2em] text-white/40">VALUE</div>
                      <div className="font-display tracking-bebas text-2xl">Траектория</div>
                    </div>
                    <div className="text-right">
                      <div className="text-2xs text-white/50">сейчас</div>
                      <div className="font-display tracking-bebas text-xl text-amber">{fmtEur(valueTrajectory[valueTrajectory.length - 1].eur)}</div>
                    </div>
                  </div>
                  <div className="mt-3"><ValueSparkline data={valueTrajectory} /></div>
                  <div className="mt-2 flex justify-between text-2xs text-white/40">
                    <span>{fmtDate(valueTrajectory[0].monthIso)}</span>
                    <span>{fmtEur(valueTrajectory[0].eur)} → {fmtEur(valueTrajectory[valueTrajectory.length - 1].eur)}</span>
                  </div>
                </div>
              </section>
            )}

            {/* OPERATORS */}
            {operators.length > 0 && (
              <section data-testid="operator-lineage">
                <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-2xs uppercase tracking-[0.2em] text-white/40 mb-3">LINEAGE · OPERATORS</div>
                  <ul className="space-y-3">
                    {operators.map(op => (
                      <li key={op.id} className="flex items-center gap-3" data-testid={`operator-${op.id}`}>
                        {op.avatar ? (
                          <img src={op.avatar} alt={op.name} className="w-10 h-10 rounded-full" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-white/10" />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm truncate">{op.name}</div>
                          <div className="text-2xs text-white/50">
                            {op.rating != null && `★ ${op.rating.toFixed(1)}`}
                            {op.city && ` · ${op.city}`}
                            {op.totalInspections != null && ` · ${op.totalInspections} осмотров`}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-2xs text-white/50">взаимодействий</div>
                          <div className="font-display tracking-bebas text-lg text-amber">{op.interactions || 1}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}

            {/* CTA */}
            <Link
              to={`/inspect?vehicleId=${encodeURIComponent(v.id)}`}
              className="block w-full px-5 py-4 rounded-xl text-center font-semibold transition"
              style={{ background: '#FFB020', color: '#0A0A0A' }}
              data-testid="cta-new-inspection"
            >
              <Clock size={14} className="inline mr-2 -mt-0.5" />
              Запросить новый осмотр
            </Link>
          </aside>
        </div>

        {/* ── BOTTOM META ROW ─────────────────────────────────────── */}
        <div className="mt-12 pt-6 border-t border-white/8 flex flex-wrap gap-x-8 gap-y-2 text-2xs text-white/40">
          {v.importedFrom && <span>Импорт: {v.importedFrom}</span>}
          {v.importedOn && <span>с {fmtDate(v.importedOn)}</span>}
          {v.bodyType && <span>Кузов: {v.bodyType}</span>}
          {v.fuel && <span>Топливо: {v.fuel}</span>}
          {ownership.totalSpentEur != null && ownership.totalSpentEur > 0 && (
            <span>Совокупные расходы: {fmtEur(ownership.totalSpentEur)}</span>
          )}
        </div>
      </div>

      {/* ── Subscribe-to-similar modal (vehicle → market_search) ──── */}
      <SaveSearchModal
        open={subscribeOpen}
        onClose={() => setSubscribeOpen(false)}
        onSaved={() => track('vehicle_to_search_submit', { vehicleId: v.id })}
        prefill={vehicleToFilter(v)}
        eyebrow="MARKET SENSING"
        headline={similarHeadline(v)}
        subline={similarSubline(v)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sub: ownership card
// ─────────────────────────────────────────────────────────────────

function OwnershipCard({
  label, value, hint, icon, tone = 'info',
}: { label: string; value: string; hint?: string; icon?: React.ReactNode; tone?: 'success' | 'warning' | 'danger' | 'info' }) {
  const ringColor = tone === 'success' ? 'rgba(34,197,94,0.30)'
    : tone === 'warning' ? 'rgba(255,176,32,0.30)'
    : tone === 'danger'  ? 'rgba(239,68,68,0.30)'
    : 'rgba(255,255,255,0.10)';
  return (
    <div
      className="rounded-2xl p-4 backdrop-blur-md transition"
      style={{
        background: 'rgba(255,255,255,0.05)',
        border: `1px solid ${ringColor}`,
      }}
    >
      <div className="flex items-center gap-2 text-2xs uppercase tracking-[0.18em] text-white/55">
        <span className="w-5 h-5 rounded-md flex items-center justify-center" style={{ background: 'rgba(255,255,255,0.06)', color: severityFg(tone) }}>
          {icon}
        </span>
        {label}
      </div>
      <div className="font-display tracking-bebas text-[28px] leading-tight mt-2">{value}</div>
      {hint && <div className="text-2xs text-white/45 mt-0.5">{hint}</div>}
    </div>
  );
}
