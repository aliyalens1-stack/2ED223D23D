/**
 * CustomerVehicleDetail — Vehicle Memory consumer.
 *
 * P4 — first consumer of `@platform/domain/state-machines/vehicle`.
 *
 * Routing:
 *   /account/garage/:vehicleId
 *
 * What this page does (and ONLY this page):
 *   1. Fetches the vehicle doc + linked artefacts (reports, quotes,
 *      payments, bookings) — surface-side I/O only.
 *   2. Hands those into shared projection functions to derive:
 *        - VehicleMemory  (header / status badges)
 *        - timeline items (chronological strip)
 *   3. Renders the result. Zero domain branching on raw backend strings.
 *
 * What this page does NOT do:
 *   - Mutate vehicle status (PATCH lives in CustomerGarage edit modal).
 *   - Run merge/sync logic (single-fetch on mount; cache layer can
 *     wrap this later via mergeVehicleMemory from shared).
 *   - Fetch globally — every linked-domain endpoint is best-effort
 *     and falls back to `[]` on error / missing API. The shared
 *     projection is robust to empty cross-domain inputs.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, Car, ExternalLink, Info, AlertTriangle, AlertCircle,
  CheckCircle2, Clock, FileText, Tag, CreditCard, Calendar, Wrench,
} from 'lucide-react';
import {
  vehiclesAPI,
} from '../../services/api';
// P4.3 — Vehicle Memory cache. The store is a CACHE LAYER, not a
// state machine: surfaces still own fetch/mutate, the store only
// holds the latest VehicleMemory snapshot per id and reconciles via
// shared `mergeVehicleMemory`. See web-app/src/stores/vehicleMemoryStore.ts.
import {
  useVehicleMemory,
  useVehicleMemoryStore,
} from '../../stores/vehicleMemoryStore';
import {
  projectVehicleMemory,
  projectVehicleTimeline,
} from '@platform/domain/state-machines/vehicle';
import { statusOf as paymentStatusOf } from '@platform/domain/state-machines/payment';
import { normalizeBackendQuoteStatus } from '@platform/domain/state-machines/quote';
import type {
  VehicleDoc,
  VehicleMemoryProjectionInput,
  LinkedInspectionReportRef,
  LinkedQuoteRef,
  LinkedPaymentRef,
  LinkedBookingRef,
  CustomerVehiclePerception,
  VehicleMemoryStage,
  TimelineItemKind,
  TimelineItemSeverity,
} from '@platform/domain/contracts/vehicle';

// ─────────────────────────────────────────────────────────────────────
// Surface-side translation: backend wire shape → projection input.
//
// Cross-domain endpoints don't exist for "give me everything linked
// to vehicle X" — backend stores quotes against requests, payments
// against bookings/quotes, etc. P4 deliberately does NOT add such an
// endpoint (no backend writes). Instead the surface degrades to:
//   - reports[] = []   (no per-vehicle endpoint yet)
//   - quotes[]  = []   (no per-vehicle endpoint yet)
//   - payments[] = []
//   - bookings[] = []
//
// When a per-vehicle linkage endpoint lands in a future sprint (or
// when the surface gains a "request → vehicle" derivation), this is
// the ONLY function to update — projection logic in shared stays
// untouched.
// ─────────────────────────────────────────────────────────────────────

interface RawVehicleDoc {
  id: string;
  customerId: string;
  brand: string;
  model: string;
  year?: number | null;
  mileage?: number | null;
  price?: number | null;
  currency?: string | null;
  thumbnail?: string | null;
  listing_url?: string | null;
  source?: string | null;
  notes?: string | null;
  status?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  activity?: { type: string; at: string; text?: string | null }[];
  // CustomerGarage form passes these on create — backend persists them as part of doc
  plate?: string | null;
  vin?: string | null;
  mileageKm?: number | null;
  // Optional free-text city / location label persisted alongside the
  // listing source. Backend may or may not send it (depends on parser).
  location?: string | null;
}

function toVehicleDoc(raw: RawVehicleDoc): VehicleDoc {
  return {
    id: raw.id,
    customerId: raw.customerId,
    brand: raw.brand,
    model: raw.model,
    year: raw.year ?? null,
    mileage: raw.mileage ?? raw.mileageKm ?? null,
    price: raw.price ?? null,
    currency: raw.currency ?? null,
    thumbnail: raw.thumbnail ?? null,
    listingUrl: raw.listing_url ?? null,
    source: raw.source ?? null,
    notes: raw.notes ?? null,
    status: raw.status ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt ?? null,
    activity: (raw.activity ?? []).map((a) => ({
      type: a.type,
      at: a.at,
      text: a.text ?? null,
    })),
    // Pass-through optional fields used by VehicleMemory.identity.
    ...(raw.plate ? { plate: raw.plate } as object : {}),
    ...(raw.vin ? { vin: raw.vin } as object : {}),
  } as VehicleDoc;
}

// Bookings come from the P4.1 timeline aggregator below. Kept for
// backward-compat reference: prior implementation pulled the entire
// /customer/bookings list and filtered client-side. Now the server
// does the join via indexed `vehicleId` lookup.

// ─────────────────────────────────────────────────────────────────────
// Display helpers (presentation-only — no domain logic).
// ─────────────────────────────────────────────────────────────────────

const STAGE_LABEL: Readonly<Record<VehicleMemoryStage, string>> = {
  discovery: 'Discovery',
  validation: 'Validation',
  decision: 'Decision',
  acquisition: 'Acquisition',
  ownership: 'Ownership',
  parted_ways: 'Parted ways',
};

const STAGE_DESCRIPTION: Readonly<Record<VehicleMemoryStage, string>> = {
  discovery: 'You\'re still looking at this car.',
  validation: 'Inspection is being arranged or in progress.',
  decision: 'Inspection done — weighing the verdict.',
  acquisition: 'You accepted a quote / paying for the vehicle.',
  ownership: 'This car is yours.',
  parted_ways: 'You\'re no longer interested in (or have sold) this car.',
};

const PERCEPTION_LABEL: Readonly<Record<CustomerVehiclePerception, string>> = {
  considering: 'Considering',
  inspection_pending: 'Inspection pending',
  evaluating: 'Evaluating',
  evaluating_with_concerns: 'Evaluating · concerns',
  negotiating: 'Negotiating',
  awaiting_delivery: 'Awaiting delivery',
  owned: 'Owned',
  parted_with: 'Sold',
  not_interested: 'Archived',
};

const PERCEPTION_TONE: Readonly<Record<CustomerVehiclePerception, string>> = {
  considering: '#B8B8B8',
  inspection_pending: '#7DD3FC',
  evaluating: '#FFB020',
  evaluating_with_concerns: '#F97316',
  negotiating: '#FFB020',
  awaiting_delivery: '#FFB020',
  owned: '#22C55E',
  parted_with: '#8A8A8A',
  not_interested: '#8A8A8A',
};

const KIND_ICON = (k: TimelineItemKind, severity?: TimelineItemSeverity) => {
  // Severity → existing substrate tier substrate. `default` falls to text-2
  // (neutral info utterance) because no `--info` token exists in substrate
  // and per pass guardrail we don't introduce new tokens. Closest existing
  // anchor to the prior `#7DD3FC` info-blue is the mid-tone neutral text.
  const color =
    severity === 'success' ? 'var(--success)' :
    severity === 'warning' ? 'var(--warning)' :
    severity === 'danger'  ? 'var(--danger)'  :
    'var(--text-2)';
  switch (k) {
    case 'inspection_report':
      return <FileText size={14} style={{ color }} />;
    case 'quote':
      return <Tag size={14} style={{ color }} />;
    case 'payment':
      return <CreditCard size={14} style={{ color }} />;
    case 'booking':
      return <Calendar size={14} style={{ color }} />;
    case 'vehicle_event':
    default:
      return <Wrench size={14} style={{ color }} />;
  }
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-UA', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────

export default function CustomerVehicleDetail() {
  const { vehicleId = '' } = useParams<{ vehicleId: string }>();
  const [raw, setRaw] = useState<RawVehicleDoc | null>(null);
  const [reports, setReports] = useState<LinkedInspectionReportRef[]>([]);
  const [quotes, setQuotes] = useState<LinkedQuoteRef[]>([]);
  const [payments, setPayments] = useState<LinkedPaymentRef[]>([]);
  const [bookings, setBookings] = useState<LinkedBookingRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // P4.3 — cached projection (rendered while server snapshot refreshes).
  const cachedMemory = useVehicleMemory(vehicleId);
  const setSnapshot = useVehicleMemoryStore((s) => s.setSnapshot);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Cache hit → keep rendered output stable; refresh in background.
      // No "Загрузка…" flash on re-mount. Cold start (no cache) keeps
      // the original loader.
      setLoading(!cachedMemory);
      setError(null);
      try {
        // P4.1 — single round-trip aggregator. Backend joins
        // car_requests / inspection_jobs / inspection_reports /
        // customer_requests / request_quotes / customer_bookings /
        // payment_transactions on the indexed `vehicleId` field and
        // returns the LinkedXxxRef[] wire shape the shared projection
        // input expects. No more client-side fan-out filtering.
        const res = await vehiclesAPI.getTimeline(vehicleId);
        if (cancelled) return;
        const data = res.data || {};
        setRaw(data.vehicle as RawVehicleDoc);
        setReports(Array.isArray(data.reports) ? data.reports : []);
        setQuotes(Array.isArray(data.quotes) ? data.quotes : []);
        setPayments(Array.isArray(data.payments) ? data.payments : []);
        setBookings(Array.isArray(data.bookings) ? data.bookings : []);
      } catch (e: unknown) {
        if (cancelled) return;
        const status = (e as { response?: { status?: number } }).response?.status;
        // Cache hit + transient network error → keep rendering cached
        // projection silently. Empty cache → surface the error.
        if (!cachedMemory) {
          setError(status === 404 ? 'Авто не найдено' : 'Не удалось загрузить авто');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // cachedMemory intentionally NOT a dep — we read once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vehicleId]);

  // P4.1 — reports / quotes / payments / bookings now come straight
  // from the server timeline aggregator (above). The shared
  // projection layer is the ONLY place that does semantic mapping
  // (raw status → perception → stage). The surface only renders.

  const projectionInput: VehicleMemoryProjectionInput | null = useMemo(() => {
    if (!raw) return null;
    return {
      vehicle: toVehicleDoc(raw),
      reports,
      quotes,
      payments,
      bookings,
    };
  }, [raw, reports, quotes, payments, bookings]);

  const memory = useMemo(() => {
    if (!projectionInput) return null;
    return projectVehicleMemory(projectionInput);
  }, [projectionInput]);

  // P4.3 — write the canonical server-derived projection to the cache.
  // mergeVehicleMemory inside the store will reject a stale snapshot
  // that would regress operationalStatus / counts / flags below local.
  useEffect(() => {
    if (memory) setSnapshot(vehicleId, memory);
  }, [memory, vehicleId, setSnapshot]);

  // What we actually render comes from the cache. On cold start
  // (no cache yet) the freshly-projected `memory` becomes both the
  // first cache write AND the first render input. On warm re-mount
  // we render the cached projection while the refetch is in flight.
  const effectiveMemory = memory ?? cachedMemory;

  const timeline = useMemo(() => {
    if (!projectionInput) return [];
    return projectVehicleTimeline(projectionInput);
  }, [projectionInput]);

  // Helper exports referenced (kept import alive for future linkage).
  void paymentStatusOf;
  void normalizeBackendQuoteStatus;

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-12 text-sm" style={{ color: 'var(--text-soft)' }} data-testid="vehicle-detail-loading">
        Загрузка…
      </div>
    );
  }
  if (error || !effectiveMemory || (!raw && !cachedMemory)) {
    return (
      <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-12" data-testid="vehicle-detail-error">
        <Link to="/account/garage" className="btn-secondary btn-sm mb-4 inline-flex items-center">
          <ArrowLeft size={12} /> Гараж
        </Link>
        <div className="card text-center py-16">
          <AlertCircle size={36} className="mx-auto mb-3" style={{ color: 'var(--warning)' }} />
          <h3 className="font-display tracking-bebas text-2xl mb-1">{error ?? 'Ошибка'}</h3>
        </div>
      </div>
    );
  }

  // P4.3 — past this point everything reads from `effectiveMemory`
  // (server projection on cold start, cached projection on warm
  // re-mount / transient refetch failure). The downstream JSX is
  // unchanged from P4.2.
  const m = effectiveMemory;
  const id = m.identity;
  const tone = PERCEPTION_TONE[m.customerPerception];

  return (
    <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-8" data-testid="vehicle-detail">
      <Link to="/account/garage" className="btn-secondary btn-sm mb-4 inline-flex items-center" data-testid="vehicle-detail-back">
        <ArrowLeft size={12} /> Гараж
      </Link>

      {/* ── Identity header ─────────────────────────────────────────── */}
      <header className="card-elevated p-6 mb-6" data-testid="vehicle-identity">
        <div className="flex flex-col md:flex-row gap-5 items-start">
          <div className="w-full md:w-40 h-32 surface-chip flex items-center justify-center shrink-0 overflow-hidden">
            {id.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={id.thumbnail} alt={`${id.brand} ${id.model}`} className="w-full h-full object-cover" />
            ) : (
              <Car size={56} className="text-amber" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-2xs uppercase tracking-widest mb-1" style={{ color: 'var(--text-soft)' }}>
              {id.year ?? '—'} · {raw.location ?? '—'}
            </div>
            <h1 className="font-display tracking-bebas text-4xl">
              {id.brand} <span className="text-amber">{id.model}</span>
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-xs" style={{ color: 'var(--text-soft)' }}>
              {id.plate && <span data-testid="vehicle-identity-plate">№ {id.plate}</span>}
              {id.mileage != null && id.mileage > 0 && (
                <span data-testid="vehicle-identity-mileage">· {id.mileage.toLocaleString('ru-UA')} км</span>
              )}
              {id.vin && <span data-testid="vehicle-identity-vin">· VIN {String(id.vin).slice(-6)}</span>}
              {raw.price && raw.currency && (
                <span data-testid="vehicle-identity-price">· {raw.price.toLocaleString('ru-UA')} {raw.currency.toUpperCase()}</span>
              )}
            </div>
            {id.listingUrl && (
              <a
                href={id.listingUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs inline-flex items-center gap-1 mt-3 text-amber hover:underline"
                data-testid="vehicle-identity-listing"
              >
                Объявление <ExternalLink size={11} />
              </a>
            )}
          </div>

          {/* ── Memory snapshot (three orthogonal projections) ─────── */}
          <div className="md:w-72 shrink-0 w-full" data-testid="vehicle-memory-card">
            <div
              className="p-4 rounded-md"
              style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${tone}33` }}
            >
              <div className="slash-label mb-2" style={{ color: tone }}>
                {STAGE_LABEL[m.memoryStage]}
              </div>
              <div className="font-semibold text-sm mb-1" data-testid="vehicle-memory-perception">
                {PERCEPTION_LABEL[m.customerPerception]}
              </div>
              <p className="text-2xs leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                {STAGE_DESCRIPTION[m.memoryStage]}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-3 text-2xs">
                <span className="surface-chip !py-1 !px-2" data-testid="vehicle-memory-status">
                  status: {m.operationalStatus}
                </span>
                {m.flags.hasInspection && (
                  <span className="surface-chip !py-1 !px-2 inline-flex items-center gap-1">
                    <CheckCircle2 size={10} /> inspection
                  </span>
                )}
                {m.flags.hasAcceptedQuote && (
                  <span className="surface-chip !py-1 !px-2 inline-flex items-center gap-1">
                    <Tag size={10} /> quote
                  </span>
                )}
                {m.flags.hasPaidPayment && (
                  <span className="surface-chip !py-1 !px-2 inline-flex items-center gap-1">
                    <CreditCard size={10} /> paid
                  </span>
                )}
                {m.flags.hasCompletedBooking && (
                  <span className="surface-chip !py-1 !px-2 inline-flex items-center gap-1">
                    <Calendar size={10} /> delivered
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* ── Timeline ─────────────────────────────────────────────── */}
        <section data-testid="vehicle-timeline">
          <div className="slash-label mb-3">ХРОНОЛОГИЯ</div>
          {timeline.length === 0 ? (
            <div className="card text-center py-10">
              <Info size={28} className="mx-auto mb-2" style={{ color: 'var(--text-2)' }} />
              <p className="text-sm" style={{ color: 'var(--text-soft)' }}>
                Хронология пуста. Запросите осмотр или сохраните заметку, чтобы появились первые события.
              </p>
            </div>
          ) : (
            <ol className="space-y-2.5">
              {timeline.map((it) => (
                <li
                  key={it.id}
                  className="provider-card p-4 flex gap-3 items-start"
                  data-testid={`timeline-item-${it.kind}`}
                >
                  <span className="icon-badge-soft !w-9 !h-9 shrink-0">
                    {KIND_ICON(it.kind, it.severity)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-semibold text-sm">{it.title}</span>
                      <span className="text-2xs" style={{ color: 'var(--text-soft)' }}>
                        {formatDate(it.at)}
                      </span>
                      {it.severity === 'warning' && (
                        <span className="surface-chip !py-0.5 !px-1.5 text-2xs inline-flex items-center gap-1">
                          <AlertTriangle size={9} /> внимание
                        </span>
                      )}
                      {it.severity === 'danger' && (
                        <span
                          className="surface-chip !py-0.5 !px-1.5 text-2xs inline-flex items-center gap-1"
                          style={{ color: 'var(--danger)' }}
                        >
                          <AlertCircle size={9} /> риск
                        </span>
                      )}
                    </div>
                    {it.body && (
                      <p className="text-2xs mt-1" style={{ color: 'var(--text-soft)' }}>
                        {it.body}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* ── Linked artefacts sidebar ─────────────────────────────── */}
        <aside className="space-y-4" data-testid="vehicle-linked">
          <div className="card-elevated">
            <div className="slash-label mb-3">СВЯЗАННЫЕ ЗАПИСИ</div>
            <ul className="space-y-2 text-xs">
              <li className="flex items-center justify-between">
                <span style={{ color: 'var(--text-soft)' }}>Осмотры</span>
                <span className="font-semibold" data-testid="counts-reports">{m.counts.reports}</span>
              </li>
              <li className="flex items-center justify-between">
                <span style={{ color: 'var(--text-soft)' }}>Предложения</span>
                <span className="font-semibold" data-testid="counts-quotes">{m.counts.quotes}</span>
              </li>
              <li className="flex items-center justify-between">
                <span style={{ color: 'var(--text-soft)' }}>Платежи</span>
                <span className="font-semibold" data-testid="counts-payments">{m.counts.payments}</span>
              </li>
              <li className="flex items-center justify-between">
                <span style={{ color: 'var(--text-soft)' }}>Бронирования</span>
                <span className="font-semibold" data-testid="counts-bookings">{m.counts.bookings}</span>
              </li>
            </ul>
            {m.counts.reports + m.counts.quotes + m.counts.payments + m.counts.bookings === 0 && (
              <p className="text-2xs mt-3 leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                Связанные записи появятся, когда вы запросите осмотр, получите предложение или забронируете доставку для этого авто.
              </p>
            )}
          </div>

          {raw.notes && (
            <div className="card-elevated" data-testid="vehicle-notes">
              <div className="slash-label mb-2">ЗАМЕТКА</div>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                {raw.notes}
              </p>
            </div>
          )}

          <Link
            to={`/inspect?vehicleId=${encodeURIComponent(raw.id)}${raw.listing_url ? `&url=${encodeURIComponent(raw.listing_url)}` : ''}`}
            className="btn-primary w-full inline-flex items-center justify-center gap-2"
            data-testid="vehicle-request-inspection"
          >
            <Clock size={14} /> Запросить осмотр
          </Link>
        </aside>
      </div>
    </div>
  );
}
