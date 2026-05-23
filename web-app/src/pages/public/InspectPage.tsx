import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Link2, ShieldCheck, AlertTriangle, ArrowRight, Loader2,
  Calendar, Gauge, Fuel, Tag, Clock, CheckCircle2, XCircle
} from 'lucide-react';
import { inspectionAPI } from '../../services/api';
// Step 11A — canonical parse-result reader (shared substrate).
// We classify hard- vs soft-fail via this helper rather than reading
// `parseMeta.parsed` directly. Keeps the rule one-source-of-truth
// across web / Expo / admin.
import {
  classifyParseFailure,
  hasPreviewSignal,
  type ParseCompleteness,
} from '@platform/domain/parsers/canonical';

type Severity = 'low' | 'medium' | 'high';
type Risk = 'low' | 'medium' | 'high';

interface Reason { code: string; severity: Severity; label: string; detail: string; }
interface Report {
  score: number;
  risk: Risk;
  summary: string;
  reasons: Reason[];
  costEstimate: [number, number];
  decision: string;
  decisionLabel: string;
  confidence: 'low' | 'medium' | 'high';
  similarVehiclesCount?: number;
  roiHint?: string;
}
// Step 11A — parseMeta now carries the canonical envelope keys
// (`parseCompleteness`, `degradedReason`, `ok`) emitted by the
// `/api/inspection/report/generate` adapter. Legacy `parsed` / `error`
// remain in the response for back-compat (Step 11D removes them) but
// this surface no longer reads them.
//
// Step 11D-α — full canonical envelope (Pydantic dump of
// `ListingParseResult`, 18 frozen fields) added at the top level.
// Step 11D-β — this file moves OFF the legacy `car.*` mirror onto
// `canonical.*` for every parser-substrate read (title / make /
// model / priceEur / mileageKm / year / fuel / images[0] / source).
// `marketAvg` intentionally stays on `car.*` — it is a downstream
// build_report output, not a parser substrate field, and would
// expand the canonical contract if absorbed. `hasPreviewSignal()`
// is the SOLE gate for whether the preview card renders.
interface CarLegacy {
  // 11D-β: only `marketAvg` survives in the legacy mirror by design.
  // 11D-γ will remove every other field from the wire.
  marketAvg?: number | null;
}

interface InspectionCanonical {
  ok: boolean;
  source: string;
  sourceUrl: string;
  externalId: string | null;
  title: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  priceEur: number | null;
  mileageKm: number | null;
  location: string | null;
  vin: string | null;
  fuel: string | null;
  transmission: string | null;
  sellerType: string | null;
  images: string[];
  parseCompleteness: ParseCompleteness | null;
  degradedReason: string | null;
}

interface ApiResult {
  report: Report;
  car: CarLegacy;
  canonical: InspectionCanonical | null;
  parseMeta: {
    parsed: boolean | null;
    error: string | null;
    source: string | null;
    parseCompleteness?: ParseCompleteness | null;
    degradedReason?: string | null;
    ok?: boolean;
  };
  pricing: { inspectionFee: number; currency: string; deliveryHours: number };
}

