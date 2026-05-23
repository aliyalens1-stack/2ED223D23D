import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Zap, Star, MapPin, Clock, ShieldCheck, ChevronRight, ArrowLeft, AlertTriangle, Loader2, CheckCircle2, Radio } from 'lucide-react';
import api from '../services/api';
import { realtime } from '../lib/socket';

/**
 * Sprint 14.5 + 15 — Quick Request Modal (Problem → Solution → Auto-Dispatch)
 *
 * Flow:
 *   input → matching → waiting (60s, realtime auto-assign) → assigned   (→ /booking/:id)
 *                                                          → fallback (top-5 picker if nobody accepted)
 *                                                          → error
 */

type QuickStep = 'input' | 'matching' | 'waiting' | 'assigned' | 'fallback' | 'error';

interface Solution {
  providerId: string;
  slug: string;
  name: string;
  rating: number;
  reviewsCount: number;
  eta: number;
  etaText: string;
  distance: number;
  distanceText: string;
  priceFrom: number;
  finalPrice?: number;        // Sprint 16
  surge?: number;             // Sprint 16
  surgeLabel?: string;        // Sprint 16
  surgeKind?: 'high' | 'normal' | 'low';
  isOnline: boolean;
  matchScore: number;
  badges?: string[];
  warranty?: string;
  vatIncluded?: boolean;
}

interface ResolveResponse {
  requestId:       string;
  status:          'searching' | 'assigned' | 'expired';
  expiresInSec:    number;
  targetProviders: string[];
  problemType:     string;
  problemLabel:    string;
  matchedCount:    number;
  solutions:       Solution[];
  recommended:     string | null;
  recommendedSlug: string | null;
  echoText:        string;
  // Sprint 16
  zoneId?:         string;
  zoneName?:       string;
  zoneStatus?:     string;
  surge?:          number;
  surgeLabel?:     string;
  surgeKind?:      'high' | 'normal' | 'low';
}

interface AssignedPayload {
  requestId:     string;
  bookingId:     string;
  providerSlug:  string;
  providerName:  string;
  providerRating: number;
  etaText:       string;
  priceEstimate: number;
}

const SUGGESTIONS = [
  "Car won't start",
  'Engine noise',
  'Brake problem',
  'Battery dead',
  'Need tow truck',
  'Diagnostics',
];

