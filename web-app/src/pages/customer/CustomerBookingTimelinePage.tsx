// P0.b.C.d.UI.a — Customer booking timeline page (server-projected + live).
//
// First UI consumer of the C.a/C.d server-side projection model.
//
//   /customer/bookings/:bookingId/timeline
//
// Sister surfaces (provider/inspector/admin) will land later with their
// OWN reducer + page colocated in their own folders. We deliberately do
// not abstract this page or its hook — duplication here is semantic
// insulation, identical reasoning to the backend projection split.
//
// Display contract:
//   • Renders ONLY the server-projected `events[]`. Never re-derives.
//   • Tone vocabulary surfaces via a small local map (purely
//     presentational; the tone STRING comes from the server).
//   • Live affordance: a subtle "live" pulse when WS connected.
//   • Manual refresh is always available — REST is source of truth.

import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Radio } from 'lucide-react';
import {
  useCustomerBookingTimeline,
  type CustomerTimelineEvent,
} from './useBookingTimeline';

// ─────────────────────────────────────────────────────────────────────
// Tone → swatch. Pure presentation. The server defines tone semantics
// (customer.py: positive / neutral / celebratory / alert); we just
// map them to visual affordances. New tones land as gray neutral by
// default — invisible-by-default discipline preserved client-side too.
// ─────────────────────────────────────────────────────────────────────

const TONE_STYLES: Record<string, { dot: string; ring: string; copy: string }> = {
  positive:    { dot: '#16a34a', ring: 'ring-green-200',  copy: 'text-green-700' },
  celebratory: { dot: '#0ea5e9', ring: 'ring-sky-200',    copy: 'text-sky-700' },
  alert:       { dot: '#dc2626', ring: 'ring-rose-200',   copy: 'text-rose-700' },
  neutral:     { dot: '#475569', ring: 'ring-slate-200',  copy: 'text-slate-700' },
};

function toneFor(tone: string) {
  return TONE_STYLES[tone] ?? TONE_STYLES.neutral;
}

export default function CustomerBookingTimelinePage() {
  const { bookingId } = useParams<{ bookingId: string }>();
  const {
    events,
    loading,
    error,
    lastSnapshotAt,
    liveConnected,
    receivedLiveSinceSnapshot,
    refresh,
  } = useCustomerBookingTimeline(bookingId);

  return (
    <div
      className="mx-auto max-w-2xl px-4 md:px-6 py-12"
      data-testid="customer-booking-timeline-page"
    >
      <Link
        to="/dashboard/requests"
        className="inline-flex items-center gap-1 text-sm font-bold text-slate-600 hover:text-slate-900 mb-8"
        data-testid="timeline-back-link"
      >
        <ArrowLeft size={16} /> Назад
      </Link>

      <header className="mb-10">
        <p
          className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500 mb-3"
          data-testid="timeline-kicker"
        >
          Заказ {bookingId}
        </p>
        <h1
          className="text-3xl font-extrabold tracking-tight text-slate-900"
          data-testid="timeline-title"
        >
          Хроника заказа
        </h1>
      </header>

      <MetaStrip
        lastSnapshotAt={lastSnapshotAt}
        loading={loading}
        liveConnected={liveConnected}
        liveCount={receivedLiveSinceSnapshot}
        onRefresh={() => { void refresh(); }}
      />

      {error && (
        <p
          className="mt-8 text-sm text-rose-700 leading-relaxed"
          data-testid="timeline-error"
        >
          {error}
        </p>
      )}

      {!error && !loading && events.length === 0 && (
        <p
          className="mt-8 text-sm text-slate-600 leading-relaxed"
          data-testid="timeline-empty"
        >
          Пока нет событий. Они появятся, как только статус заказа изменится.
        </p>
      )}

      {events.length > 0 && (
        <ol
          className="mt-8 space-y-6 border-l border-slate-200 pl-6"
          data-testid="timeline-rail"
        >
          {events.map((row, i) => (
            <TimelineRow key={`${row.at}::${row.key}::${i}`} index={i} row={row} />
          ))}
        </ol>
      )}
    </div>
  );
}

