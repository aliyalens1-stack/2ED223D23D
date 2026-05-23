// Service Marketplace Map — admin heatmap (Sprint 2).
// Backend: GET /api/admin/dispatch/heatmap
// Показывает providers + active requests + topCities + coverage gaps.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map as MapIcon, RefreshCw, AlertTriangle, Loader2, TrendingUp, Users, Zap } from 'lucide-react';

interface ProviderPoint {
  providerId: string;
  lat: number; lng: number;
  city?: string; categories?: string[]; serviceRadiusKm?: number;
}
interface RequestPoint {
  id: string; category: string; city: string;
  location?: { lat: number; lng: number } | null;
  status: string; bidsCount: number; createdAt: string;
  urgency: string; budget?: { min?: number; max?: number } | null;
}
interface Gap { city: string; openRequests: number; providers: number; gap: number; }
interface HeatmapData {
  providers: ProviderPoint[];
  requests: RequestPoint[];
  topCities: { city: string; openRequests: number }[];
  coverage: Record<string, number>;
  gaps: Gap[];
}

const CAT_EMOJI: Record<string, string> = {
  repair: '🔧', tow: '🚛', wash: '🚿', detailing: '✨', battery: '🔋',
  parts: '🔩', delivery: '🚚', inspection: '🛡', car_selection: '🎯',
};

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('admin_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export default function ServiceMarketplaceMap() {
  const [data, setData] = useState<HeatmapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cityFilter, setCityFilter] = useState<string>('');
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const url = `/api/admin/dispatch/heatmap${cityFilter ? `?city=${encodeURIComponent(cityFilter)}` : ''}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e: any) {
      setError(e?.message || 'failed');
    } finally {
      setLoading(false);
    }
  }, [cityFilter]);

  useEffect(() => { load(); }, [load]);

  // Build Leaflet HTML inline → loaded into iframe so we avoid bundle-size hit.
  const mapHtml = useMemo(() => {
    if (!data) return '';
    // Auto-center on mass of points
    const allLat = [
      ...data.providers.map((p) => p.lat),
      ...data.requests.filter((r) => r.location).map((r) => r.location!.lat),
    ];
    const allLng = [
      ...data.providers.map((p) => p.lng),
      ...data.requests.filter((r) => r.location).map((r) => r.location!.lng),
    ];
    const centerLat = allLat.length ? allLat.reduce((a, b) => a + b, 0) / allLat.length : 52.52;
    const centerLng = allLng.length ? allLng.reduce((a, b) => a + b, 0) / allLng.length : 13.405;

    const providerMarkers = data.providers.map((p) => {
      const cats = (p.categories || []).slice(0, 3).join(',') || 'any';
      return `L.circle([${p.lat}, ${p.lng}], { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.08, radius: ${(p.serviceRadiusKm || 25) * 1000} }).addTo(map);
