/**
 * FeedPage — `/feed` notification stream for the current anonymous watcher.
 *
 * The retention surface. Where temporal events from watched vehicles
 * surface as a unified, glanceable stream. Newest first, grouped by
 * vehicle. "Mark all as read" button bumps `readAt` server-side.
 *
 * Empty state nudges the user to /vehicle/:id pages — the platform
 * teaches itself.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bell, Check, ArrowLeft, AlertCircle, AlertTriangle, CheckCircle2,
  TrendingDown, TrendingUp, Gauge, EyeOff, RotateCcw, FileText, Wrench,
  Inbox, Plus, Sparkles, X,
} from 'lucide-react';
import { api } from '../../services/api';
import { getWatcherId } from '../../lib/watcher';
import SaveSearchModal from '../../components/SaveSearchModal';

interface FeedItem {
  id: string;
  vehicleId: string;
  vehicleSnapshot?: { brand?: string; model?: string; thumbnail?: string };
  kind: string;
  title: string;
  body?: string;
  severity: 'success' | 'warning' | 'danger' | 'info';
  savingsEur?: number;
  mileage?: number;
  createdAt: string;
  readAt?: string | null;
  marketSearchId?: string;
  marketSearchLabel?: string;
}

interface FeedResp {
  items: FeedItem[];
  count: number;
  unread: number;
}

interface SavedSearch {
  id: string;
  filter: Record<string, unknown>;
  label: string;
  matchCount: number;
  lastMatchAt?: string | null;
  lastMatchVehicleId?: string | null;
  createdAt: string;
}

interface SearchesResp { items: SavedSearch[]; count: number; }

const KIND_ICON: Record<string, React.ReactNode> = {
  price_drop: <TrendingDown size={16} />,
  price_increase: <TrendingUp size={16} />,
  mileage_update: <Gauge size={16} />,
  listing_disappeared: <EyeOff size={16} />,
  relisted: <RotateCcw size={16} />,
  inspection: <FileText size={16} />,
  inspection_completed: <FileText size={16} />,
  match_found: <Sparkles size={16} />,
};

function severityBg(s: string): string {
  switch (s) {
    case 'success': return 'rgba(34,197,94,0.10)';
    case 'warning': return 'rgba(255,176,32,0.12)';
    case 'danger':  return 'rgba(239,68,68,0.12)';
    default:        return 'rgba(125,211,252,0.10)';
  }
}
function severityFg(s: string): string {
  switch (s) {
    case 'success': return '#22C55E';
    case 'warning': return '#FFB020';
    case 'danger':  return '#EF4444';
    default:        return '#7DD3FC';
  }
}
function fmtAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} дн`;
  if (d < 365) return `${Math.floor(d / 30)} мес`;
  return `${Math.floor(d / 365)} г`;
}

export default function FeedPage() {
  const [data, setData] = useState<FeedResp | null>(null);
  const [searches, setSearches] = useState<SavedSearch[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const wid = getWatcherId();
      const [feed, srch] = await Promise.all([
        api.get<FeedResp>(`/watchlist/${wid}/feed`),
        api.get<SearchesResp>(`/watchlist/${wid}/searches`),
      ]);
      setData(feed.data);
      setSearches(srch.data.items || []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function markAllSeen() {
    const wid = getWatcherId();
    await api.post(`/watchlist/${wid}/seen`, {});
    await load();
  }

  async function removeSearch(id: string) {
    const wid = getWatcherId();
    await api.delete(`/searches/${id}?watcherId=${wid}`);
    await load();
  }

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center" data-testid="feed-loading">
        <div className="animate-spin rounded-full h-9 w-9 border-b-2 border-yellow-400" />
      </div>
    );
  }

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  return (
    <div className="bg-[#0A0A0A] text-white min-h-screen" data-testid="feed-page">
      <div className="max-w-[820px] mx-auto px-4 lg:px-8 py-10">
        <Link to="/" className="text-2xs uppercase tracking-widest inline-flex items-center gap-1 text-white/70 hover:text-white">
          <ArrowLeft size={12} /> Главная
        </Link>

        <header className="mt-8 flex items-end justify-between flex-wrap gap-4">
          <div>
            <div className="text-2xs uppercase tracking-[0.2em] text-white/40 mb-2">RETENTION</div>
            <h1 className="font-display tracking-bebas text-[44px] leading-[0.92]">
              Лента изменений
            </h1>
            <div className="text-sm text-white/60 mt-2">
              {unread > 0 ? (
                <>Ваши машины изменились <span className="text-amber font-semibold">{unread} раз{unread > 1 ? 'а' : ''}</span> с последнего визита</>
              ) : items.length > 0 ? (
                'Всё прочитано — пока всё спокойно'
              ) : (
                'Здесь будут появляться изменения по машинам, за которыми вы следите'
              )}
            </div>
          </div>
          {unread > 0 && (
            <button
              onClick={markAllSeen}
              className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-white/8 border border-white/12 text-sm font-semibold hover:bg-white/12 transition"
              data-testid="feed-mark-all-seen"
            >
              <Check size={14} /> Отметить прочитанным
            </button>
          )}
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-xl bg-amber text-black text-sm font-semibold hover:bg-yellow-300 transition"
            data-testid="feed-add-search"
          >
            <Plus size={14} /> Подписаться на рынок
          </button>
        </header>

        {/* Saved searches section */}
        {searches.length > 0 && (
          <section className="mt-8" data-testid="saved-searches">
            <div className="text-2xs uppercase tracking-[0.2em] text-white/40 mb-3">MARKET SUBSCRIPTIONS · {searches.length}</div>
            <ul className="space-y-2">
              {searches.map(s => (
                <li
                  key={s.id}
                  className="rounded-xl p-3 flex items-center gap-3"
                  style={{ background: 'rgba(255,176,32,0.04)', border: '1px solid rgba(255,176,32,0.18)' }}
                  data-testid={`saved-search-${s.id}`}
                >
                  <span className="w-9 h-9 rounded-md flex items-center justify-center" style={{ background: 'rgba(255,176,32,0.14)', color: '#FFB020' }}>
                    <Sparkles size={16} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-semibold truncate">{s.label}</div>
                    <div className="text-2xs text-white/50 mt-0.5">
                      {s.matchCount > 0
                        ? <>Найдено <span className="text-amber font-semibold">{s.matchCount}</span> совпадений · последнее {s.lastMatchAt ? fmtAgo(s.lastMatchAt) + ' назад' : '—'}</>
                        : 'Ждём первое объявление…'}
                    </div>
                  </div>
                  <button
                    onClick={() => removeSearch(s.id)}
                    className="w-8 h-8 rounded-md hover:bg-white/10 flex items-center justify-center text-white/50 hover:text-white"
                    aria-label="Удалить подписку"
                    data-testid={`saved-search-remove-${s.id}`}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {items.length === 0 ? (
          <div
            className="mt-12 rounded-2xl py-20 text-center"
            style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
            data-testid="feed-empty"
          >
            <Inbox size={40} className="mx-auto mb-4 text-white/30" />
            <h2 className="font-display tracking-bebas text-2xl">Лента пока пуста</h2>
            <p className="text-sm text-white/55 mt-2 max-w-md mx-auto">
              Откройте любую машину и нажмите <span className="text-amber font-semibold inline-flex items-center gap-1"><Bell size={13} /> Следить</span>.
              Цена упадёт — узнаете первым.
            </p>
            <Link
              to="/"
              className="inline-block mt-6 px-5 py-2.5 rounded-xl bg-amber text-black text-sm font-semibold hover:bg-yellow-300 transition"
            >
              Найти машину
            </Link>
          </div>
        ) : (
          <ul className="mt-8 space-y-2.5" data-testid="feed-list">
            {items.map(it => (
              <li
                key={it.id}
                className="rounded-xl p-3.5 flex items-start gap-3 transition"
                style={{
                  background: it.readAt ? 'rgba(255,255,255,0.025)' : 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.06)',
                  opacity: it.readAt ? 0.72 : 1,
                }}
                data-testid={`feed-item-${it.kind}`}
              >
                {/* Vehicle thumb */}
                {it.vehicleSnapshot?.thumbnail && (
                  <Link to={`/vehicle/${it.vehicleId}`} className="shrink-0">
                    <img
                      src={it.vehicleSnapshot.thumbnail}
                      alt={`${it.vehicleSnapshot.brand} ${it.vehicleSnapshot.model}`}
                      className="w-14 h-14 rounded-lg object-cover"
                    />
                  </Link>
                )}

                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span
                      className="w-6 h-6 rounded-md inline-flex items-center justify-center"
                      style={{ background: severityBg(it.severity), color: severityFg(it.severity) }}
                    >
                      {KIND_ICON[it.kind] ?? <Wrench size={14} />}
                    </span>
                    <span className="font-semibold text-[15px] truncate">{it.title}</span>
                    <span className="text-2xs text-white/40 ml-auto whitespace-nowrap">{fmtAgo(it.createdAt)}</span>
                  </div>
                  {it.body && (
                    <p className="text-xs text-white/65 mt-1 leading-relaxed">{it.body}</p>
                  )}
                  {it.kind === 'match_found' && it.marketSearchLabel && (
                    <div className="mt-1.5 inline-flex items-center gap-1.5 text-2xs text-amber/85">
                      <Sparkles size={11} /> {it.marketSearchLabel}
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-3">
                    <Link
                      to={`/vehicle/${it.vehicleId}`}
                      className="text-2xs uppercase tracking-widest text-amber hover:text-yellow-300"
                    >
                      {it.vehicleSnapshot?.brand} {it.vehicleSnapshot?.model} →
                    </Link>
                    {!it.readAt && (
                      <span className="w-1.5 h-1.5 rounded-full bg-amber" data-testid={`feed-unread-${it.id}`} />
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {items.length > 0 && (
          <div className="mt-10 text-center text-2xs text-white/35">
            События приходят сами. Закрытие вкладки не сломает поток.
          </div>
        )}
      </div>
    </div>
  );
}
