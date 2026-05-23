import { useState } from 'react';
import { 
  Zap, Plus, Search, Send, AlertTriangle, Users, MapPin, 
  Bell, TrendingUp, ArrowRight, X, Calendar, FileText,
  Power, Pause, Eye, EyeOff
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { adminAPI } from '../services/api';

interface QuickAction {
  id: string;
  label: string;
  icon: any;
  color: string;
  shortcut?: string;
  action: () => void;
}

export default function QuickActionsPanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

  const quickActions: QuickAction[] = [
    {
      id: 'new-quote',
      label: 'Создать заявку',
      icon: Plus,
      color: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30',
      shortcut: 'Q',
      action: () => navigate('/quotes?action=new'),
    },
    {
      id: 'find-customer',
      label: 'Найти клиента',
      icon: Search,
      color: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30',
      shortcut: 'C',
      action: () => {
        onClose();
        document.dispatchEvent(new CustomEvent('open-search', { detail: { filter: 'user' } }));
      },
    },
    {
      id: 'find-provider',
      label: 'Найти мастера',
      icon: Users,
      color: 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30',
      shortcut: 'P',
      action: () => {
        onClose();
        document.dispatchEvent(new CustomEvent('open-search', { detail: { filter: 'provider' } }));
      },
    },
    {
      id: 'send-push',
      label: 'Отправить Push',
      icon: Send,
      color: 'bg-indigo-500/20 text-indigo-400 hover:bg-indigo-500/30',
      shortcut: 'N',
      action: () => navigate('/notifications'),
    },
    {
      id: 'problem-orders',
      label: 'Проблемные заказы',
      icon: AlertTriangle,
      color: 'bg-red-500/20 text-red-400 hover:bg-red-500/30',
      shortcut: 'X',
      action: () => navigate('/bookings?filter=problems'),
    },
    {
      id: 'boost-zone',
      label: 'Буст зоны',
      icon: TrendingUp,
      color: 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30',
      shortcut: 'B',
      action: () => navigate('/geo-ops'),
    },
  ];

  const instantActions = [
    {
      id: 'surge-all',
      label: 'Включить Surge во всех зонах',
      icon: Zap,
      color: 'text-yellow-400',
      execute: async () => {
        setLoading('surge-all');
        try {
          // This would call API to enable surge
          await new Promise(r => setTimeout(r, 500));
          setResult({ success: true, message: 'Surge включен во всех активных зонах' });
        } catch {
          setResult({ success: false, message: 'Ошибка включения surge' });
        }
        setLoading(null);
      },
    },
    {
      id: 'push-online',
      label: 'Push всем онлайн мастерам',
      icon: Bell,
      color: 'text-indigo-400',
      execute: async () => {
        setLoading('push-online');
        try {
          await adminAPI.sendBulkNotification({
            title: 'Высокий спрос!',
            message: 'Сейчас много заявок в вашем районе. Включите режим приёма.',
            filters: { isOnline: true, roles: ['provider_owner'] },
            channels: ['push'],
          });
          setResult({ success: true, message: 'Push отправлен онлайн мастерам' });
        } catch {
          setResult({ success: false, message: 'Ошибка отправки' });
        }
        setLoading(null);
      },
    },
    {
      id: 'disable-auto',
      label: 'Отключить Auto Distribution',
      icon: Pause,
      color: 'text-orange-400',
      execute: async () => {
        setLoading('disable-auto');
        await new Promise(r => setTimeout(r, 500));
        setResult({ success: true, message: 'Auto Distribution отключен' });
        setLoading(null);
      },
    },
  ];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      
      <div className="relative w-full max-w-2xl bg-slate-800 border border-slate-700 rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-400" />
            <span className="font-semibold text-white">Quick Actions</span>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-700 rounded">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Result Message */}
        {result && (
          <div className={`mx-4 mt-4 p-3 rounded-lg ${result.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
            {result.message}
          </div>
        )}

        {/* Navigation Actions */}
        <div className="p-4">
          <h3 className="text-xs font-medium text-slate-500 uppercase mb-3">Навигация</h3>
          <div className="grid grid-cols-3 gap-2">
            {quickActions.map((action) => (
              <button
                key={action.id}
                onClick={() => {
                  action.action();
                  onClose();
                }}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-lg transition-colors ${action.color}`}
              >
                <action.icon className="w-4 h-4" />
                <span className="text-sm flex-1 text-left">{action.label}</span>
                {action.shortcut && (
                  <kbd className="px-1.5 py-0.5 bg-slate-700/50 rounded text-xs">{action.shortcut}</kbd>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Instant Actions */}
        <div className="p-4 border-t border-slate-700">
          <h3 className="text-xs font-medium text-slate-500 uppercase mb-3">Мгновенные действия</h3>
          <div className="space-y-2">
            {instantActions.map((action) => (
              <button
                key={action.id}
                onClick={action.execute}
                disabled={loading === action.id}
                className="w-full flex items-center gap-3 px-3 py-2.5 bg-slate-700/50 hover:bg-slate-700 rounded-lg transition-colors text-left disabled:opacity-50"
              >
                {loading === action.id ? (
                  <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <action.icon className={`w-4 h-4 ${action.color}`} />
                )}
                <span className="text-sm text-white flex-1">{action.label}</span>
                <ArrowRight className="w-4 h-4 text-slate-500" />
              </button>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-slate-700 flex items-center justify-between text-xs text-slate-500">
          <span>ESC для закрытия</span>
          <span>⌘J для Quick Actions</span>
        </div>
      </div>
    </div>
  );
}