L.marker([${p.lat}, ${p.lng}], { icon: providerIcon }).bindPopup('<b>Provider</b><br>cats: ${cats}<br>radius: ${p.serviceRadiusKm || 25}km').addTo(map);`;
    }).join('\n');

    const requestMarkers = data.requests.filter((r) => r.location).map((r) => {
      const status = r.status;
      const color = status === 'open' ? '#3b82f6' : status === 'bidding' ? '#f59e0b' : '#22c55e';
      return `L.marker([${r.location!.lat}, ${r.location!.lng}], { icon: L.divIcon({ html: '<div style=\"background:${color};width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)\">${CAT_EMOJI[r.category] || '📋'}</div>', className: '', iconSize: [28, 28] }) }).bindPopup('<b>${r.category}</b><br>${r.city}<br>status: ${r.status}<br>bids: ${r.bidsCount}').addTo(map);`;
    }).join('\n');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#m{margin:0;height:100%;width:100%;background:#0a0a0a}.leaflet-popup-content{font-family:sans-serif;font-size:12px}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var map = L.map('m').setView([${centerLat}, ${centerLng}], 11);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { attribution: '© OSM, © CARTO', maxZoom: 19 }).addTo(map);
var providerIcon = L.divIcon({ html: '<div style="background:#10b981;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;box-shadow:0 2px 6px rgba(0,0,0,0.4)">🔧</div>', className: '', iconSize: [22, 22] });
${providerMarkers}
${requestMarkers}
</script></body></html>`;
  }, [data]);

  // Inject iframe srcdoc
  useEffect(() => {
    if (iframeRef.current && mapHtml) {
      iframeRef.current.srcdoc = mapHtml;
    }
  }, [mapHtml]);

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6" data-testid="sme-map-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center">
            <MapIcon className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Service Marketplace · Map</h1>
            <p className="text-sm text-slate-400">Live heatmap · provider coverage · demand zones</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            data-testid="sme-map-city-filter"
            value={cityFilter}
            onChange={(e) => setCityFilter(e.target.value)}
            placeholder="city filter (e.g. berlin)"
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
          <button
            data-testid="sme-map-refresh"
            onClick={load}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            <span className="text-sm">Refresh</span>
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/40 rounded-lg p-3 mb-4 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-rose-400 mt-0.5 shrink-0" />
          <span className="text-sm text-rose-300">{error}</span>
        </div>
      )}

      {/* Quick stats */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="sme-map-stats">
          <StatCard label="Active requests" value={data.requests.length} icon={<Zap className="w-4 h-4" />} accent="text-amber-400" />
          <StatCard label="Online providers" value={data.providers.length} icon={<Users className="w-4 h-4" />} accent="text-emerald-400" />
          <StatCard label="Top cities" value={data.topCities.length} icon={<TrendingUp className="w-4 h-4" />} accent="text-sky-400" />
          <StatCard label="Coverage gaps" value={data.gaps.filter((g) => g.gap > 0).length} icon={<AlertTriangle className="w-4 h-4" />} accent="text-rose-400" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Map */}
        <div className="bg-slate-800/50 border border-slate-700 rounded-xl overflow-hidden" style={{ height: 600 }}>
          {loading && !data ? (
            <div className="h-full flex items-center justify-center text-slate-400 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Загрузка карты…
            </div>
          ) : data ? (
            <iframe
              ref={iframeRef}
              data-testid="sme-map-iframe"
              title="Service marketplace map"
              style={{ width: '100%', height: '100%', border: 0 }}
            />
          ) : null}
        </div>

        {/* Sidebar: top cities / gaps */}
        <div className="space-y-4">
          {data && (
            <>
              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-sm font-semibold mb-3">
                  <TrendingUp className="w-4 h-4 text-sky-400" />
                  Топ городов по спросу
                </div>
                {data.topCities.length === 0 ? (
                  <div className="text-xs text-slate-500 italic">Нет активных заявок</div>
                ) : (
                  <ul className="space-y-1.5">
                    {data.topCities.slice(0, 10).map((c) => (
                      <li key={c.city} className="flex items-center justify-between text-sm" data-testid={`sme-map-topcity-${c.city}`}>
                        <span className="text-slate-300">{c.city}</span>
                        <span className="text-sky-300 font-bold">{c.openRequests}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="flex items-center gap-2 text-sm font-semibold mb-3">
                  <AlertTriangle className="w-4 h-4 text-rose-400" />
                  Coverage gaps
                </div>
                {data.gaps.filter((g) => g.gap > 0).length === 0 ? (
                  <div className="text-xs text-slate-500 italic">Все города покрыты исполнителями</div>
                ) : (
                  <ul className="space-y-2">
                    {data.gaps.filter((g) => g.gap > 0).slice(0, 8).map((g) => (
                      <li key={g.city} className="bg-slate-900/50 border border-rose-500/20 rounded-md px-3 py-2" data-testid={`sme-map-gap-${g.city}`}>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-slate-200 font-semibold">{g.city}</span>
                          <span className="text-xs text-rose-300 font-bold">+{g.gap} req</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          requests: {g.openRequests} · providers: {g.providers}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
                <div className="text-sm font-semibold mb-2">Легенда</div>
                <div className="text-xs space-y-1.5">
                  <Legend color="#10b981" label="Provider (circle = service radius)" />
                  <Legend color="#3b82f6" label="Open request" />
                  <Legend color="#f59e0b" label="Bidding request" />
                  <Legend color="#22c55e" label="Assigned" />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, accent }: { label: string; value: number; icon: React.ReactNode; accent: string }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
        {icon} {label}
      </div>
      <div className={`text-2xl font-bold ${accent}`}>{value}</div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-3 h-3 rounded-full" style={{ background: color }} />
      <span className="text-slate-300">{label}</span>
    </div>
  );
}
