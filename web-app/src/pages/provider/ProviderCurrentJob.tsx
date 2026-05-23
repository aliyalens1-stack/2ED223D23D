import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Car, MapPin, Wrench, CheckCircle, Clock, ArrowRight, Trophy, User, Phone, ChatText, ArrowsClockwise, Spinner, Warning } from '@phosphor-icons/react';
import { providerAPI } from '../../services/api';

const STATUS_ACTIONS: Record<string, { label: string; action: string; icon: any; color: string }> = {
  confirmed: { label: 'Выехал к клиенту', action: 'depart', icon: Car, color: 'bg-amber hover:bg-amber-600 shadow-blue-600/20' },
  on_route: { label: 'Прибыл на место', action: 'arrive', icon: MapPin, color: 'bg-violet-600 hover:bg-violet-700 shadow-violet-600/20' },
  arrived: { label: 'Начать работу', action: 'start', icon: Wrench, color: 'bg-amber-600 hover:bg-amber-700 shadow-amber-600/20' },
  in_progress: { label: 'Завершить работу', action: 'complete', icon: Trophy, color: 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-600/20' },
};

const STATUS_TEXT: Record<string, { title: string; subtitle: string; color: string }> = {
  confirmed: { title: 'Заказ принят', subtitle: 'Нажмите "Выехал" когда начнёте движение к клиенту', color: 'text-blue-700 bg-blue-50 border-blue-200' },
  on_route: { title: 'В пути к клиенту', subtitle: 'Нажмите "Прибыл" когда доберётесь до места', color: 'text-violet-700 bg-violet-50 border-violet-200' },
  arrived: { title: 'На месте', subtitle: 'Нажмите "Начать работу" когда будете готовы', color: 'text-amber-700 bg-amber-50 border-amber-200' },
  in_progress: { title: 'Работа выполняется', subtitle: 'Нажмите "Завершить" когда закончите', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  completed: { title: 'Заказ завершён', subtitle: 'Отличная работа! Ожидайте новые заявки.', color: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
};

export default function ProviderCurrentJob() {
  const navigate = useNavigate();
  const [job, setJob] = useState<any>(null);
  const [hasJob, setHasJob] = useState(false);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const fetchJob = useCallback(async () => {
    try {
      const { data } = await providerAPI.getCurrentJob();
      setHasJob(data.hasJob);
      setJob(data.job);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchJob(); }, [fetchJob]);
  useEffect(() => {
    if (!hasJob || job?.status === 'completed') return;
    const iv = setInterval(fetchJob, 10000);
    return () => clearInterval(iv);
  }, [hasJob, job?.status, fetchJob]);

  const handleAction = async (action: string) => {
    if (!job) return;
    setActing(true);
    try {
      await providerAPI.jobAction(job.id, action);
      fetchJob();
    } catch (err) { console.error(err); }
    finally { setActing(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-16" data-testid="current-job-loading"><Spinner size={28} className="animate-spin text-amber" /></div>;

  if (!hasJob) return (
    <div className="text-center py-20" data-testid="no-current-job">
      <Car size={56} className="text-gray-200 mx-auto mb-4" />
      <h2 className="font-heading font-bold text-lg text-gray-400 mb-1">Нет активных заказов</h2>
      <p className="text-sm text-gray-400 mb-4">Примите заявку из входящих, чтобы начать работу</p>
      <button onClick={() => navigate('/provider/inbox')} className="px-6 py-2.5 bg-amber text-white rounded font-bold text-sm hover:bg-amber-600 transition" data-testid="go-inbox-btn">Перейти к заявкам</button>
    </div>
  );

  const status = job.status || 'confirmed';
  const actionCfg = STATUS_ACTIONS[status];
  const statusText = STATUS_TEXT[status] || STATUS_TEXT.confirmed;

  return (
    <div data-testid="provider-current-job">
      <div className="flex items-center justify-between mb-5">
        <div><h1 className="font-heading font-bold text-xl tracking-tight">Текущий заказ</h1><p className="text-xs text-gray-500 mt-0.5">#{job.id?.slice(0, 8)}</p></div>
        <button onClick={fetchJob} className="p-2 hover:bg-ink-200 rounded transition"><ArrowsClockwise size={18} className="text-gray-400" /></button>
      </div>

      {/* Status banner */}
      <div className={`rounded-modal p-5 border-2 mb-6 ${statusText.color}`} data-testid="job-status-banner">
        <h2 className="font-heading font-extrabold text-lg">{statusText.title}</h2>
        <p className="text-sm mt-0.5 opacity-80">{statusText.subtitle}</p>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Left: Job details + Actions */}
        <div className="col-span-7 space-y-5">
          {/* Customer info */}
          <div className="bg-ink-100 rounded  rounded-modal p-5 " data-testid="customer-info">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-ink-200 rounded flex items-center justify-center"><User size={24} className="text-gray-400" /></div>
              <div>
                <h3 className="font-bold text-base">{job.customerName || 'Клиент'}</h3>
                <p className="text-xs text-gray-500">{job.address || job.providerName || 'Адрес не указан'}</p>
              </div>
              <div className="ml-auto flex gap-2">
                <button className="w-10 h-10 bg-blue-50 border border-blue-200 rounded flex items-center justify-center hover:bg-blue-100 transition"><Phone size={18} className="text-amber" /></button>
                <button className="w-10 h-10 bg-ink-100  rounded flex items-center justify-center hover:bg-ink-200 transition"><ChatText size={18} className="text-gray-400" /></button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-ink-100 rounded p-3"><p className="text-[10px] uppercase text-gray-400 font-bold mb-0.5">Услуга</p><p className="text-sm font-semibold">{job.serviceName}</p></div>
              <div className="bg-ink-100 rounded p-3"><p className="text-[10px] uppercase text-gray-400 font-bold mb-0.5">Время</p><p className="text-sm font-semibold">{job.slotDate} {job.slotTime}</p></div>
            </div>
            {job.comment && <div className="mt-3 bg-ink-100 rounded p-3"><p className="text-[10px] uppercase text-gray-400 font-bold mb-0.5">Комментарий</p><p className="text-sm text-gray-300">{job.comment}</p></div>}
          </div>

          {/* STATUS TIMELINE (provider side) */}
          <div className="bg-ink-100 rounded  rounded-modal p-5 " data-testid="job-timeline">
            <h3 className="font-heading font-bold text-sm mb-4">Прогресс заказа</h3>
            <div className="flex items-center gap-2">
              {['confirmed', 'on_route', 'arrived', 'in_progress', 'completed'].map((s, i) => {
                const order = ['confirmed', 'on_route', 'arrived', 'in_progress', 'completed'];
                const currentIdx = order.indexOf(status);
                const thisIdx = i;
                const done = thisIdx < currentIdx;
                const active = thisIdx === currentIdx;
                const labels = ['Принят', 'В пути', 'На месте', 'Работа', 'Готово'];
                return (
                  <div key={s} className="flex items-center gap-2 flex-1">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${active ? 'bg-amber text-white ring-4 ring-blue-100' : done ? 'bg-emerald-500 text-white' : 'bg-ink-200 text-gray-400'}`}>
                      {done ? <CheckCircle size={14} weight="fill" /> : i + 1}
                    </div>
                    <span className={`text-[10px] font-medium ${active ? 'text-blue-700' : done ? 'text-emerald-700' : 'text-gray-400'}`}>{labels[i]}</span>
                    {i < 4 && <div className={`flex-1 h-0.5 rounded ${done ? 'bg-emerald-400' : 'bg-gray-200'}`} />}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ACTION BUTTON — DOMINANT */}
          {actionCfg && (
            <button onClick={() => handleAction(actionCfg.action)} disabled={acting} className={`w-full py-5 rounded-modal font-extrabold text-lg text-white flex items-center justify-center gap-3 transition-all hover:scale-[1.01] active:scale-[0.99] shadow-xl ${actionCfg.color} disabled:opacity-50`} data-testid="job-action-btn">
              {acting ? <Spinner size={22} className="animate-spin" /> : <actionCfg.icon size={24} weight="fill" />}
              {acting ? 'Обработка...' : actionCfg.label}
            </button>
          )}

          {status === 'completed' && (
            <div className="text-center py-4">
              <div className="w-16 h-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-3"><Trophy size={32} weight="fill" className="text-emerald-500" /></div>
              <h3 className="font-heading font-extrabold text-xl text-white mb-1">Заказ завершён!</h3>
              <p className="text-sm text-gray-500 mb-4">Ожидайте оценку от клиента</p>
              <button onClick={() => navigate('/provider/inbox')} className="px-8 py-3 bg-amber text-white rounded font-bold text-sm hover:bg-amber-600 transition" data-testid="back-inbox-btn">Вернуться к заявкам</button>
            </div>
          )}
        </div>

        {/* Right: Summary */}
        <div className="col-span-5 space-y-4">
          {/* Price card */}
          <div className="bg-ink-100 rounded  rounded-modal p-5 ">
            <h3 className="font-heading font-bold text-sm mb-3">Стоимость</h3>
            <p className="font-extrabold text-3xl text-white">от {job.priceEstimate || 500} ₴</p>
            <p className="text-xs text-gray-400 mt-1">Оплата при встрече</p>
          </div>

          {/* ETA */}
          {(status === 'on_route' || status === 'confirmed') && job.eta && (
            <div className="bg-blue-50 rounded-modal p-5 border border-blue-200">
              <h3 className="font-heading font-bold text-sm text-blue-700 mb-2">Время в пути</h3>
              <p className="font-extrabold text-3xl text-blue-700">{job.eta} мин</p>
            </div>
          )}

          {/* Quick info */}
          <div className="bg-ink-100 rounded  rounded-modal p-5 ">
            <h3 className="font-heading font-bold text-sm mb-3">Информация</h3>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between"><span className="text-gray-500">Источник</span><span className="font-semibold">{job.source === 'quick_request' ? 'Быстрый запрос' : 'Маркетплейс'}</span></div>
              <div className="flex justify-between"><span className="text-gray-500">Создан</span><span className="font-semibold">{job.createdAt ? new Date(job.createdAt).toLocaleTimeString('ru', {hour:'2-digit',minute:'2-digit'}) : '—'}</span></div>
              {job.acceptedAt && <div className="flex justify-between"><span className="text-gray-500">Принят</span><span className="font-semibold">{new Date(job.acceptedAt).toLocaleTimeString('ru', {hour:'2-digit',minute:'2-digit'})}</span></div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
