import { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Circle, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import axios from 'axios';
import { Brain, RefreshCw, Activity, AlertTriangle } from 'lucide-react';

const api = axios.create({ baseURL: '/api' });

const KYIV_CENTER: [number, number] = [50.4501, 30.5234];

interface ZoneData {
  id: string;
  name: string;
  status: string;
  center: { lat: number; lng: number };
  radiusKm?: number;
  demandScore: number;
  supplyScore: number;
  surgeMultiplier: number;
  ratio: number;
  onlineProviders: number;
  forecast?: { p10?: number; p50?: number; p90?: number; mae?: number; source?: string } | null;
}

function pressureLevel(p90: number | null | undefined, supply: number): {
  level: 'low' | 'balanced' | 'medium' | 'high';
  ratio: number;
  color: string;
} {
  if (!p90 || supply <= 0) return { level: 'balanced', ratio: 0, color: '#10b981' };
  const r = p90 / supply;
  if (r >= 3) return { level: 'high', ratio: r, color: '#ef4444' };
  if (r >= 1.5) return { level: 'medium', ratio: r, color: '#f97316' };
  if (r >= 0.8) return { level: 'balanced', ratio: r, color: '#10b981' };
  return { level: 'low', ratio: r, color: '#3b82f6' };
}

export default function LiveForecastMapPage() {
  const [data, setData] = useState<{ zones: ZoneData[]; updatedAt?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const fetchZones = async () => {
    setErr(null);
    try {
      const res = await api.get('/zones/live-state');
      setData({ zones: res.data?.zones || [], updatedAt: res.data?.updatedAt });
    } catch (e: any) {
      setErr(e?.response?.data?.message || e?.message || 'Не удалось загрузить данные');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchZones();
    const t = setInterval(fetchZones, 15000);
    return () => clearInterval(t);
  }, []);

  const enrichedZones = useMemo(() => {
    return (data?.zones || []).map((z) => {
      const p = pressureLevel(z.forecast?.p90, z.supplyScore);
      return { ...z, _pressure: p };
    });
  }, [data]);

  const summary = useMemo(() => {
    const high = enrichedZones.filter((z) => z._pressure.level === 'high').length;
    const medium = enrichedZones.filter((z) => z._pressure.level === 'medium').length;
    const balanced = enrichedZones.filter((z) => z._pressure.level === 'balanced').length;
    return { high, medium, balanced, total: enrichedZones.length };
  }, [enrichedZones]);

  return (
    <div className="min-h-screen bg-slate-900 text-white" data-testid="live-forecast-map-page">
      <div className="max-w-6xl mx-auto p-4 md:p-6">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/20 rounded-lg">
              <Brain size={22} className="text-purple-400" />
            </div>
            <div>
              <h1 className="text-xl md:text-2xl font-bold">Карта прогноза спроса</h1>
              <p className="text-xs text-slate-400">
                ML-модель обновляется каждые 5 мин · {data?.updatedAt ? `Обновлено: ${new Date(data.updatedAt).toLocaleTimeString('ru-RU')}` : ''}
              </p>
            </div>
          </div>
          <button
            onClick={fetchZones}
            className="flex items-center gap-2 px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm border border-slate-700"
            data-testid="map-refresh-btn"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            Обновить
          </button>
        </div>

        {err && (
          <div className="mb-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm flex items-center gap-2">
            <AlertTriangle size={16} /> {err}
          </div>
        )}

        {/* Summary chips */}
        <div className="flex flex-wrap gap-2 mb-4">
          <Chip color="bg-red-500/20 text-red-300 border-red-500/30" icon={<Activity size={14} />} label={`${summary.high} зон высокого давления`} />
          <Chip color="bg-orange-500/20 text-orange-300 border-orange-500/30" icon={<Activity size={14} />} label={`${summary.medium} зон средняя загрузка`} />
          <Chip color="bg-green-500/20 text-green-300 border-green-500/30" icon={<Activity size={14} />} label={`${summary.balanced} зон сбалансировано`} />
          <Chip color="bg-slate-700 text-slate-300 border-slate-600" label={`Всего: ${summary.total}`} />
        </div>

        {/* Map */}
        <div className="rounded-xl overflow-hidden border border-slate-700 mb-4" style={{ height: 520 }}>
          <MapContainer center={KYIV_CENTER} zoom={11} scrollWheelZoom style={{ height: '100%', width: '100%', background: '#0f172a' }}>
            <TileLayer
              attribution='&copy; OSM &copy; CARTO'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              subdomains="abcd"
              maxZoom={19}
            />
            {enrichedZones.map((z) => {
              const center: [number, number] = [z.center?.lat ?? KYIV_CENTER[0], z.center?.lng ?? KYIV_CENTER[1]];
              const radius = (z.radiusKm ?? 2.5) * 1000;
              const fc = z.forecast;
              return (
                <Circle
                  key={z.id}
                  center={center}
                  radius={radius}
                  pathOptions={{
                    color: z._pressure.color,
                    fillColor: z._pressure.color,
                    fillOpacity: 0.25,
                    weight: 2,
                    dashArray: z._pressure.level === 'high' ? '0' : '4 6',
                  }}
                >
                  <Tooltip direction="top" offset={[0, -6]} opacity={0.95} sticky>
                    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{z.name}</div>
                      <div>Status: <strong>{z.status}</strong></div>
                      <div>Demand сейчас: <strong>{z.demandScore?.toFixed(1)}</strong></div>
                      {fc?.p50 != null && (
                        <div>
                          Прогноз P50: <strong style={{ color: '#a855f7' }}>{fc.p50.toFixed(2)}</strong>
                          {fc.p10 != null && fc.p90 != null && (
                            <span style={{ color: '#94a3b8', marginLeft: 4 }}>[{fc.p10.toFixed(1)}–{fc.p90.toFixed(1)}]</span>
                          )}
                        </div>
                      )}
                      <div>Supply: <strong style={{ color: '#10b981' }}>{z.supplyScore}</strong> ({z.onlineProviders} online)</div>
                      <div>Surge: <strong style={{ color: '#f97316' }}>{z.surgeMultiplier?.toFixed(1)}×</strong></div>
                      {fc?.p90 != null && z.supplyScore > 0 && (
                        <div>Pressure (P90/supply): <strong style={{ color: z._pressure.color }}>{z._pressure.ratio.toFixed(2)}×</strong></div>
                      )}
                      {fc?.mae != null && (
                        <div style={{ color: '#94a3b8', fontSize: 10, marginTop: 2 }}>MAE {fc.mae.toFixed(2)} · {fc.source || '—'}</div>
                      )}
                    </div>
                  </Tooltip>
                </Circle>
              );
            })}
          </MapContainer>
        </div>

        {/* Legend */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <div className="text-sm font-semibold mb-2">Легенда</div>
          <div className="flex flex-wrap gap-3 text-xs text-slate-300">
            <LegendItem color="#ef4444" label="High pressure (P90/supply ≥ 3×)" />
            <LegendItem color="#f97316" label="Medium (1.5–3×)" />
            <LegendItem color="#10b981" label="Balanced (0.8–1.5×)" />
            <LegendItem color="#3b82f6" label="Low (< 0.8×)" />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Цвет зоны определяется отношением прогнозируемого спроса (P90) к текущему количеству мастеров.
            Высокое давление = нужно больше мастеров или поднять цены (surge).
          </p>
        </div>
      </div>
    </div>
  );
}

function Chip({ color, icon, label }: { color: string; icon?: React.ReactNode; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium ${color}`}>
      {icon}
      {label}
    </span>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span style={{ width: 14, height: 14, borderRadius: 4, background: color, opacity: 0.7, border: `1px solid ${color}` }} />
      {label}
    </span>
  );
}