function TimelineRow({ index, row }: { index: number; row: CustomerTimelineEvent }) {
  const t = toneFor(row.tone);
  return (
    <li
      className="relative"
      data-testid={`timeline-row-${index}`}
      data-event-key={row.key}
      data-event-tone={row.tone}
    >
      <span
        className={`absolute -left-[33px] top-1.5 inline-block w-2.5 h-2.5 rounded-full ring-4 ${t.ring}`}
        style={{ backgroundColor: t.dot }}
        aria-hidden
      />
      <p className={`text-[15px] font-extrabold leading-snug ${t.copy}`}>
        {row.label}
      </p>
      {row.description && (
        <p className="mt-1 text-sm text-slate-700 leading-relaxed">
          {row.description}
        </p>
      )}
      <p className="mt-1.5 text-[11px] uppercase tracking-wider text-slate-500">
        {formatAbsolute(row.at)}
        {row.isSelfAction && (
          <span className="ml-2 text-slate-400">· вы</span>
        )}
      </p>
      {row.meta && Object.keys(row.meta).length > 0 && (
        <MetaPills meta={row.meta} />
      )}
    </li>
  );
}

function MetaPills({ meta }: { meta: Record<string, unknown> }) {
  // Pure presentation. The server already sanitised this dict via
  // the customer projection's safe-meta whitelist.
  const entries = Object.entries(meta).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-slate-600 bg-slate-100 rounded-full px-2 py-0.5"
          data-testid={`timeline-meta-${k}`}
        >
          {labelFor(k)}: {String(v)}
        </span>
      ))}
    </div>
  );
}

// Human labels for the customer-whitelisted meta keys.
// Server-side whitelist (customer.py): {reason, eta}. Anything else
// that lands here is server-error and we display the raw key.
const META_LABELS: Record<string, string> = {
  reason: 'причина',
  eta: 'ETA, мин',
};
function labelFor(k: string): string {
  return META_LABELS[k] ?? k;
}

function MetaStrip({
  lastSnapshotAt,
  loading,
  liveConnected,
  liveCount,
  onRefresh,
}: {
  lastSnapshotAt: string | null;
  loading: boolean;
  liveConnected: boolean;
  liveCount: number;
  onRefresh: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between border-b border-slate-200 pb-3 mb-6"
      data-testid="timeline-meta-strip"
    >
      <div className="flex items-center gap-3">
        <p
          className="text-[11px] uppercase tracking-wider text-slate-500"
          data-testid="timeline-meta"
        >
          {lastSnapshotAt
            ? `Обновлено ${formatAbsolute(lastSnapshotAt)}`
            : loading
              ? 'Загрузка…'
              : '—'}
        </p>
        <LivePulse connected={liveConnected} count={liveCount} />
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-40"
        data-testid="timeline-refresh"
      >
        <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Обновить
      </button>
    </div>
  );
}

function LivePulse({ connected, count }: { connected: boolean; count: number }) {
  if (!connected) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-slate-400"
        data-testid="timeline-live-off"
      >
        <Radio size={11} /> off
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wider text-emerald-700"
      data-testid="timeline-live-on"
      title={count > 0 ? `${count} обновлений после последней синхронизации` : 'Соединение активно'}
    >
      <span className="relative flex w-2 h-2">
        <span className="absolute inline-flex w-full h-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
        <span className="relative inline-flex w-2 h-2 rounded-full bg-emerald-500" />
      </span>
      live{count > 0 ? ` · +${count}` : ''}
    </span>
  );
}

// Absolute, language-neutral date. NO relative time — relative time
// strings are a narrative mutation we explicitly avoid on this surface.
function formatAbsolute(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}