export default function InspectPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResult | null>(null);
  // `hardError` blocks establishment (bad URL, unsupported domain,
  // not_a_listing). `softNote` is the calm "✓ Link accepted" notice —
  // does NOT block. Two separate slots so the UX never confuses them.
  const [hardError, setHardError] = useState<string | null>(null);
  const [softNote, setSoftNote] = useState<string | null>(null);

  const numLocale = i18n.language === 'ru' ? 'ru-RU' : i18n.language === 'en' ? 'en-US' : 'de-DE';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setHardError(null);
    setSoftNote(null);
    setResult(null);
    setLoading(true);
    try {
      const { data } = await inspectionAPI.generateReport({ url: url.trim() });
      setResult(data);
      // Step 11A — canonical-first failure classification.
      // We read `parseMeta.degradedReason` (canonical) instead of
      // `parseMeta.error` (legacy mirror). The shared classifier
      // collapses 14+ failure codes into the hard/soft dichotomy that
      // the UX actually cares about.
      const meta = data.parseMeta || {};
      const failure = classifyParseFailure(meta.degradedReason ?? null, {
        sourceRecognised: !!meta.source && meta.source !== 'generic',
      });
      if (failure === 'hard') {
        // bad_url / unsupported_domain / not_a_listing
        setHardError(t('inspect.soft_error.unsupported'));
      } else if (failure === 'soft') {
        // antibot / http_* / timeout / expired_listing / weak — link is
        // OK, inspector will open it. NEVER block.
        setSoftNote(t('inspect.soft_error.no_parse'));
      }
    } catch (e: any) {
      console.error('generateReport failed', e);
      // Network/API error — treated as soft so the user can still
      // proceed with order via the fallback CTA.
      setSoftNote(e?.response?.data?.message || t('inspect.soft_error.general'));
    } finally {
      setLoading(false);
    }
  }

  function orderInspection() {
    const params = new URLSearchParams();
    params.set('problem', 'inspection');
    // 11D-β: read from canonical envelope (single source of truth).
    const c = result?.canonical;
    const title = c?.title;
    if (title) params.set('q', `Pre-Kauf-Prüfung: ${title}`);
    if (c?.sourceUrl) params.set('listing', c.sourceUrl);
    navigate(`/search?${params.toString()}`);
  }

  return (
    <div data-testid="inspect-page">
      <section className="mx-auto max-w-3xl px-4 md:px-6 pt-12 pb-10 text-center">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)]" data-testid="inspect-eyebrow">
          {t('inspect.eyebrow')}
        </p>
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight text-[var(--text)] mb-4" data-testid="inspect-title">
          {t('inspect.title')}
        </h1>
        <p className="text-lg text-[var(--text-2)] max-w-xl mx-auto" data-testid="inspect-subtitle">
          {t('inspect.subtitle')}
        </p>
      </section>

      <section className="mx-auto max-w-3xl px-4 md:px-6 pb-8">
        <form
          onSubmit={submit}
          className="rounded-2xl border border-[var(--border)] bg-white p-3 md:p-4 shadow-[var(--shadow-card)]"
          data-testid="inspect-form"
        >
          <div className="flex flex-col md:flex-row gap-2 md:gap-3">
            <div className="flex-1 input-shell input-lg">
              <Link2 size={18} className="text-[var(--text-soft)]" />
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={t('inspect.input_placeholder')}
                data-testid="inspect-input"
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              className="btn-primary btn-lg md:w-auto"
              disabled={loading || !url.trim()}
              data-testid="inspect-submit"
            >
              {loading ? (<><Loader2 size={16} className="animate-spin" /> {t('inspect.analyzing')}</>) : (<>{t('inspect.analyze')} <ArrowRight size={16} /></>)}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-5 text-sm text-[var(--text-2)]">
            <span className="inline-flex items-center gap-2">
              <ShieldCheck size={16} className="text-[var(--success)]" /> {t('inspect.trust_strip.tuv')}
            </span>
            <span className="inline-flex items-center gap-2">
              <Tag size={16} className="text-[var(--warning)]" /> {t('inspect.trust_strip.fixed_price')}
            </span>
          </div>
        </form>
      </section>

      {result && (
        <ResultCard
          data={result}
          softNote={softNote}
          hardError={hardError}
          onOrder={orderInspection}
          numLocale={numLocale}
        />
      )}

      {!result && (hardError || softNote) && (
        <FallbackCTA
          message={hardError || softNote || ''}
          tone={hardError ? 'hard' : 'soft'}
          onOrder={orderInspection}
        />
      )}

      <section className="mx-auto max-w-3xl px-4 md:px-6 pb-20">
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] p-5">
          <h3 className="font-extrabold mb-3">{t('inspect.how.title')}</h3>
          <ol className="space-y-2 text-sm text-[var(--text-2)]">
            <li>{t('inspect.how.step1')}</li>
            <li>{t('inspect.how.step2')}</li>
            <li>{t('inspect.how.step3')}</li>
            <li>{t('inspect.how.step4')}</li>
          </ol>
        </div>
      </section>
    </div>
  );
}

