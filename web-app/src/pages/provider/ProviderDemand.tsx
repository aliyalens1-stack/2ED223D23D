import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, MapPin, Activity, Zap, AlertCircle, ArrowRight, Wifi, WifiOff } from 'lucide-react';
import { providerIntelligenceAPI, zonesAPI, providerInboxAPI } from '../../services/api';
import LiveMap, { KYIV_CENTER, MapZone } from '../../components/LiveMap';
import { useRealtimeEvents } from '../../hooks/useRealtimeSocket';

export default function ProviderDemand() {
  const [demand, setDemand] = useState<any>(null);
  const [zones, setZones]   = useState<any[]>([]);
  const [opps, setOpps]     = useState<any[]>([]);
  const [online, setOnline] = useState(true);
  const [selectedZone, setSelectedZone] = useState<string | null>(null);

  const fetch = async () => {
    try {
      const [d, z, o] = await Promise.all([
        providerIntelligenceAPI.getDemand().catch(() => ({ data: null })),
        zonesAPI.getLiveState().catch(() => ({ data: { zones: [] } })),
        providerIntelligenceAPI.getOpportunities().catch(() => ({ data: { opportunities: [] } })),
      ]);
      setDemand(d.data);
      setZones(z.data?.zones || z.data?.items || []);
      setOpps(o.data?.opportunities || o.data?.items || []);
    } catch {}
  };

  useEffect(() => { fetch(); const t = setInterval(fetch, 15000); return () => clearInterval(t); }, []);
  useRealtimeEvents(['zone:updated', 'zone:surge_changed'], fetch);

  const togglePresence = async () => {
    setOnline(!online);
    try { await providerInboxAPI.updatePresence(!online); } catch {}
  };

  const liveZones = (zones.length ? zones : DEMO_ZONES);
  const mapZones = useMemo<MapZone[]>(() => liveZones.map((z: any, i: number): MapZone => ({
    id: z.id || `z-${i}`,
    lat: z.lat ?? z.center?.lat ?? (KYIV_CENTER[0] + (i % 3 - 1) * 0.04),
    lng: z.lng ?? z.center?.lng ?? (KYIV_CENTER[1] + (Math.floor(i / 3) - 1) * 0.05),
    radiusKm: z.radiusKm || 1.5,
    level: (z.surgeLevel || z.level || 'balanced').toLowerCase() as MapZone['level'],
    label: z.name || z.zoneName,
    multiplier: z.surgeMultiplier,
  })), [liveZones]);

  return (
    <div className="max-w-[1600px] mx-auto px-4 lg:px-8 py-8 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="slash-label mb-2">КАБИНЕТ МАСТЕРА</div>
          <h1 className="font-display tracking-bebas text-4xl md:text-5xl">
            ГДЕ <span className="text-amber">СЕЙЧАС РАБОТА</span>
          </h1>
        </div>
        <button onClick={togglePresence} className={online ? 'btn-primary btn-lg' : 'btn-secondary btn-lg'} data-testid="online-toggle">
          {online ? <Wifi size={16} /> : <WifiOff size={16} />}
          {online ? 'ОНЛАЙН' : 'ОФЛАЙН'}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-4">
          <div className="card-elevated">
            <div className="flex items-center justify-between mb-4">
              <div className="slash-label">КАРТА СПРОСА (LIVE)</div>
              <span className="flex items-center gap-1.5 text-2xs uppercase tracking-widest text-amber font-bold">
                <span className="live-dot" /> {liveZones.length} ЗОН
              </span>
            </div>
            <LiveMap height={460} zones={mapZones} selectedId={selectedZone} />
            <div className="mt-3 flex flex-wrap gap-3 text-xs" style={{ color: '#B8B8B8' }}>
              <Legend color="#ef4444" label="Высокий" />
              <Legend color="#FFB020" label="Средний" />
              <Legend color="#22c55e" label="Сбалансированный" />
              <Legend color="#6b7280" label="Низкий" />
            </div>
          </div>

          <div className="card-elevated">
            <div className="slash-label mb-3">ВОЗМОЖНОСТИ</div>
            {(opps.length ? opps : DEMO_OPPS).slice(0, 4).map((o: any, i: number) => (
              <div key={i} className="flex items-start gap-3 py-3 hairline-b last:border-b-0" data-testid={`opp-${i}`}>
                <span className="icon-badge-soft !w-9 !h-9 shrink-0"><Zap size={14} /></span>
                <div className="flex-1">
                  <div className="font-semibold text-sm">{o.title || o.name}</div>
                  <p className="text-xs mt-0.5" style={{ color: '#B8B8B8' }}>{o.description || o.note}</p>
                </div>
                {o.gainAmount && <span className="font-display tracking-bebas text-amber text-xl">+{o.gainAmount} ₴</span>}
              </div>
            ))}
          </div>
        </div>

        <aside className="space-y-4">
          <div className="card-elevated">
            <div className="slash-label mb-3">СУММАРНО</div>
            <div className="space-y-3">
              <Tile label="Активных зон"     value={`${liveZones.length}`} icon={MapPin} />
              <Tile label="Очередь заявок"   value={`${demand?.queueCount ?? 14}`} icon={AlertCircle} />
              <Tile label="Среднее ETA"      value={`${demand?.avgEta ?? 8} мин`} icon={Activity} />
              <Tile label="Уровень спроса"   value={demand?.level ?? 'Высокий'} icon={TrendingUp} />
            </div>
          </div>

          <div className="card-elevated">
            <div className="slash-label mb-3">ТОП ЗОНЫ</div>
            <div className="space-y-2">
              {liveZones.slice(0, 5).map((z: any, i: number) => (
                <button
                  key={i}
                  onClick={() => setSelectedZone(z.id || `z-${i}`)}
                  className="provider-card !p-3 w-full flex items-center gap-3 text-left"
                  data-testid={`zone-${i}`}
                >
                  <span className="w-3 h-3 rounded-full shrink-0" style={{ background: ({ high: '#ef4444', medium: '#FFB020', balanced: '#22c55e', low: '#6b7280' } as any)[(z.surgeLevel || z.level || 'balanced').toLowerCase()] }} />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm truncate">{z.name || z.zoneName || 'Зона'}</div>
                    <div className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>×{z.surgeMultiplier ?? 1.0} · очередь {z.queueCount ?? 0}</div>
                  </div>
                  <ArrowRight size={12} className="text-amber" />
                </button>
              ))}
            </div>
            <Link to="/provider/inbox" className="btn-primary w-full mt-4">Принимать заявки</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-2"><span className="w-3 h-3 rounded-full" style={{ background: color }} />{label}</span>;
}
function Tile({ label, value, icon: Icon }: { label: string; value: string; icon: any }) {
  return (
    <div className="surface-chip !p-3 flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span className="icon-badge-soft !w-9 !h-9"><Icon size={14} /></span>
        <span className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</span>
      </div>
      <span className="font-display tracking-bebas text-xl text-amber">{value}</span>
    </div>
  );
}

const DEMO_ZONES = [
  { id: 'z1', name: 'Центр',       lat: 50.4501, lng: 30.5234, radiusKm: 1.6, surgeLevel: 'high',     surgeMultiplier: 1.5, queueCount: 8 },
  { id: 'z2', name: 'Подол',       lat: 50.4640, lng: 30.5180, radiusKm: 1.4, surgeLevel: 'medium',   surgeMultiplier: 1.2, queueCount: 5 },
  { id: 'z3', name: 'Левый берег', lat: 50.4520, lng: 30.6090, radiusKm: 1.8, surgeLevel: 'balanced', surgeMultiplier: 1.0, queueCount: 3 },
  { id: 'z4', name: 'Печерск',     lat: 50.4350, lng: 30.5450, radiusKm: 1.4, surgeLevel: 'high',     surgeMultiplier: 1.4, queueCount: 6 },
  { id: 'z5', name: 'Оболонь',     lat: 50.5060, lng: 30.4980, radiusKm: 1.5, surgeLevel: 'low',      surgeMultiplier: 1.0, queueCount: 2 },
  { id: 'z6', name: 'Троещина',    lat: 50.5180, lng: 30.5990, radiusKm: 1.6, surgeLevel: 'balanced', surgeMultiplier: 1.0, queueCount: 1 },
];
const DEMO_OPPS = [
  { title: 'Активируйте «Срочно»', description: 'До +5 заявок в день в час пик', gainAmount: 1500 },
  { title: 'Добавьте услугу: Электрика', description: 'Спрос в зоне +30%', gainAmount: 2400 },
  { title: 'Подключите выезд', description: '40% клиентов ищут мастера на выезд', gainAmount: 3200 },
];