export default function QuickRequestModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [step, setStep]       = useState<QuickStep>('input');
  const [text, setText]       = useState('');
  const [data, setData]       = useState<ResolveResponse | null>(null);
  const [error, setError]     = useState<string>('');
  const [secondsLeft, setSecondsLeft] = useState(60);
  const [assigned, setAssigned] = useState<AssignedPayload | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef  = useRef<number | null>(null);
  const tickRef  = useRef<number | null>(null);
  const wsUnsub  = useRef<null | (() => void)>(null);

  useEffect(() => {
    if (isOpen) {
      setStep('input');
      setText('');
      setData(null);
      setError('');
      setAssigned(null);
      setTimeout(() => inputRef.current?.focus(), 100);
    } else {
      cleanupWaiting();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => () => cleanupWaiting(), []);

  const cleanupWaiting = () => {
    if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null; }
    if (tickRef.current) { window.clearInterval(tickRef.current); tickRef.current = null; }
    if (wsUnsub.current) { wsUnsub.current(); wsUnsub.current = null; }
  };

  if (!isOpen) return null;

  const submit = async () => {
    if (!text.trim()) return;
    setStep('matching');
    setError('');
    try {
      const location = await getLocationOrFallback();
      const res = await api.post<ResolveResponse>('/quick-request/resolve', { text: text.trim(), location });
      if (!res.data?.solutions?.length) {
        setError('No mechanics available right now. Please try again in a few minutes.');
        setStep('error');
        return;
      }
      setData(res.data);
      setSecondsLeft(res.data.expiresInSec || 60);
      setStep('waiting');
      startWaitingFlow(res.data.requestId, res.data.expiresInSec || 60);
    } catch (e: any) {
      setError(e?.message || 'Could not reach the matching service.');
      setStep('error');
    }
  };

  const startWaitingFlow = (requestId: string, ttl: number) => {
    cleanupWaiting();
    let remaining = ttl;
    setSecondsLeft(remaining);

    // WS — fastest path
    realtime.connect();
    wsUnsub.current = realtime.on<AssignedPayload>('request:assigned', (payload) => {
      if (payload?.requestId !== requestId) return;
      handleAssigned(payload);
    });

    // Polling fallback (every 2.5s)
    pollRef.current = window.setInterval(async () => {
      try {
        const r = await api.get<any>(`/quick-request/${requestId}`);
        const s = r.data?.status;
        if (s === 'assigned' && r.data?.bookingId) {
          handleAssigned({
            requestId,
            bookingId: r.data.bookingId,
            providerSlug: r.data.providerId,
            providerName: r.data.provider?.name || 'Mechanic',
            providerRating: r.data.provider?.rating || 0,
            etaText: r.data.provider?.avgResponseTimeMinutes ? `${r.data.provider.avgResponseTimeMinutes} min` : '',
            priceEstimate: 0,
          });
        } else if (s === 'expired' || s === 'cancelled') {
          handleExpired();
        }
      } catch {/* keep waiting */}
    }, 2500);

    // Countdown ticker (1s)
    tickRef.current = window.setInterval(() => {
      remaining -= 1;
      setSecondsLeft(Math.max(0, remaining));
      if (remaining <= 0) handleExpired();
    }, 1000);
  };

  const handleAssigned = (payload: AssignedPayload) => {
    cleanupWaiting();
    setAssigned(payload);
    setStep('assigned');
    // Auto-redirect to booking after a brief celebration
    window.setTimeout(() => {
      onClose();
      navigate(`/booking/${payload.bookingId}`);
    }, 1800);
  };

  const handleExpired = () => {
    cleanupWaiting();
    setStep('fallback');
  };

  const cancelWaiting = () => {
    cleanupWaiting();
    setStep('fallback');
  };

  const handleBook = (slug: string) => {
    onClose();
    navigate(`/provider/${slug}?action=book`);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-end md:items-center justify-center modal-backdrop p-0 md:p-4" onClick={onClose} data-testid="qr-modal">
      <div
        className="modal-content relative w-full md:max-w-lg p-6 max-h-[90vh] overflow-y-auto rounded-t-3xl md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="qr-modal-content"
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 h-9 w-9 rounded-xl border border-[var(--border)] bg-white hover:bg-[var(--surface-soft)] flex items-center justify-center"
          aria-label="Close"
          data-testid="qr-close"
        >
          <X size={16} />
        </button>

        {step === 'input' && (
          <>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)]">⚡ Quick request</span>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-2" data-testid="qr-title">
              What happened?
            </h2>
            <p className="text-sm text-[var(--text-2)] mb-5">Describe your problem in one sentence — we'll dispatch the nearest mechanic to you.</p>

            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              placeholder="Car won't start, engine noise…"
              className="input-light input-lg"
              data-testid="qr-input"
              maxLength={140}
            />

            <div className="mt-3 flex flex-wrap gap-1.5" data-testid="qr-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setText(s)}
                  className="chip text-xs"
                  data-testid={`qr-suggest-${s.split(' ')[0].toLowerCase()}`}
                >
                  {s}
                </button>
              ))}
            </div>

            <button
              onClick={submit}
              disabled={!text.trim()}
              className="btn-primary btn-lg w-full mt-5 disabled:opacity-50"
              data-testid="qr-submit"
            >
              <Zap size={18} /> Find solution
            </button>
            <div className="mt-3 flex items-center justify-center gap-3 text-[11px] text-[var(--text-soft)]">
              <span className="inline-flex items-center gap-1"><ShieldCheck size={12} /> Verified workshops</span>
              <span>·</span>
              <span>VAT included · Invoice ready</span>
            </div>
          </>
        )}

        {step === 'matching' && (
          <div className="py-10 text-center" data-testid="qr-matching">
            <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--primary-soft)] mb-5">
              <Loader2 size={28} className="text-[var(--primary-p)] animate-spin" />
            </div>
            <h3 className="text-xl font-extrabold mb-1">Analyzing your problem…</h3>
            <p className="text-sm text-[var(--text-2)]">Picking the best mechanics</p>
          </div>
        )}

        {step === 'waiting' && data && (
          <div data-testid="qr-waiting">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)]">
                <Radio size={12} className="inline mr-1 -mt-0.5" />
                {data.problemLabel} · Live dispatch
              </span>
              {data.surge && data.surge > 1.05 && (
                <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-orange-100 text-orange-700 border border-orange-200" data-testid="qr-waiting-surge">
                  🔥 {data.surgeLabel}
                </span>
              )}
              {data.surge && data.surge < 0.95 && (
                <span className="text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200" data-testid="qr-waiting-surge">
                  ↓ {data.surgeLabel}
                </span>
              )}
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight mb-1">Finding mechanic…</h2>
            <p className="text-sm text-[var(--text-2)] mb-6">
              We notified <b>{data.targetProviders.length}</b> closest mechanics in <b>{data.zoneName || 'your area'}</b>. The first one to accept gets the job.
            </p>

            {/* Pulsing dispatch animation */}
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-soft)] p-6 text-center">
              <div className="relative inline-flex items-center justify-center">
                <span className="absolute inline-flex h-20 w-20 rounded-full bg-[var(--primary)] opacity-60 animate-ping" />
                <span className="absolute inline-flex h-14 w-14 rounded-full bg-[var(--primary)] opacity-80 animate-pulse" />
                <span className="relative inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--primary)] text-black">
                  <Zap size={20} />
                </span>
              </div>
              <div className="mt-6 text-3xl font-black tabular-nums" data-testid="qr-countdown">
                {String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:{String(secondsLeft % 60).padStart(2, '0')}
              </div>
              <div className="text-xs uppercase tracking-wider font-semibold text-[var(--text-soft)] mt-1">
                waiting for accept
              </div>
              <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white">
                <div
                  className="h-full bg-[var(--primary)] transition-all duration-1000"
                  style={{ width: `${Math.max(2, (secondsLeft / (data.expiresInSec || 60)) * 100)}%` }}
                />
              </div>
            </div>

            {/* Notified providers */}
            <div className="mt-5 space-y-2" data-testid="qr-targets">
              <div className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-soft)] mb-1">
                Notified now
              </div>
              {data.solutions.slice(0, 3).map((s, i) => (
                <div
                  key={s.slug}
                  className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-white p-3"
                >
                  <div className="h-9 w-9 rounded-lg bg-[var(--primary-soft)] text-[var(--primary-p)] flex items-center justify-center font-extrabold text-sm">
                    #{i + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-bold truncate">{s.name}</div>
                    <div className="text-xs text-[var(--text-2)] flex items-center gap-2 mt-0.5">
                      <span className="inline-flex items-center gap-1"><Star size={11} className="text-[var(--primary)] fill-[var(--primary)]" /> {s.rating}</span>
                      <span>·</span>
                      <span>{s.distanceText}</span>
                      <span>·</span>
                      <span>{s.etaText}</span>
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1.5 text-xs text-[var(--text-soft)] shrink-0">
                    <span className="h-2 w-2 rounded-full bg-[var(--primary)] animate-pulse" />
                    Pinging
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={cancelWaiting}
              className="btn-ghost w-full mt-5"
              data-testid="qr-cancel-waiting"
            >
              Pick manually instead
            </button>
          </div>
        )}

        {step === 'assigned' && assigned && (
          <div className="py-8 text-center" data-testid="qr-assigned">
            <div className="inline-flex h-16 w-16 items-center justify-center rounded-full bg-[var(--success-soft)] mb-4">
              <CheckCircle2 size={30} className="text-[var(--success)]" />
            </div>
            <h2 className="text-2xl font-extrabold mb-1">Mechanic on the way</h2>
            <p className="text-sm text-[var(--text-2)] mb-5">
              <b>{assigned.providerName}</b> accepted your request{assigned.etaText ? <> · ETA <b>{assigned.etaText}</b></> : null}
            </p>
            <div className="rounded-xl border border-[var(--border)] bg-white p-4 text-left">
              <div className="flex items-center justify-between">
                <div className="font-bold">{assigned.providerName}</div>
                {assigned.providerRating > 0 && (
                  <div className="inline-flex items-center gap-1 text-sm font-bold">
                    <Star size={13} className="text-[var(--primary)] fill-[var(--primary)]" /> {assigned.providerRating.toFixed(1)}
                  </div>
                )}
              </div>
              <div className="text-xs text-[var(--text-soft)] mt-1">Opening booking…</div>
            </div>
          </div>
        )}

        {step === 'fallback' && data && (
          <div data-testid="qr-result">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary-h)]">⚡ {data.problemLabel}</span>
            </div>
            <h2 className="text-2xl font-extrabold tracking-tight mb-1">Pick your mechanic</h2>
            <p className="text-sm text-[var(--text-2)] mb-5">
              Auto-dispatch timed out. Choose one of {data.solutions.length} ready mechanics.
            </p>

            {/* Best */}
            <BestMatchCard solution={data.solutions[0]} onBook={() => handleBook(data.recommendedSlug || data.solutions[0].slug)} />

            {/* Alternatives */}
            {data.solutions.length > 1 && (
              <>
                <div className="mt-5 mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[var(--text-soft)]">
                  Alternatives
                </div>
                <div className="space-y-2" data-testid="qr-alternatives">
                  {data.solutions.slice(1, 4).map((s) => (
                    <AltCard key={s.providerId} s={s} onBook={() => handleBook(s.slug)} />
                  ))}
                </div>
              </>
            )}

            <button onClick={() => setStep('input')} className="btn-ghost w-full mt-4" data-testid="qr-back">
              <ArrowLeft size={14} /> Refine your problem
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="py-8 text-center" data-testid="qr-error">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-[var(--danger-soft)] mb-4">
              <AlertTriangle size={26} className="text-[var(--danger)]" />
            </div>
            <h3 className="text-lg font-extrabold mb-1">Something went wrong</h3>
            <p className="text-sm text-[var(--text-2)] mb-5">{error}</p>
            <button onClick={() => setStep('input')} className="btn-secondary w-full" data-testid="qr-retry">
              <ArrowLeft size={14} /> Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── helpers ──────────────────────────────────────────────── */

async function getLocationOrFallback(): Promise<{ lat: number; lng: number }> {
  if (!navigator.geolocation) return { lat: 52.520008, lng: 13.404954 }; // Berlin
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ lat: 52.520008, lng: 13.404954 }), 1500);
    navigator.geolocation.getCurrentPosition(
      (pos) => { clearTimeout(t); resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }); },
      ()    => { clearTimeout(t); resolve({ lat: 52.520008, lng: 13.404954 }); },
      { timeout: 1500, maximumAge: 60_000 }
    );
  });
}