function ResultCard({
  data, softNote, hardError, onOrder, numLocale,
}: {
  data: ApiResult;
  softNote: string | null;
  hardError: string | null;
  onOrder: () => void;
  numLocale: string;
}) {
  const { t } = useTranslation();
  const { report, car, canonical, parseMeta } = data;
  // Step 11A — canonical-driven preview gate (failure-mode classifier
  // from shared `@platform/domain/parsers/canonical`).
  // Step 11D-β — `hasPreviewSignal()` is now the SOLE gate; we also
  // read every car-attribute from `canonical.*` instead of the
  // legacy `car.*` mirror. The double-gate from 11A
  // (`previewable || hasLegacyCore`) is removed: surfaces now trust
  // the substrate's `parseCompleteness` verdict.
  const previewable = hasPreviewSignal({
    ok: parseMeta?.ok ?? false,
    parseCompleteness: parseMeta?.parseCompleteness ?? null,
    degradedReason: parseMeta?.degradedReason ?? null,
  });
  const renderPreview = previewable;

  if (hardError || !renderPreview) {
    return (
      <section className="mx-auto max-w-3xl px-4 md:px-6 pb-10" data-testid="inspect-result-fallback">
        <div className="rounded-2xl border border-[#fde68a] bg-[#fffbeb] p-6">
          <div className="flex items-start gap-3 mb-4">
            <AlertTriangle size={18} className="text-[#d97706] mt-0.5 shrink-0" />
            <div>
              <div className="font-bold mb-1">{t('inspect.fallback.title')}</div>
              <p className="text-sm text-[#78350f]" data-testid="inspect-fallback-message">
                {hardError || softNote || t('inspect.fallback.default_message')}
              </p>
            </div>
          </div>
          <StrongCTA onClick={onOrder} testid="inspect-order-cta-fallback" />
        </div>
      </section>
    );
  }

  const { riskColor, bgColor, scarePrefix } = riskVisuals(report.risk);

  const fmtEur = (n?: number | null) => (typeof n === 'number' ? `€${n.toLocaleString(numLocale)}` : '—');
  const fmtKm = (n?: number | null) => (typeof n === 'number' ? `${n.toLocaleString(numLocale)} km` : '—');

  // ── 11D-β: canonical-first reads for the preview card ────────
  // `marketAvg` intentionally stays on the legacy `car.*` mirror —
  // it's a `build_report` baseline, not a parser substrate field,
  // and absorbing it into `ListingParseResult` would re-introduce
  // presentation drift the canonical contract is designed to
  // prevent. 11D-γ keeps `car.marketAvg` and deletes everything else.
  const carImage = canonical?.images?.[0] ?? null;
  const carTitle =
    canonical?.title ||
    `${canonical?.make ?? ''} ${canonical?.model ?? ''}`.trim() ||
    null;
  const carSource = canonical?.source && canonical.source !== 'unknown' ? canonical.source : null;
  const carPrice = canonical?.priceEur ?? null;
  const carYear = canonical?.year ?? null;
  const carMileage = canonical?.mileageKm ?? null;
  const carFuel = canonical?.fuel ?? null;
  const carMarketAvg = car?.marketAvg ?? null;

  return (
    <section className="mx-auto max-w-3xl px-4 md:px-6 pb-12" data-testid="inspect-result">
      <div className="rounded-2xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)] overflow-hidden">
        {/* Header */}
        <div className="flex flex-col md:flex-row gap-4 p-5 border-b border-[var(--border)]">
          {carImage ? (
            <img
              src={carImage}
              alt={carTitle || t('inspect.result.default_vehicle')}
              className="w-full md:w-48 h-32 object-cover rounded-xl border border-[var(--border)] bg-[var(--surface-soft)]"
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              data-testid="inspect-result-image"
            />
          ) : null}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-soft)] mb-1">
              {carSource || t('inspect.result.default_source')}
            </div>
            <h2 className="text-2xl font-extrabold leading-tight mb-1 truncate" data-testid="inspect-result-title">
              {carTitle || t('inspect.result.default_vehicle')}
            </h2>
            <div className="text-3xl font-extrabold text-[var(--text)]" data-testid="inspect-result-price">
              {fmtEur(carPrice)}
            </div>
          </div>
        </div>

        {/* Specs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-5 border-b border-[var(--border)]" data-testid="inspect-result-specs">
          <Spec icon={<Calendar size={16} />} label={t('inspect.result.spec_year')} value={carYear ?? '—'} />
          <Spec icon={<Gauge size={16} />} label={t('inspect.result.spec_km')} value={fmtKm(carMileage)} />
          <Spec icon={<Fuel size={16} />} label={t('inspect.result.spec_fuel')} value={fuelLabel(carFuel, t)} />
          <Spec icon={<Tag size={16} />} label={t('inspect.result.spec_market_avg')} value={fmtEur(carMarketAvg)} />
        </div>

        {/* Risk */}
        <div className="p-5 border-b border-[var(--border)]" style={{ background: bgColor, borderLeft: `4px solid ${riskColor}` }} data-testid="inspect-result-risk">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <div className="text-xs font-bold uppercase tracking-[0.16em]" style={{ color: riskColor }} data-testid="inspect-risk-label">
                  {scarePrefix} {t(`inspect.risk.${report.risk}`)}
                </div>
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-[var(--border)] px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-2)]"
                  data-testid="inspect-confidence-badge"
                >
                  <ShieldCheck size={10} /> {t('inspect.result.confidence_caption')}: {t(`inspect.confidence.${report.confidence}`)}
                </span>
              </div>
              <div className="text-lg font-extrabold mb-1">
                {report.summary}
              </div>
              {typeof report.similarVehiclesCount === 'number' && report.similarVehiclesCount > 0 && (
                <div className="text-xs text-[var(--text-soft)] mb-1" data-testid="inspect-similar-count">
                  {t('inspect.result.similar_count', { count: report.similarVehiclesCount.toLocaleString(numLocale) })}
                </div>
              )}
              <div className="text-sm text-[var(--text-2)]">
                {t('inspect.result.score_label')}: <b>{report.score.toFixed(1)}/10</b>
                <span className="mx-2 text-[var(--text-soft)]">·</span>
                {t('inspect.result.recommendation_label')}: <b>{report.decisionLabel}</b>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-soft)]">{t('inspect.result.cost_caption')}</div>
              <div className="text-lg font-extrabold" data-testid="inspect-cost-estimate">
                €{report.costEstimate[0].toLocaleString(numLocale)}–€{report.costEstimate[1].toLocaleString(numLocale)}
              </div>
              <div className="text-[11px] text-[var(--text-soft)] mt-0.5">{t('inspect.result.cost_period')}</div>
            </div>
          </div>

          {report.roiHint && (
            <div className="mt-2 mb-3 flex items-start gap-2 rounded-lg bg-white/60 border border-[var(--border)] p-3 text-sm font-semibold text-[var(--text)]" data-testid="inspect-roi-hint">
              <span style={{ color: riskColor }} className="shrink-0">👉</span>
              <span>{report.roiHint}</span>
            </div>
          )}

          {report.reasons.length > 0 && (
            <div className="mt-4 rounded-xl border border-white/60 bg-white/70 p-4" data-testid="inspect-reasons">
              <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-soft)] mb-3">{t('inspect.result.why')}</div>
              <ul className="space-y-2.5">
                {report.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2.5" data-testid={`inspect-reason-${r.code}`}>
                    <span className="mt-0.5 shrink-0" style={{ color: sevColor(r.severity) }}>
                      {r.severity === 'high' ? <XCircle size={16} /> : r.severity === 'medium' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                    </span>
                    <div className="flex-1">
                      <div className="text-sm font-bold">{r.label}</div>
                      <div className="text-xs text-[var(--text-2)] leading-snug">{r.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {softNote && (
            <div className="mt-3 text-xs text-[var(--text-soft)] italic" data-testid="inspect-soft-notice">
              {softNote}
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#d97706] mb-3" data-testid="inspect-urgency">
            <Clock size={14} /> {t('inspect.result.urgency')}
          </div>
          <StrongCTA onClick={onOrder} testid="inspect-order-cta" />
        </div>
      </div>
    </section>
  );
}

function StrongCTA({ onClick, testid }: { onClick: () => void; testid: string }) {
  const { t } = useTranslation();
  return (
    <>
      <button onClick={onClick} className="btn-primary btn-lg w-full" data-testid={testid}>
        {t('inspect.cta.book')} <ArrowRight size={16} />
      </button>
      <ul className="mt-4 grid gap-2 text-sm">
        <Bullet text={t('inspect.cta.bullet_tuv_onsite')} />
        <Bullet text={t('inspect.cta.bullet_report_24h')} />
        <Bullet text={t('inspect.cta.bullet_fixed_price')} />
      </ul>
    </>
  );
}

function Bullet({ text }: { text: string }) {
  return (
    <li className="flex items-center gap-2 text-[var(--text-2)]">
      <CheckCircle2 size={16} className="text-[var(--success)] shrink-0" /> {text}
    </li>
  );
}

function Spec({ icon, label, value }: { icon: React.ReactNode; label: string; value: any }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-white p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-soft)] mb-1">
        {icon} {label}
      </div>
      <div className="text-base font-extrabold text-[var(--text)] truncate">{value}</div>
    </div>
  );
}

