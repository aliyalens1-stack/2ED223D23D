import { useEffect, useState, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, MapPin, List, SlidersHorizontal, X } from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { marketplaceAPI } from '../../services/api';
import { ProviderCard } from '../../components/marketplace/ProviderCard';

/**
 * Sprint 14 — Light SearchPage
 * Three-column on map view: filters · results · map
 * Two-column otherwise: filters · results
 * Filters as soft checkboxes (Booking-class), not buttons.
 */

type SortKey = 'recommended' | 'nearest' | 'fastest' | 'cheapest' | 'rating';

const FILTER_KEYS = ['open', 'mobile', 'rating', 'verified', 'urgent', 'near'] as const;
const SORT_KEYS: SortKey[] = ['recommended', 'nearest', 'fastest', 'cheapest', 'rating'];

// Yellow pin icon for Leaflet
const yellowPin = L.divIcon({
  className: '',
  html: `<div style="width:32px;height:32px;background:#f5b800;border:3px solid #fff;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 10px rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:center;"><div style="transform:rotate(45deg);color:#111;font-weight:900;font-size:13px;">⚡</div></div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 32],
});

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();
  const isMap = searchParams.get('view') === 'map';
  const initialQ = searchParams.get('q') || '';
  const initialProblem = searchParams.get('problem') || '';

  const [providers, setProviders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(initialQ);
  const [sort, setSort] = useState<SortKey>('recommended');
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());
  const [maxPrice, setMaxPrice] = useState(5000);
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await marketplaceAPI.getProviders();
      const list = res.data?.providers ?? res.data ?? [];
      setProviders(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  const toggleFilter = (key: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Local filtering + sorting (front-only — backend is queried full)
  const filtered = useMemo(() => {
    let list = [...providers];

    if (q.trim()) {
      const needle = q.toLowerCase();
      list = list.filter((p) =>
        (p.name || '').toLowerCase().includes(needle) ||
        (p.description || '').toLowerCase().includes(needle) ||
        (p.address || '').toLowerCase().includes(needle)
      );
    }
    if (initialProblem) {
      // No tag matching yet — keep list, badge it later when /api/services/categories is wired here.
    }
    if (activeFilters.has('open'))     list = list.filter((p) => p.isOnline ?? true);
    if (activeFilters.has('mobile'))   list = list.filter((p) => p.mobileService || (p.badges || []).includes('mobile'));
    if (activeFilters.has('rating'))   list = list.filter((p) => (p.ratingAvg ?? p.rating ?? 0) >= 4.5);
    if (activeFilters.has('verified')) list = list.filter((p) => p.isVerified || p.verified || (p.badges || []).includes('verified'));
    if (activeFilters.has('near'))     list = list.filter((p) => (p.distanceKm ?? p.distance ?? 999) <= 5);
    list = list.filter((p) => (p.priceFrom ?? p.minPrice ?? 0) <= maxPrice);

    switch (sort) {
      case 'nearest':  list.sort((a, b) => (a.distanceKm ?? a.distance ?? 999) - (b.distanceKm ?? b.distance ?? 999)); break;
      case 'fastest':  list.sort((a, b) => (a.etaMin ?? a.eta ?? 999) - (b.etaMin ?? b.eta ?? 999)); break;
      case 'cheapest': list.sort((a, b) => (a.priceFrom ?? a.minPrice ?? 99999) - (b.priceFrom ?? b.minPrice ?? 99999)); break;
      case 'rating':   list.sort((a, b) => (b.ratingAvg ?? b.rating ?? 0) - (a.ratingAvg ?? a.rating ?? 0)); break;
      default: break;
    }

    return list;
  }, [providers, q, sort, activeFilters, maxPrice, initialProblem]);

  const toggleView = () => {
    const next = new URLSearchParams(searchParams);
    if (isMap) next.delete('view');
    else next.set('view', 'map');
    setSearchParams(next);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 md:px-6 py-8" data-testid="search-page">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight" data-testid="search-title">
          {t('search.title')}
        </h1>
        <p className="mt-2 text-[var(--text-2)]">{t('search.subtitle')}</p>
      </div>

      {/* Search bar */}
      <div className="mb-6 rounded-2xl border border-[var(--border)] bg-white p-3 md:p-4 shadow-[var(--shadow-card)]" data-testid="search-controls">
        <div className="flex flex-col gap-2 md:flex-row md:gap-3">
          <div className="flex-1 input-shell">
            <Search size={16} className="text-[var(--text-soft)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('search.search_placeholder')}
              data-testid="search-q"
            />
            {q && (
              <button onClick={() => setQ('')} className="text-[var(--text-soft)] hover:text-[var(--text)]" aria-label={t('search.clear')}>
                <X size={14} />
              </button>
            )}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="select-light md:w-48"
            data-testid="search-sort"
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>{t(`search.sort.${k}`)}</option>
            ))}
          </select>
          <button
            onClick={() => setFiltersOpen(true)}
            className="btn-secondary md:hidden"
            data-testid="search-filters-mobile"
          >
            <SlidersHorizontal size={16} /> {t('search.filters_mobile')}
          </button>
          <button
            onClick={toggleView}
            className="btn-dark md:w-auto"
            data-testid="search-toggle-view"
          >
            {isMap ? <><List size={16} /> {t('search.view_list')}</> : <><MapPin size={16} /> {t('search.view_map')}</>}
          </button>
        </div>
      </div>

      <div className={isMap ? 'grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_400px]' : 'grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]'}>
        {/* ── Filters (desktop sidebar) ──────────────────── */}
        <aside className="hidden lg:block h-fit rounded-2xl border border-[var(--border)] bg-white p-5 shadow-[var(--shadow-card)] sticky top-20" data-testid="search-filters-desktop">
          <FiltersBlock
            activeFilters={activeFilters}
            onToggle={toggleFilter}
            maxPrice={maxPrice}
            onPrice={setMaxPrice}
          />
        </aside>

        {/* ── Results ────────────────────────────────────── */}
        <main className="min-w-0 space-y-4" data-testid="search-results">
          <div className="flex items-center justify-between">
            <div className="text-sm font-bold text-[var(--text-2)]" data-testid="search-count">
              {loading ? t('search.loading') : t(filtered.length === 1 ? 'search.results_one' : 'search.results_other', { count: filtered.length })}
            </div>
            {activeFilters.size > 0 && (
              <button
                onClick={() => setActiveFilters(new Set())}
                className="text-sm font-semibold text-[var(--text-2)] hover:text-[var(--text)]"
                data-testid="search-clear-filters"
              >
                {t('search.clear_filters')}
              </button>
            )}
          </div>

          {!loading && filtered.length === 0 ? (
            <EmptyResults onClear={() => { setActiveFilters(new Set()); setQ(''); setMaxPrice(5000); }} />
          ) : (
            filtered.map((provider) => (
              <ProviderCard key={provider.id || provider._id || provider.slug} provider={provider} />
            ))
          )}
        </main>

        {/* ── Map panel ───────────────────────────────────── */}
        {isMap && (
          <aside className="hidden lg:block sticky top-20 h-[calc(100vh-7rem)] overflow-hidden rounded-2xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]" data-testid="search-map">
            <MapPanel providers={filtered} />
          </aside>
        )}
      </div>

      {/* Filters mobile drawer */}
      {filtersOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="search-filters-drawer">
          <div className="absolute inset-0 bg-black/40" onClick={() => setFiltersOpen(false)} />
          <aside className="absolute bottom-0 left-0 right-0 max-h-[85vh] overflow-y-auto rounded-t-3xl bg-white border-t border-[var(--border)]">
            <div className="flex items-center justify-between p-5 border-b border-[var(--border)]">
              <div className="font-extrabold text-lg">{t('search.filters')}</div>
              <button onClick={() => setFiltersOpen(false)} className="h-9 w-9 rounded-lg hover:bg-[var(--surface-soft)] flex items-center justify-center" aria-label={t('common.close')}><X size={18} /></button>
            </div>
            <div className="p-5">
              <FiltersBlock
                activeFilters={activeFilters}
                onToggle={toggleFilter}
                maxPrice={maxPrice}
                onPrice={setMaxPrice}
              />
            </div>
            <div className="sticky bottom-0 bg-white border-t border-[var(--border)] p-4">
              <button onClick={() => setFiltersOpen(false)} className="btn-primary w-full">
                {t('search.show_results', { count: filtered.length })}
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function FiltersBlock({
  activeFilters,
  onToggle,
  maxPrice,
  onPrice,
}: {
  activeFilters: Set<string>;
  onToggle: (k: string) => void;
  maxPrice: number;
  onPrice: (n: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <h3 className="text-base font-extrabold mb-4">{t('search.filters')}</h3>
      <div className="space-y-1">
        {FILTER_KEYS.map((key) => (
          <label
            key={key}
            className="flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-[var(--surface-soft)]"
            data-testid={`filter-${key}`}
          >
            <input
              type="checkbox"
              checked={activeFilters.has(key)}
              onChange={() => onToggle(key)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            <span className="text-sm font-semibold text-[var(--text)]">{t(`search.filter.${key}`)}</span>
          </label>
        ))}
      </div>

      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-bold">{t('search.filter.price_up_to')}</span>
          <span className="text-sm font-extrabold">{maxPrice} €</span>
        </div>
        <input
          type="range"
          min={50}
          max={5000}
          step={50}
          value={maxPrice}
          onChange={(e) => onPrice(Number(e.target.value))}
          className="w-full accent-[var(--primary)]"
          data-testid="filter-price"
        />
        <div className="flex justify-between text-[11px] text-[var(--text-soft)] mt-1">
          <span>50 €</span><span>5 000 €</span>
        </div>
      </div>
    </>
  );
}

function EmptyResults({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-2xl border border-dashed border-[var(--border-strong)] bg-white p-10 text-center" data-testid="search-empty">
      <Search size={28} className="mx-auto text-[var(--text-soft)] mb-3" />
      <div className="font-bold mb-1">{t('search.empty.title')}</div>
      <p className="text-sm text-[var(--text-2)] mb-4">{t('search.empty.subtitle')}</p>
      <button onClick={onClear} className="btn-primary btn-sm" data-testid="search-empty-clear">
        {t('search.empty.clear_all')}
      </button>
    </div>
  );
}

function MapPanel({ providers }: { providers: any[] }) {
  const { t } = useTranslation();
  const withGeo = providers.filter((p) => Array.isArray(p?.location?.coordinates) && p.location.coordinates.length === 2);
  const center: [number, number] = withGeo.length > 0
    ? [withGeo[0].location.coordinates[1], withGeo[0].location.coordinates[0]]
    : [52.520008, 13.404954];

  return (
    <div className="relative h-full">
      <div className="absolute right-3 top-3 z-[500] rounded-xl bg-white px-3 py-2 shadow-[var(--shadow-card)] border border-[var(--border)] pointer-events-none">
        <div className="text-xs font-extrabold">{t('search.map.title')}</div>
        <div className="text-[11px] text-[var(--text-soft)]">{t('search.map.providers_nearby', { count: providers.length })}</div>
      </div>
      <MapContainer center={center} zoom={12} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; OpenStreetMap'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {withGeo.map((p) => (
          <Marker
            key={p.id || p._id || p.slug}
            position={[p.location.coordinates[1], p.location.coordinates[0]]}
            icon={yellowPin}
          >
            <Popup>
              <div className="font-extrabold mb-0.5">{p.name}</div>
              <div className="text-xs text-[var(--text-2)]">⭐ {Number(p.ratingAvg ?? p.rating ?? 0).toFixed(1)} · {t('search.map.from')} {p.priceFrom ?? p.minPrice ?? '—'} €</div>
              <Link to={`/provider/${p.slug || p.id || p._id}`} className="text-xs font-bold text-[var(--primary-h)] hover:underline mt-1 inline-block">{t('search.map.view_profile')}</Link>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