function BestMatchCard({ solution, onBook }: { solution: Solution; onBook: () => void }) {
  const matchPercent = Math.round(solution.matchScore * 100);
  const surge = solution.surge ?? 1;
  const finalPrice = solution.finalPrice ?? solution.priceFrom;
  const surgeApplied = surge > 1.05 || surge < 0.95;
  const isHigh = surge > 1.05;
  return (
    <div className="rounded-2xl border-2 border-[var(--primary)] bg-white p-5 shadow-[var(--shadow-card)]" data-testid="qr-best">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span className="badge badge-solid">{matchPercent}% match</span>
            {solution.isOnline && <span className="badge badge-success">Open</span>}
            {surgeApplied && (
              <span
                className={`text-[10px] font-extrabold uppercase tracking-wider px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                  isHigh ? 'bg-orange-100 text-orange-700 border border-orange-200' : 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                }`}
                data-testid="qr-best-surge"
              >
                {isHigh ? '🔥' : '↓'} {solution.surgeLabel}
              </span>
            )}
          </div>
          <div className="text-xl font-extrabold mt-1">{solution.name}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-2)]">
            <span className="inline-flex items-center gap-1 font-semibold text-[var(--text)]">
              <Star size={14} className="text-[var(--primary)] fill-[var(--primary)]" />
              {solution.rating}
              {solution.reviewsCount > 0 && <span className="text-[var(--text-soft)] font-normal">({solution.reviewsCount})</span>}
            </span>
            <span className="inline-flex items-center gap-1"><MapPin size={14} className="text-[var(--text-soft)]" /> {solution.distanceText}</span>
            <span className="inline-flex items-center gap-1"><Clock size={14} className="text-[var(--text-soft)]" /> {solution.etaText}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-[var(--border)] pt-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--text-soft)]">from</div>
          <div className="flex items-baseline gap-2">
            <div className={`text-2xl font-extrabold ${isHigh ? 'text-orange-700' : ''}`} data-testid="qr-best-final-price">
              {finalPrice} €
            </div>
            {surgeApplied && (
              <div className="text-sm text-[var(--text-soft)] line-through" data-testid="qr-best-base-price">
                {solution.priceFrom} €
              </div>
            )}
          </div>
          <div className="text-[10px] text-[var(--text-soft)]">
            {surgeApplied ? <>Includes {solution.surgeLabel?.toLowerCase()}</> : <>VAT incl. · {solution.warranty}</>}
          </div>
        </div>
        <button onClick={onBook} className="btn-primary btn-lg" data-testid="qr-best-book">
          Book now <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function AltCard({ s, onBook }: { s: Solution; onBook: () => void }) {
  const final = s.finalPrice ?? s.priceFrom;
  const surgeApplied = (s.surge ?? 1) > 1.05 || (s.surge ?? 1) < 0.95;
  const isHigh = (s.surge ?? 1) > 1.05;
  return (
    <button
      onClick={onBook}
      className="w-full text-left rounded-xl border border-[var(--border)] bg-white p-3 hover:border-[var(--border-strong)] hover:shadow-[var(--shadow-card)] transition flex items-center gap-3"
      data-testid={`qr-alt-${s.slug}`}
    >
      <div className="min-w-0 flex-1">
        <div className="font-bold truncate">{s.name}</div>
        <div className="text-xs text-[var(--text-2)] flex items-center gap-2 mt-0.5">
          <span className="inline-flex items-center gap-1"><Star size={11} className="text-[var(--primary)] fill-[var(--primary)]" /> {s.rating}</span>
          <span>·</span>
          <span>{s.distanceText}</span>
          <span>·</span>
          <span>{s.etaText}</span>
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={`text-sm font-extrabold ${isHigh ? 'text-orange-700' : ''}`}>{final} €</div>
        <div className="text-[10px] text-[var(--text-soft)]">
          {surgeApplied ? (isHigh ? '+surge' : 'low demand') : 'from'}
        </div>
      </div>
      <ChevronRight size={16} className="text-[var(--text-soft)] shrink-0" />
    </button>
  );
}
