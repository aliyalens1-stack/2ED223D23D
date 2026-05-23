import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Mail, User, Shield, MapPin, Wrench, Star, Wifi, WifiOff, ArrowRight, LogOut, Award } from 'lucide-react';
import { providerIntelligenceAPI, providerInboxAPI } from '../../services/api';

export default function ProviderProfile() {
  const { user, logout } = useAuthStore();
  const [intel, setIntel] = useState<any>(null);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    providerIntelligenceAPI.getIntelligence()
      .then(r => { setIntel(r.data); setOnline(!!r.data?.profile?.isOnline); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const togglePresence = async () => {
    setOnline(!online);
    try { await providerInboxAPI.updatePresence(!online); } catch {}
  };

  const profile = intel?.profile || {};
  const skills: string[] = profile.strongestSkills || [];
  const weaknesses: string[] = profile.weakestSkills || [];

  return (
    <div className="max-w-[1200px] mx-auto px-4 lg:px-8 py-8 space-y-6" data-testid="provider-profile">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="slash-label mb-2">КАБИНЕТ МАСТЕРА</div>
          <h1 className="font-display tracking-bebas text-4xl md:text-5xl">
            ПРОФИЛЬ <span className="text-amber">МАСТЕРА</span>
          </h1>
        </div>
        <button
          onClick={togglePresence}
          className={online ? 'btn-primary btn-lg' : 'btn-secondary btn-lg'}
          data-testid="provider-online-toggle"
        >
          {online ? <Wifi size={16} /> : <WifiOff size={16} />}
          {online ? 'ОНЛАЙН' : 'ОФЛАЙН'}
        </button>
      </div>

      {loading && <p className="text-sm" style={{ color: '#8A8A8A' }}>Загрузка…</p>}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        <div className="space-y-4">
          {/* Identity */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ДАННЫЕ</div>
            <div className="flex items-center gap-4">
              <span className="w-16 h-16 bg-amber flex items-center justify-center text-black font-display text-3xl tracking-bebas" style={{ borderRadius: 12 }}>
                {(user?.firstName || user?.email || '?').charAt(0).toUpperCase()}
              </span>
              <div className="flex-1 min-w-0">
                <p className="font-display tracking-bebas text-2xl leading-none">{profile.providerName || `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim()}</p>
                <p className="text-xs mt-1" style={{ color: '#8A8A8A' }}>{user?.email}</p>
                <div className="flex items-center gap-3 mt-2 text-xs" style={{ color: '#B8B8B8' }}>
                  <span className="flex items-center gap-1"><Star size={12} className="text-amber" fill="currentColor" />{profile.rating ?? '—'}</span>
                  <span>·</span>
                  <span>{profile.reviewsCount ?? 0} отзывов</span>
                  <span>·</span>
                  <span className="text-amber">{profile.currentTier ?? 'silver'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Skills */}
          <div className="card-elevated">
            <div className="slash-label mb-3">СПЕЦИАЛИЗАЦИЯ</div>
            <div className="flex flex-wrap gap-2 mb-3">
              {skills.length === 0 ? (
                <span className="text-xs" style={{ color: '#8A8A8A' }}>Не указана</span>
              ) : (
                skills.map((s: string, i: number) => (
                  <span key={i} className="chip chip-active" data-testid={`skill-${i}`}>
                    <Wrench size={10} className="mr-1" /> {s}
                  </span>
                ))
              )}
            </div>
            {weaknesses.length > 0 && (
              <>
                <div className="text-2xs uppercase tracking-widest mb-2" style={{ color: '#8A8A8A' }}>СЛАБЫЕ МЕСТА</div>
                <div className="flex flex-wrap gap-2">
                  {weaknesses.map((s: string, i: number) => (
                    <span key={i} className="chip" data-testid={`weakness-${i}`}>{s}</span>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Zones */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ЗОНЫ РАБОТЫ</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {['Центр', 'Подол', 'Печерск', 'Оболонь', 'Левый берег', 'Святошин'].map((z, i) => (
                <div key={i} className="surface-chip !p-3 flex items-center gap-2" data-testid={`zone-pill-${i}`}>
                  <MapPin size={12} className="text-amber" />
                  <span className="text-xs">{z}</span>
                </div>
              ))}
            </div>
            <Link to="/provider/demand" className="btn-secondary w-full mt-4">
              <MapPin size={14} /> Карта спроса <ArrowRight size={12} />
            </Link>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <div className="card-elevated">
            <div className="slash-label mb-3">СКОРИНГ</div>
            <ScoreRow label="Производительность" value={profile.performanceScore ?? 0} />
            <ScoreRow label="Доверие"            value={profile.trustScore ?? 0} />
            <ScoreRow label="Скорость"           value={profile.speedScore ?? 0} />
            <ScoreRow label="Качество"           value={profile.qualityScore ?? 0} />
            <ScoreRow label="Монетизация"        value={profile.monetizationScore ?? 0} />
          </div>
          <div className="card-elevated">
            <div className="slash-label mb-3">СТАТУС</div>
            <Stat icon={Shield} label="Верификация" value="Пройдена" />
            <Stat icon={Award}  label="Tier"        value={String(profile.currentTier ?? 'silver').toUpperCase()} />
            <Stat icon={User}   label="Роль"        value={String(user?.role || 'provider')} />
            <Stat icon={Mail}   label="Email"       value={String(user?.email ?? '—').slice(0, 22)} />
          </div>
          <div className="card-elevated">
            <Link to="/provider/billing" className="btn-primary w-full mb-2">Биллинг и Priority</Link>
            <button onClick={logout} className="btn-secondary w-full" data-testid="provider-logout">
              <LogOut size={14} /> Выйти
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <div className="py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>{label}</span>
        <span className="font-display tracking-bebas text-amber text-lg">{v}</span>
      </div>
      <div className="w-full h-1.5 bg-ink-200" style={{ background: '#222', borderRadius: 999 }}>
        <div className="h-full" style={{ width: `${v}%`, background: '#FFB020', borderRadius: 999 }} />
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: any) {
  return (
    <div className="flex items-center justify-between py-2 hairline-b last:border-b-0">
      <span className="flex items-center gap-2 text-2xs uppercase tracking-widest" style={{ color: '#8A8A8A' }}>
        <Icon size={12} className="text-amber" />{label}
      </span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
