import { useEffect, useState, useCallback } from 'react';
import { adminAPI } from '../services/api';
import { useProviderLocations, useRealtimeConnection, useRealtimeEvent } from '../hooks/useRealtime';
import { 
  MapPin, CheckCircle, AlertCircle, RefreshCw, 
  Wifi, WifiOff, Users, FileText, Layers, Target,
  Navigation, Clock, TrendingUp, X, Star, Zap,
  Phone, Check, ArrowRight
} from 'lucide-react';

interface MapProvider {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  rating: number;
  pinType: string;
  locationSource: string;
  isLocationVerified: boolean;
  isMobile: boolean;
  isOnline?: boolean;
  status?: string;
}

interface MapRequest {
  id: string;
  lat: number;
  lng: number;
  status: string;
  urgency: string;
  description: string;
  city: string;
  responsesCount: number;
  customerName: string;
  createdAt: string;
  waitingMinutes: number;
}

interface MatchingProvider {
  providerId: string;
  providerName: string;
  matchingScore: number;
  visibilityScore: number;
  behavioralScore: number;
  distanceKm: number;
  etaMinutes: number;
  rating: number;
  completedBookings: number;
  responseRate: number;
  isOnline: boolean;
  isMobile: boolean;
  reasons: string[];
  distributionStatus?: string;
  responsePrice?: number;
  responseEta?: number;
}

type MapMode = 'supply' | 'demand' | 'conversion' | 'risk' | 'coverage';

const MAP_MODES: { value: MapMode; label: string; icon: any; color: string }[] = [
  { value: 'supply', label: 'Мастера', icon: Users, color: 'text-green-400' },
  { value: 'demand', label: 'Заявки', icon: FileText, color: 'text-blue-400' },
  { value: 'conversion', label: 'Конверсия', icon: TrendingUp, color: 'text-purple-400' },
  { value: 'risk', label: 'Риски', icon: AlertCircle, color: 'text-red-400' },
  { value: 'coverage', label: 'Покрытие', icon: Target, color: 'text-cyan-400' },
];

const URGENCY_COLORS: Record<string, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  normal: 'bg-blue-500',
  low: 'bg-slate-500',
};

const URGENCY_LABELS: Record<string, string> = {
  critical: 'Критично',
  high: 'Срочно',
  normal: 'Обычный',
  low: 'Не срочно',
};