function FallbackCTA({
  message, tone, onOrder,
}: {
  message: string;
  tone: 'hard' | 'soft';
  onOrder: () => void;
}) {
  const { t } = useTranslation();
  // Step 11A — both hard- and soft-fail render the same calm card so
  // the customer sees consistent affordance ("inspector will open it
  // manually"). The doctrine says: a parser failure must NEVER kill
  // the inspection context. Only the *wording* differs.
  return (
    <section className="mx-auto max-w-3xl px-4 md:px-6 pb-12" data-testid="inspect-fallback-cta">
      <div className="rounded-2xl border border-[#fde68a] bg-[#fffbeb] p-6">
        <div className="flex items-start gap-3 mb-4">
          <AlertTriangle size={18} className="text-[#d97706] mt-0.5 shrink-0" />
          <div>
            <div className="font-bold mb-1">{t('inspect.fallback.still_inspect')}</div>
            <p className="text-sm text-[#78350f]" data-testid={`inspect-fallback-${tone}`}>
              {message}
            </p>
          </div>
        </div>
        <StrongCTA onClick={onOrder} testid="inspect-order-cta-fallback" />
      </div>
    </section>
  );
}

function fuelLabel(f: string | undefined, t: any): string {
  if (!f) return '—';
  const key = f.toLowerCase();
  const known = ['diesel', 'petrol', 'hybrid', 'electric', 'lpg', 'cng'];
  return known.includes(key) ? t(`inspect.fuel.${key}`) : f;
}

function sevColor(s: Severity): string {
  return s === 'high' ? '#dc2626' : s === 'medium' ? '#d97706' : '#16a34a';
}

function riskVisuals(r: Risk): { riskColor: string; bgColor: string; borderColor: string; scarePrefix: string } {
  if (r === 'high') return {
    riskColor: '#dc2626', bgColor: '#fef2f2', borderColor: '#fecaca',
    scarePrefix: '⚠️',
  };
  if (r === 'medium') return {
    riskColor: '#d97706', bgColor: '#fffbeb', borderColor: '#fde68a',
    scarePrefix: '⚠️',
  };
  return {
    riskColor: '#16a34a', bgColor: '#f0fdf4', borderColor: '#bbf7d0',
    scarePrefix: '✓',
  };
}
