import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightning, MapPin, Clock, CurrencyCircleDollar, CheckCircle, XCircle, Fire, Warning, Timer, Spinner, Bell, ArrowsClockwise } from '@phosphor-icons/react';
import { providerAPI } from '../../services/api';
import { useAuthStore } from '../../stores/authStore';
import { realtime } from '../../lib/socket';

export default function ProviderInbox() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const providerSlug = (user as any)?.providerSlug || (user as any)?.organizationSlug || 'avtomaster-pro';
  const [requests, setRequests] = useState<any[]>([]);
  const [liveOffers, setLiveOffers] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const timersRef = useRef<Record<string, number>>({});
  const liveTimersRef = useRef<Record<string, number>>({});

  const fetchInbox = async () => {
    try {
      const [{ data }, live] = await Promise.all([
        providerAPI.getInbox(),
        providerAPI.getQuickRequestInbox(providerSlug).catch(() => ({ data: { items: [] } })),
      ]);
      setRequests(data.requests || []);
      setStats(data.stats);
      const newTimers: Record<string, number> = {};
      for (const r of data.requests || []) newTimers[r.id] = r.timeLeft ?? 60;
      timersRef.current = newTimers;

      const items = (live as any).data?.items || [];
      setLiveOffers(items);
      const newLiveTimers: Record<string, number> = {};
      for (const it of items) newLiveTimers[it.requestId] = it.secondsLeft ?? 60;
      liveTimersRef.current = newLiveTimers;
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchInbox(); }, []);
  // Poll every 10s
  useEffect(() => {
    const iv = setInterval(fetchInbox, 10000);
    return () => clearInterval(iv);
  }, []);

  // Realtime — react instantly to new offers / takes
  useEffect(() => {
    realtime.connect();
    const off1 = realtime.on('provider:new_request', () => { fetchInbox(); });
    const off2 = realtime.on('provider:request_taken', (p: any) => {
      setLiveOffers((prev) => prev.filter((o) => o.requestId !== p?.requestId));
    });
    const off3 = realtime.on('request:expired', (p: any) => {
      setLiveOffers((prev) => prev.filter((o) => o.requestId !== p?.requestId));
    });
    return () => { off1?.(); off2?.(); off3?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Countdown timer (legacy + live)
  useEffect(() => {
    const iv = setInterval(() => {
      setRequests(prev => prev.map(r => {
        const tl = timersRef.current[r.id];
        if (tl !== undefined && tl > 0) {
          timersRef.current[r.id] = tl - 1;
          return { ...r, timeLeft: tl - 1, urgency: tl - 1 < 30 ? 'urgent' : 'normal' };
        }
        return r;
      }));
      setLiveOffers(prev => prev.map(o => {
        const tl = liveTimersRef.current[o.requestId];
        if (tl !== undefined && tl > 0) {
          liveTimersRef.current[o.requestId] = tl - 1;
          return { ...o, secondsLeft: tl - 1 };
        }
        return o;
      }).filter(o => (o.secondsLeft ?? 0) > 0));
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const handleAcceptLive = async (requestId: string) => {
    try {
      const r = await providerAPI.acceptQuickRequest(requestId, providerSlug);
      setLiveOffers((prev) => prev.filter((o) => o.requestId !== requestId));
      const bookingId = (r as any).data?.bookingId;
      if (bookingId) navigate(`/provider/current-job`);
    } catch (err: any) {
      console.error(err);
      // Most likely 409 — request was just taken. Refresh.
      fetchInbox();
    }
  };

  const handleRejectLive = async (requestId: string) => {
    try {
      await providerAPI.rejectQuickRequest(requestId, providerSlug);
      setLiveOffers((prev) => prev.filter((o) => o.requestId !== requestId));
    } catch (err) { console.error(err); }
  };

  const handleAccept = async (id: string) => {
    try {
      await providerAPI.acceptRequest(id);
      setRequests(prev => prev.filter(r => r.id !== id));
      navigate('/provider/current-job');
    } catch (err) { console.error(err); }
  };

  const handleReject = async (id: string) => {
    try {
      await providerAPI.rejectRequest(id, '');
      setRequests(prev => prev.filter(r => r.id !== id));
    } catch (err) { console.error(err); }
  };

  const formatTimer = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div data-testid="provider-inbox">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Bell size={22} weight="fill" className="text-amber" />
            {requests.length > 0 && <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center">{requests.length}</span>}
          </div>
          <div>
            <h1 className="font-heading font-bold text-xl tracking-tight">Входящие заявки</h1>
            <p className="text-xs text-gray-500 mt-0.5">{requests.length} активных • Обновление каждые 10 сек</p>
          </div>
        </div>
        <button onClick={fetchInbox} className="p-2 hover:bg-ink-200 rounded transition"><ArrowsClockwise size={18} className="text-gray-400" /></button>
      </div>

      {/* Stats mini bar */}
      {stats && (
        <div className="grid grid-cols-4 gap-2 mb-5">
          <div className="bg-blue-50 border border-blue-200 rounded p-3 text-center"><p className="font-extrabold text-lg text-blue-700">{stats.totalToday}</p><p className="text-[10px] text-blue-500 font-medium">Заявок</p></div>
          <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-center"><p className="font-extrabold text-lg text-emerald-700">{stats.accepted}</p><p className="text-[10px] text-emerald-500 font-medium">Принято</p></div>
          <div className="bg-red-50 border border-red-200 rounded p-3 text-center"><p className="font-extrabold text-lg text-red-700">{stats.missed}</p><p className="text-[10px] text-red-500 font-medium">Пропущено</p></div>
          <div className="bg-amber-50 border border-amber-200 rounded p-3 text-center"><p className="font-extrabold text-lg text-amber-700">₴{stats.earnings}</p><p className="text-[10px] text-amber-500 font-medium">Заработок</p></div>
        </div>
      )}

      {/* ─── LIVE DISPATCH (Sprint 15) — first-come-first-served ─── */}
      {liveOffers.length > 0 && (
        <div className="mb-5" data-testid="live-dispatch">
          <div className="flex items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1 text-[10px] font-extrabold uppercase tracking-[0.2em] text-amber-700 bg-amber-100 px-2 py-1 rounded-full">
              <Lightning size={11} weight="fill" /> Live dispatch · accept first wins
            </span>
            <span className="text-xs text-gray-400">{liveOffers.length} pending</span>
          </div>
          <div className="space-y-3">
            {liveOffers.map((o) => {
              const isExpiring = (o.secondsLeft ?? 0) < 15;
              return (
                <div
                  key={o.requestId}
                  className={`rounded-modal border-2 p-5 transition-all hover:shadow-lg ${isExpiring ? 'border-red-300 bg-red-50/40 urgency-flash' : 'border-amber-300 bg-amber-50/30'}`}
                  data-testid={`live-${o.requestId}`}
                >
                  <div className="flex items-start gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                        <span className="bg-amber-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Lightning size={10} weight="fill" /> QUICK REQUEST
                        </span>
                        {o.rank === 0 && (
                          <span className="bg-emerald-100 text-emerald-700 text-[10px] font-bold px-2 py-0.5 rounded-full">#1 PICK</span>
                        )}
                        {o.surgeKind === 'high' && (
                          <span className="bg-orange-500 text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1" data-testid={`live-surge-${o.requestId}`}>
                            <Fire size={10} weight="fill" /> {o.surgeLabel} EARNINGS
                          </span>
                        )}
                      </div>
                      <h3 className="font-heading font-bold text-base">{o.problemLabel || 'Quick service'}</h3>
                      <div className="flex items-center gap-4 mt-2 text-xs text-gray-600">
                        {o.distanceText && <span className="flex items-center gap-1"><MapPin size={14} weight="bold" />{o.distanceText}</span>}
                        {o.etaText && <span className="flex items-center gap-1"><Clock size={14} weight="bold" />{o.etaText}</span>}
                        {o.finalPrice && (
                          <span className="flex items-center gap-1 font-bold">
                            <CurrencyCircleDollar size={14} weight="bold" />
                            <span className={o.surgeKind === 'high' ? 'text-orange-700' : ''}>{o.finalPrice} €</span>
                            {o.surgeKind === 'high' && o.priceEstimate && o.priceEstimate !== o.finalPrice && (
                              <span className="text-gray-400 line-through text-[10px] font-normal">{o.priceEstimate}</span>
                            )}
                          </span>
                        )}
                      </div>
                      {o.problemText && <p className="mt-2 text-xs text-gray-500 italic">«{String(o.problemText).slice(0, 100)}»</p>}
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <div className={`text-center px-3 py-2 rounded border-2 ${isExpiring ? 'border-red-300 bg-red-50' : 'border-amber-300 bg-white'}`} data-testid={`live-timer-${o.requestId}`}>
                        <div className={`font-mono font-extrabold text-2xl ${isExpiring ? 'text-red-600' : 'text-amber-700'}`}>
                          {String(Math.floor((o.secondsLeft ?? 0) / 60)).padStart(2, '0')}:{String((o.secondsLeft ?? 0) % 60).padStart(2, '0')}
                        </div>
                        <p className="text-[9px] text-gray-500 font-medium">осталось</p>
                      </div>
                      <div className="flex flex-col gap-2">
                        <button
                          onClick={() => handleAcceptLive(o.requestId)}
                          className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-sm transition-all hover:scale-[1.03] active:scale-[0.97] flex items-center gap-2 shadow-lg shadow-emerald-600/20"
                          data-testid={`live-accept-${o.requestId}`}
                        >
                          <CheckCircle size={18} weight="fill" /> Принять
                        </button>
                        <button
                          onClick={() => handleRejectLive(o.requestId)}
                          className="px-6 py-2.5 bg-white hover:bg-red-50 text-gray-500 hover:text-red-600 rounded font-bold text-xs transition-all flex items-center justify-center gap-1.5 border border-gray-200 hover:border-red-200"
                          data-testid={`live-reject-${o.requestId}`}
                        >
                          <XCircle size={14} /> Пропустить
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Requests */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Spinner size={28} className="animate-spin text-amber" /><span className="ml-2 text-gray-500 text-sm">Загрузка заявок...</span></div>
      ) : requests.length === 0 ? (
        <div className="text-center py-16 bg-ink-100 rounded  rounded-modal ">
          <Bell size={48} className="text-gray-200 mx-auto mb-3" />
          <h3 className="font-heading font-bold text-base text-gray-400">Нет активных заявок</h3>
          <p className="text-xs text-gray-400 mt-1">Новые заявки появятся здесь автоматически</p>
        </div>
      ) : (
        <div className="space-y-3">
          {requests.map((r) => {
            const isUrgent = r.urgency === 'urgent' || r.timeLeft < 30;
            const isExpiring = r.timeLeft < 15;
            return (
              <div key={r.id} className={`bg-ink-100 rounded  rounded-modal border-2 p-5 transition-all hover:shadow-lg ${isExpiring ? 'border-red-300 bg-red-50/30 urgency-flash' : isUrgent ? 'border-amber-300 bg-amber-50/20' : 'border-ink-300'}`} data-testid={`request-${r.id}`}>
                <div className="flex items-start gap-4">
                  {/* Left: Info */}
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1.5">
                      {isUrgent && <span className="bg-amber-100 text-amber-700 text-[10px] font-extrabold px-2 py-0.5 rounded-full flex items-center gap-1"><Fire size={10} weight="fill" />СРОЧНО</span>}
                      {r.source === 'quick_request' && <span className="bg-blue-100 text-blue-700 text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"><Lightning size={10} weight="fill" />Быстрый</span>}
                    </div>
                    <h3 className="font-heading font-bold text-base text-white">{r.serviceName}</h3>
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span className="flex items-center gap-1"><MapPin size={14} weight="bold" />{r.distance} км</span>
                      <span className="flex items-center gap-1"><Clock size={14} weight="bold" />ETA {r.eta} мин</span>
                      <span className="flex items-center gap-1"><CurrencyCircleDollar size={14} weight="bold" />от {r.priceEstimate} ₴</span>
                    </div>
                    {r.comment && <p className="mt-2 text-xs text-gray-400 italic">«{r.comment.slice(0, 80)}»</p>}
                    <p className="mt-1.5 text-[10px] text-gray-400">{r.customerName} • {r.slotDate} {r.slotTime}</p>
                  </div>

                  {/* Right: Timer + Actions */}
                  <div className="flex items-center gap-4 flex-shrink-0">
                    {/* Timer */}
                    <div className={`text-center px-3 py-2 rounded border-2 ${isExpiring ? 'border-red-300 bg-red-50' : isUrgent ? 'border-amber-300 bg-amber-50' : 'border-ink-300 bg-ink-100'}`} data-testid={`timer-${r.id}`}>
                      <div className={`font-mono font-extrabold text-2xl ${isExpiring ? 'text-red-600' : isUrgent ? 'text-amber-600' : 'text-white'}`}>{formatTimer(r.timeLeft)}</div>
                      <p className="text-[9px] text-gray-400 font-medium">осталось</p>
                    </div>
                    {/* Buttons */}
                    <div className="flex flex-col gap-2">
                      <button onClick={() => handleAccept(r.id)} className="px-6 py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-bold text-sm transition-all hover:scale-[1.03] active:scale-[0.97] flex items-center gap-2 shadow-lg shadow-emerald-600/20" data-testid={`accept-${r.id}`}>
                        <CheckCircle size={18} weight="fill" /> Принять
                      </button>
                      <button onClick={() => handleReject(r.id)} className="px-6 py-2.5 bg-ink-200 hover:bg-red-50 text-gray-500 hover:text-red-600 rounded font-bold text-xs transition-all flex items-center justify-center gap-1.5  hover:border-red-200" data-testid={`reject-${r.id}`}>
                        <XCircle size={14} /> Пропустить
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