export default function MapPage() {
  const [providers, setProviders] = useState<MapProvider[]>([]);
  const [requests, setRequests] = useState<MapRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [radius, setRadius] = useState(10);
  const [center, setCenter] = useState({ lat: 55.7558, lng: 37.6173 }); // Moscow
  const [mapMode, setMapMode] = useState<MapMode>('demand');
  const [showHeatmap, setShowHeatmap] = useState(false);
  
  // Assignment state
  const [selectedRequest, setSelectedRequest] = useState<MapRequest | null>(null);
  const [matchingProviders, setMatchingProviders] = useState<MatchingProvider[]>([]);
  const [loadingMatching, setLoadingMatching] = useState(false);
  const [assigning, setAssigning] = useState(false);
  
  // Real-time
  const { connected } = useRealtimeConnection();
  const realtimeLocations = useProviderLocations();
  
  // Subscribe to new requests
  useRealtimeEvent('request.created', (data) => {
    if (data.data?.location) {
      const newRequest: MapRequest = {
        id: data.data.id,
        lat: data.data.location.lat || data.data.location.coordinates?.[1],
        lng: data.data.location.lng || data.data.location.coordinates?.[0],
        status: 'pending',
        urgency: data.data.urgency || 'normal',
        description: data.data.description || 'Новая заявка',
        city: data.data.city || '',
        responsesCount: 0,
        customerName: data.data.customerName || 'Клиент',
        createdAt: data.timestamp,
        waitingMinutes: 0,
      };
      setRequests(prev => [newRequest, ...prev].slice(0, 50));
    }
  });

  // Fetch providers
  const fetchProviders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getNearbyProviders(center.lat, center.lng, radius);
      const providersData = (res.data || []).map((p: any) => ({
        ...p,
        isOnline: realtimeLocations.get(p.id)?.isOnline ?? true,
      }));
      setProviders(providersData);
    } catch (err) {
      console.error(err);
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, [center.lat, center.lng, radius]);

  // Fetch live requests
  const fetchRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const res = await adminAPI.getLiveRequests({ lat: center.lat, lng: center.lng, radius: radius * 10, limit: 50 });
      setRequests(res.data || []);
    } catch (err) {
      console.error(err);
      // Keep existing requests on error
    } finally {
      setLoadingRequests(false);
    }
  }, [center.lat, center.lng, radius]);

  useEffect(() => {
    fetchProviders();
    fetchRequests();
  }, [fetchProviders, fetchRequests]);

  // Update providers with realtime locations
  useEffect(() => {
    if (realtimeLocations.size > 0) {
      setProviders(prev => prev.map(p => {
        const rtLoc = realtimeLocations.get(p.id);
        if (rtLoc) {
          return { ...p, lat: rtLoc.lat, lng: rtLoc.lng, isOnline: rtLoc.isOnline };
        }
        return p;
      }));
    }
  }, [realtimeLocations]);

  // Load matching providers when request is selected
  const handleSelectRequest = async (request: MapRequest) => {
    setSelectedRequest(request);
    setLoadingMatching(true);
    try {
      const res = await adminAPI.getMatchingProviders(request.id);
      setMatchingProviders(res.data?.providers || []);
    } catch (err) {
      console.error(err);
      // Fallback to matching candidates
      try {
        const res = await adminAPI.getMatchingCandidates(request.id, 10);
        setMatchingProviders(res.data || []);
      } catch {
        setMatchingProviders([]);
      }
    } finally {
      setLoadingMatching(false);
    }
  };

  // Assign provider to request
  const handleAssignProvider = async (provider: MatchingProvider) => {
    if (!selectedRequest) return;
    setAssigning(true);
    try {
      await adminAPI.assignProvider(selectedRequest.id, {
        providerId: provider.providerId,
        notes: `Назначено оператором. ETA: ${provider.etaMinutes} мин`,
      });
      // Refresh requests
      fetchRequests();
      setSelectedRequest(null);
      setMatchingProviders([]);
    } catch (err) {
      console.error('Assignment failed:', err);
      alert('Ошибка назначения. Попробуйте ещё раз.');
    } finally {
      setAssigning(false);
    }
  };

  // Auto-distribute request
  const handleAutoDistribute = async (request: MapRequest) => {
    try {
      await adminAPI.autoDistributeRequest(request.id, 5);
      fetchRequests();
    } catch (err) {
      console.error('Auto-distribute failed:', err);
    }
  };

  // OpenStreetMap embed URL
  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${center.lng - radius * 0.01},${center.lat - radius * 0.008},${center.lng + radius * 0.01},${center.lat + radius * 0.008}&layer=mapnik&marker=${center.lat},${center.lng}`;

  // Stats
  const onlineCount = providers.filter(p => p.isOnline !== false).length;
  const verifiedCount = providers.filter(p => p.isLocationVerified).length;
  const mobileCount = providers.filter(p => p.isMobile).length;
  const urgentRequests = requests.filter(r => r.urgency === 'critical' || r.urgency === 'high').length;

  // Group providers by type
  const byType = {
    online: providers.filter(p => p.isOnline !== false),
    offline: providers.filter(p => p.isOnline === false),
    verified: providers.filter(p => p.pinType === 'verified'),
    unverified: providers.filter(p => p.pinType === 'unverified'),
  };

  return (
    <div className="p-6 h-full flex flex-col" data-testid="map-page">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-500/20 rounded-lg">
            <MapPin size={24} className="text-cyan-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Geo Operations Center</h1>
            <p className="text-slate-400 text-sm">Request → Map → Match → Assign → Booking</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {/* Real-time status */}
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg ${connected ? 'bg-green-500/20' : 'bg-red-500/20'}`}>
            {connected ? (
              <>
                <Wifi size={16} className="text-green-400" />
                <span className="text-green-400 text-sm">Live</span>
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
              </>
            ) : (
              <>
                <WifiOff size={16} className="text-red-400" />
                <span className="text-red-400 text-sm">Offline</span>
              </>
            )}
          </div>
          <select
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white"
          >
            <option value={5}>5 км</option>
            <option value={10}>10 км</option>
            <option value={20}>20 км</option>
            <option value={50}>50 км</option>
          </select>
          <button
            onClick={() => { fetchProviders(); fetchRequests(); }}
            className="flex items-center gap-2 bg-primary hover:bg-primary/90 text-white px-4 py-2 rounded-lg"
            data-testid="refresh-map-btn"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            Обновить
          </button>
        </div>
      </div>

      {/* Map Mode Selector */}
      <div className="flex items-center gap-2 mb-4">
        {MAP_MODES.map(mode => {
          const Icon = mode.icon;
          return (
            <button
              key={mode.value}
              onClick={() => setMapMode(mode.value)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                mapMode === mode.value 
                  ? 'bg-slate-700 border border-slate-500' 
                  : 'bg-slate-800 border border-slate-700 hover:border-slate-600'
              }`}
              data-testid={`map-mode-${mode.value}`}
            >
              <Icon size={16} className={mapMode === mode.value ? mode.color : 'text-slate-400'} />
              <span className={mapMode === mode.value ? 'text-white' : 'text-slate-400'}>{mode.label}</span>
              {mode.value === 'demand' && requests.length > 0 && (
                <span className="px-1.5 py-0.5 bg-blue-500/30 text-blue-400 text-xs rounded">{requests.length}</span>
              )}
            </button>
          );
        })}
        <div className="flex-1" />
        <label className="flex items-center gap-2 px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={showHeatmap}
            onChange={(e) => setShowHeatmap(e.target.checked)}
            className="rounded"
          />
          <Layers size={16} className="text-slate-400" />
          <span className="text-slate-300 text-sm">Heatmap</span>
        </label>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-5 gap-4 mb-4">
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-3 flex items-center gap-3">
          <div className="p-2 bg-green-500/20 rounded-lg">
            <Users size={18} className="text-green-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{onlineCount}</p>
            <p className="text-slate-400 text-xs">Онлайн мастеров</p>
          </div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-3 flex items-center gap-3">
          <div className="p-2 bg-blue-500/20 rounded-lg">
            <FileText size={18} className="text-blue-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{requests.length}</p>
            <p className="text-slate-400 text-xs">Активных заявок</p>
          </div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-3 flex items-center gap-3">
          <div className="p-2 bg-red-500/20 rounded-lg">
            <AlertCircle size={18} className="text-red-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{urgentRequests}</p>
            <p className="text-slate-400 text-xs">Срочных</p>
          </div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-3 flex items-center gap-3">
          <div className="p-2 bg-cyan-500/20 rounded-lg">
            <Navigation size={18} className="text-cyan-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{mobileCount}</p>
            <p className="text-slate-400 text-xs">Выездных</p>
          </div>
        </div>
        <div className="bg-slate-800 rounded-lg border border-slate-700 p-3 flex items-center gap-3">
          <div className="p-2 bg-purple-500/20 rounded-lg">
            <CheckCircle size={18} className="text-purple-400" />
          </div>
          <div>
            <p className="text-2xl font-bold text-white">{verifiedCount}</p>
            <p className="text-slate-400 text-xs">Верифицировано</p>
          </div>
        </div>
      </div>

      <div className="flex gap-6 flex-1 min-h-0">
        {/* Map */}
        <div className="flex-1 bg-slate-800 rounded-xl overflow-hidden border border-slate-700 relative">
          <iframe
            src={mapUrl}
            style={{ width: '100%', height: '100%', border: 'none' }}
            title="Map"
          />
          
          {/* Map overlay legend */}
          <div className="absolute bottom-4 left-4 bg-slate-900/90 rounded-lg p-3 border border-slate-700">
            <p className="text-white text-xs font-medium mb-2">Легенда</p>
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green-500" />
                <span className="text-slate-300">Мастер онлайн</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-slate-500" />
                <span className="text-slate-300">Мастер оффлайн</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-blue-500" />
                <span className="text-slate-300">Заявка</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-red-500 animate-pulse" />
                <span className="text-slate-300">Срочная заявка</span>
              </div>
            </div>
          </div>

          {/* Live requests indicator */}
          {requests.length > 0 && (
            <div className="absolute top-4 right-4 bg-blue-500/20 border border-blue-500/50 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-blue-400" />
                <span className="text-blue-400 font-medium">{requests.length} заявок на карте</span>
              </div>
              {urgentRequests > 0 && (
                <p className="text-red-400 text-xs mt-1">{urgentRequests} срочных!</p>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-96 bg-slate-800 rounded-xl border border-slate-700 flex flex-col">
          <div className="p-4 border-b border-slate-700">
            <h2 className="text-lg font-semibold text-white">
              {mapMode === 'demand' ? 'Активные заявки' : `${providers.length} мастеров`}
            </h2>
            {connected && (
              <p className="text-green-400 text-xs mt-1 flex items-center gap-1">
                <div className="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse" />
                Обновляется в реальном времени
              </p>
            )}
          </div>

          <div className="flex-1 overflow-auto">
            {/* DEMAND MODE - Show requests */}
            {mapMode === 'demand' && (
              <div className="p-4">
                {loadingRequests ? (
                  <div className="text-center py-8">
                    <RefreshCw className="animate-spin text-slate-500 mx-auto" size={24} />
                    <p className="text-slate-500 text-sm mt-2">Загрузка заявок...</p>
                  </div>
                ) : requests.length === 0 ? (
                  <div className="text-center py-8">
                    <FileText size={32} className="text-slate-600 mx-auto mb-2" />
                    <p className="text-slate-500 text-sm">Нет активных заявок</p>
                    {connected && (
                      <p className="text-green-400 text-xs mt-2">Ожидание новых заявок...</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {requests.map(r => (
                      <RequestCard 
                        key={r.id} 
                        request={r}
                        isSelected={selectedRequest?.id === r.id}
                        onClick={() => handleSelectRequest(r)}
                        onAutoDistribute={() => handleAutoDistribute(r)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* SUPPLY MODE - Show providers */}
            {mapMode === 'supply' && (
              <>
                {byType.online.length > 0 && (
                  <div className="p-4 border-b border-slate-700">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-green-400 mb-3">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                      Онлайн ({byType.online.length})
                    </h3>
                    <div className="space-y-2">
                      {byType.online.slice(0, 10).map(p => (
                        <ProviderCard key={p.id} provider={p} />
                      ))}
                    </div>
                  </div>
                )}
                {byType.offline.length > 0 && (
                  <div className="p-4">
                    <h3 className="flex items-center gap-2 text-sm font-medium text-slate-400 mb-3">
                      <div className="w-2 h-2 bg-slate-500 rounded-full" />
                      Оффлайн ({byType.offline.length})
                    </h3>
                    <div className="space-y-2">
                      {byType.offline.slice(0, 5).map(p => (
                        <ProviderCard key={p.id} provider={p} />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Other modes placeholder */}
            {(mapMode === 'conversion' || mapMode === 'risk' || mapMode === 'coverage') && (
              <div className="p-4 text-center py-12">
                <Layers size={48} className="text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400">
                  {mapMode === 'conversion' && 'Данные конверсии по зонам'}
                  {mapMode === 'risk' && 'Карта рисков и споров'}
                  {mapMode === 'coverage' && 'Покрытие радиусами мастеров'}
                </p>
                <p className="text-slate-500 text-sm mt-1">Требует накопления данных</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Assignment Modal */}
      {selectedRequest && (
        <AssignmentModal
          request={selectedRequest}
          providers={matchingProviders}
          loading={loadingMatching}
          assigning={assigning}
          onClose={() => { setSelectedRequest(null); setMatchingProviders([]); }}
          onAssign={handleAssignProvider}
        />
      )}
    </div>
  );
}

// Request Card Component
function RequestCard({ 
  request, 
  isSelected, 
  onClick, 
  onAutoDistribute 
}: { 
  request: MapRequest; 
  isSelected: boolean;
  onClick: () => void;
  onAutoDistribute: () => void;
}) {
  const urgencyClass = URGENCY_COLORS[request.urgency] || 'bg-blue-500';
  const isUrgent = request.urgency === 'critical' || request.urgency === 'high';

  return (
    <div 
      className={`p-3 rounded-lg cursor-pointer transition-all ${
        isSelected 
          ? 'bg-blue-500/20 border-2 border-blue-500' 
          : isUrgent 
            ? 'bg-red-500/10 border border-red-500/50 hover:border-red-500' 
            : 'bg-slate-700/50 border border-slate-600 hover:border-slate-500'
      }`}
      onClick={onClick}
      data-testid={`request-card-${request.id}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${urgencyClass} ${isUrgent ? 'animate-pulse' : ''}`} />
          <span className="text-white text-sm font-medium truncate max-w-[180px]">{request.description}</span>
        </div>
        <span className={`px-2 py-0.5 rounded text-xs ${
          isUrgent ? 'bg-red-500/30 text-red-400' : 'bg-slate-600 text-slate-300'
        }`}>
          {URGENCY_LABELS[request.urgency] || request.urgency}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400 mb-2">
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {request.waitingMinutes} мин
        </span>
        <span>{request.customerName}</span>
        {request.responsesCount > 0 && (
          <span className="text-green-400">{request.responsesCount} ответов</span>
        )}
      </div>
      <div className="flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onClick(); }}
          className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 bg-primary/20 text-primary hover:bg-primary/30 rounded text-xs"
        >
          <Target size={12} />
          Назначить
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onAutoDistribute(); }}
          className="flex items-center gap-1 px-3 py-1.5 bg-slate-600 hover:bg-slate-500 rounded text-xs text-white"
        >
          <Zap size={12} />
          Авто
        </button>
      </div>
    </div>
  );
}

// Provider Card Component
function ProviderCard({ provider }: { provider: MapProvider }) {
  return (
    <div className="bg-slate-700/50 rounded-lg p-3 hover:bg-slate-700 transition-colors">
      <div className="flex items-center gap-2 mb-1">
        <div className={`w-3 h-3 rounded-full ${provider.isOnline !== false ? 'bg-green-500' : 'bg-slate-500'}`} />
        <span className="text-white font-medium text-sm">{provider.name}</span>
        {provider.isLocationVerified && <CheckCircle size={12} className="text-green-400" />}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span>★ {provider.rating > 0 ? provider.rating.toFixed(1) : '—'}</span>
        <span>{provider.distanceKm < 1 ? `${Math.round(provider.distanceKm * 1000)}м` : `${provider.distanceKm.toFixed(1)}км`}</span>
        {provider.isMobile && <span className="text-cyan-400">Выезд</span>}
      </div>
    </div>
  );
}

// Assignment Modal Component
function AssignmentModal({ 
  request, 
  providers, 
  loading, 
  assigning,
  onClose, 
  onAssign 
}: { 
  request: MapRequest;
  providers: MatchingProvider[];
  loading: boolean;
  assigning: boolean;
  onClose: () => void;
  onAssign: (provider: MatchingProvider) => void;
}) {
  const isUrgent = request.urgency === 'critical' || request.urgency === 'high';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div 
        className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className={`w-3 h-3 rounded-full ${URGENCY_COLORS[request.urgency]} ${isUrgent ? 'animate-pulse' : ''}`} />
              <h2 className="text-lg font-semibold text-white">Назначить мастера</h2>
            </div>
            <p className="text-slate-400 text-sm mt-1">{request.description}</p>
            <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
              <span className="flex items-center gap-1">
                <Clock size={12} />
                Ждёт {request.waitingMinutes} мин
              </span>
              <span className="flex items-center gap-1">
                <Phone size={12} />
                {request.customerName}
              </span>
              <span className={`px-2 py-0.5 rounded ${isUrgent ? 'bg-red-500/30 text-red-400' : 'bg-slate-600 text-slate-300'}`}>
                {URGENCY_LABELS[request.urgency]}
              </span>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1">
            <X size={20} />
          </button>
        </div>

        {/* Providers List */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center py-8">
              <RefreshCw className="animate-spin text-slate-500 mx-auto" size={24} />
              <p className="text-slate-500 text-sm mt-2">Поиск мастеров...</p>
            </div>
          ) : providers.length === 0 ? (
            <div className="text-center py-8">
              <Users size={32} className="text-slate-600 mx-auto mb-2" />
              <p className="text-slate-500">Нет доступных мастеров поблизости</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-slate-400 text-sm">{providers.length} подходящих мастеров:</p>
              {providers.map((p, idx) => (
                <div 
                  key={p.providerId}
                  className={`p-4 rounded-lg border ${
                    idx === 0 
                      ? 'bg-green-500/10 border-green-500/50' 
                      : 'bg-slate-700/50 border-slate-600'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-white font-medium">{p.providerName}</span>
                        {idx === 0 && (
                          <span className="px-2 py-0.5 bg-green-500/30 text-green-400 text-xs rounded">Лучший</span>
                        )}
                        {p.isOnline && (
                          <span className="px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded">Онлайн</span>
                        )}
                        {p.isMobile && (
                          <span className="px-2 py-0.5 bg-cyan-500/20 text-cyan-400 text-xs rounded">Выезд</span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-sm text-slate-400">
                        <span className="flex items-center gap-1">
                          <Star size={14} className="text-yellow-400" />
                          {p.rating.toFixed(1)}
                        </span>
                        <span>{p.distanceKm.toFixed(1)} км</span>
                        <span>~{p.etaMinutes} мин</span>
                        <span className="text-green-400 font-medium">Score: {p.matchingScore}</span>
                      </div>
                      {p.reasons.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {p.reasons.map((r, i) => (
                            <span key={i} className="px-2 py-0.5 bg-slate-600 text-slate-300 text-xs rounded">
                              {r}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => onAssign(p)}
                      disabled={assigning}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${
                        idx === 0 
                          ? 'bg-green-500 hover:bg-green-600 text-white' 
                          : 'bg-primary hover:bg-primary/90 text-white'
                      } disabled:opacity-50`}
                    >
                      {assigning ? (
                        <RefreshCw size={16} className="animate-spin" />
                      ) : (
                        <>
                          <Check size={16} />
                          Назначить
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-slate-700 bg-slate-900/50">
          <div className="flex items-center justify-between">
            <p className="text-slate-500 text-xs">
              Назначение создаст бронирование и отправит уведомление мастеру
            </p>
            <div className="flex items-center gap-2 text-slate-400 text-sm">
              <ArrowRight size={14} />
              Request → Booking
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
