import { useState, useEffect } from 'react';
import { Bell, Send, Plus, Edit, Trash2, Users, MapPin, Star, Filter, ChevronRight, Clock, Check, X } from 'lucide-react';
import { adminAPI } from '../services/api';

interface NotificationTemplate {
  id: string;
  code: string;
  title: string;
  message: string;
  category: string;
  channels: string[];
  variables?: Record<string, string>;
  isActive: boolean;
}

interface BulkNotification {
  id: string;
  title: string;
  message: string;
  filters: any;
  channels: string[];
  recipientCount: number;
  deliveredCount: number;
  status: string;
  createdAt: string;
  completedAt?: string;
}

export default function NotificationsPage() {
  const [activeTab, setActiveTab] = useState<'send' | 'templates' | 'history'>('send');
  const [templates, setTemplates] = useState<NotificationTemplate[]>([]);
  const [history, setHistory] = useState<BulkNotification[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Send form state
  const [sendForm, setSendForm] = useState({
    title: '',
    message: '',
    templateCode: '',
    filters: {
      zones: [] as string[],
      tiers: [] as string[],
      minScore: undefined as number | undefined,
      maxScore: undefined as number | undefined,
      isOnline: undefined as boolean | undefined,
      roles: ['provider_owner'] as string[],
    },
    channels: ['push'],
  });
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ success: boolean; count?: number } | null>(null);

  // Template form state
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateForm, setTemplateForm] = useState({
    code: '',
    title: '',
    message: '',
    category: 'supply',
    channels: ['push'],
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const [templatesRes, historyRes] = await Promise.all([
        adminAPI.getNotificationTemplates(),
        adminAPI.getBulkNotifications(),
      ]);
      setTemplates(templatesRes.data.templates || []);
      setHistory(historyRes.data.notifications || []);
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSend = async () => {
    if (!sendForm.title || !sendForm.message) {
      alert('Введите заголовок и сообщение');
      return;
    }

    setSending(true);
    setSendResult(null);
    try {
      const res = await adminAPI.sendBulkNotification({
        title: sendForm.title,
        message: sendForm.message,
        templateCode: sendForm.templateCode || undefined,
        filters: sendForm.filters,
        channels: sendForm.channels,
      });
      setSendResult({ success: true, count: res.data.recipientCount });
      loadData();
    } catch (err) {
      setSendResult({ success: false });
    } finally {
      setSending(false);
    }
  };

  const handleCreateTemplate = async () => {
    if (!templateForm.code || !templateForm.title || !templateForm.message) {
      alert('Заполните все поля');
      return;
    }

    try {
      await adminAPI.createNotificationTemplate(templateForm);
      setShowTemplateForm(false);
      setTemplateForm({ code: '', title: '', message: '', category: 'supply', channels: ['push'] });
      loadData();
    } catch (err) {
      console.error('Failed to create template:', err);
    }
  };

  const useTemplate = (template: NotificationTemplate) => {
    setSendForm({
      ...sendForm,
      title: template.title,
      message: template.message,
      templateCode: template.code,
    });
    setActiveTab('send');
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleString('ru-RU');
  };

  const tierLabels: Record<string, string> = {
    bronze: 'Бронза',
    silver: 'Серебро',
    gold: 'Золото',
    platinum: 'Платина',
  };

  return (
    <div className="p-6 bg-slate-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-500/20 rounded-lg">
            <Bell className="w-6 h-6 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Уведомления</h1>
            <p className="text-sm text-slate-400">Управление рассылками и шаблонами</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {[
          { id: 'send', label: 'Отправить', icon: Send },
          { id: 'templates', label: 'Шаблоны', icon: Edit },
          { id: 'history', label: 'История', icon: Clock },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
              activeTab === tab.id
                ? 'bg-indigo-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Send Tab */}
      {activeTab === 'send' && (
        <div className="grid grid-cols-3 gap-6">
          {/* Message Form */}
          <div className="col-span-2 bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Новая рассылка</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Заголовок</label>
                <input
                  type="text"
                  value={sendForm.title}
                  onChange={(e) => setSendForm({ ...sendForm, title: e.target.value })}
                  placeholder="Срочный заказ рядом"
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500"
                />
              </div>
              
              <div>
                <label className="block text-sm text-slate-400 mb-1">Сообщение</label>
                <textarea
                  value={sendForm.message}
                  onChange={(e) => setSendForm({ ...sendForm, message: e.target.value })}
                  placeholder="Рядом с вами появилась срочная заявка. Откройте приложение для просмотра."
                  rows={4}
                  className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white placeholder-slate-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-1">Каналы доставки</label>
                <div className="flex gap-2">
                  {['push', 'sms', 'email'].map((channel) => (
                    <button
                      key={channel}
                      onClick={() => {
                        const channels = sendForm.channels.includes(channel)
                          ? sendForm.channels.filter((c) => c !== channel)
                          : [...sendForm.channels, channel];
                        setSendForm({ ...sendForm, channels });
                      }}
                      className={`px-3 py-1.5 rounded-lg text-sm capitalize ${
                        sendForm.channels.includes(channel)
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-700 text-slate-400'
                      }`}
                    >
                      {channel}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Result */}
            {sendResult && (
              <div className={`mt-4 p-3 rounded-lg ${sendResult.success ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                {sendResult.success
                  ? `Отправлено ${sendResult.count} получателям`
                  : 'Ошибка отправки'}
              </div>
            )}

            <button
              onClick={handleSend}
              disabled={sending || !sendForm.title || !sendForm.message}
              className="mt-6 w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-medium py-3 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {sending ? (
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white" />
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Отправить рассылку
                </>
              )}
            </button>
          </div>

          {/* Filters */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Filter className="w-4 h-4" />
              Фильтры получателей
            </h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-slate-400 mb-2">Тиры мастеров</label>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(tierLabels).map(([tier, label]) => (
                    <button
                      key={tier}
                      onClick={() => {
                        const tiers = sendForm.filters.tiers.includes(tier)
                          ? sendForm.filters.tiers.filter((t) => t !== tier)
                          : [...sendForm.filters.tiers, tier];
                        setSendForm({
                          ...sendForm,
                          filters: { ...sendForm.filters, tiers },
                        });
                      }}
                      className={`px-2 py-1 rounded text-sm ${
                        sendForm.filters.tiers.includes(tier)
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-700 text-slate-400'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-2">Score диапазон</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    placeholder="От"
                    value={sendForm.filters.minScore || ''}
                    onChange={(e) =>
                      setSendForm({
                        ...sendForm,
                        filters: {
                          ...sendForm.filters,
                          minScore: e.target.value ? parseInt(e.target.value) : undefined,
                        },
                      })
                    }
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm"
                  />
                  <input
                    type="number"
                    placeholder="До"
                    value={sendForm.filters.maxScore || ''}
                    onChange={(e) =>
                      setSendForm({
                        ...sendForm,
                        filters: {
                          ...sendForm.filters,
                          maxScore: e.target.value ? parseInt(e.target.value) : undefined,
                        },
                      })
                    }
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm text-slate-400 mb-2">Статус</label>
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      setSendForm({
                        ...sendForm,
                        filters: { ...sendForm.filters, isOnline: true },
                      })
                    }
                    className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-1 ${
                      sendForm.filters.isOnline === true
                        ? 'bg-green-600 text-white'
                        : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="w-2 h-2 rounded-full bg-green-400" />
                    Online
                  </button>
                  <button
                    onClick={() =>
                      setSendForm({
                        ...sendForm,
                        filters: { ...sendForm.filters, isOnline: false },
                      })
                    }
                    className={`flex-1 px-3 py-2 rounded-lg text-sm flex items-center justify-center gap-1 ${
                      sendForm.filters.isOnline === false
                        ? 'bg-slate-600 text-white'
                        : 'bg-slate-700 text-slate-400'
                    }`}
                  >
                    <div className="w-2 h-2 rounded-full bg-slate-500" />
                    Offline
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Templates Tab */}
      {activeTab === 'templates' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold text-white">Шаблоны уведомлений</h2>
            <button
              onClick={() => setShowTemplateForm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              Создать шаблон
            </button>
          </div>

          {/* Template Form Modal */}
          {showTemplateForm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
              <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-lg">
                <h3 className="text-lg font-semibold text-white mb-4">Новый шаблон</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Код</label>
                    <input
                      type="text"
                      value={templateForm.code}
                      onChange={(e) => setTemplateForm({ ...templateForm, code: e.target.value })}
                      placeholder="urgent_request_nearby"
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Заголовок</label>
                    <input
                      type="text"
                      value={templateForm.title}
                      onChange={(e) => setTemplateForm({ ...templateForm, title: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Сообщение</label>
                    <textarea
                      value={templateForm.message}
                      onChange={(e) => setTemplateForm({ ...templateForm, message: e.target.value })}
                      rows={3}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-slate-400 mb-1">Категория</label>
                    <select
                      value={templateForm.category}
                      onChange={(e) => setTemplateForm({ ...templateForm, category: e.target.value })}
                      className="w-full bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                    >
                      <option value="supply">Supply</option>
                      <option value="demand">Demand</option>
                      <option value="system">System</option>
                      <option value="promo">Promo</option>
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-6">
                  <button
                    onClick={() => setShowTemplateForm(false)}
                    className="px-4 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-600"
                  >
                    Отмена
                  </button>
                  <button
                    onClick={handleCreateTemplate}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
                  >
                    Создать
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Templates List */}
          <div className="grid grid-cols-2 gap-4">
            {templates.map((template) => (
              <div
                key={template.id}
                className="bg-slate-800 border border-slate-700 rounded-xl p-4 hover:border-slate-600 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-xs text-indigo-400 font-mono">{template.code}</span>
                    <h3 className="text-white font-medium mt-1">{template.title}</h3>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs ${
                    template.isActive ? 'bg-green-500/20 text-green-400' : 'bg-slate-600 text-slate-400'
                  }`}>
                    {template.isActive ? 'Активен' : 'Неактивен'}
                  </span>
                </div>
                <p className="text-slate-400 text-sm mt-2 line-clamp-2">{template.message}</p>
                <div className="flex items-center justify-between mt-4">
                  <div className="flex gap-1">
                    {template.channels.map((ch) => (
                      <span key={ch} className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-400 capitalize">
                        {ch}
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => useTemplate(template)}
                    className="text-indigo-400 hover:text-indigo-300 text-sm flex items-center gap-1"
                  >
                    Использовать
                    <ChevronRight className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* History Tab */}
      {activeTab === 'history' && (
        <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
          <table className="w-full">
            <thead className="bg-slate-750">
              <tr>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-400">Заголовок</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-400">Получатели</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-400">Каналы</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-400">Статус</th>
                <th className="px-4 py-3 text-left text-sm font-medium text-slate-400">Дата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700">
              {history.map((item) => (
                <tr key={item.id} className="hover:bg-slate-750">
                  <td className="px-4 py-3">
                    <div className="text-white font-medium">{item.title}</div>
                    <div className="text-slate-400 text-sm truncate max-w-xs">{item.message}</div>
                  </td>
                  <td className="px-4 py-3 text-white">{item.recipientCount}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {item.channels.map((ch) => (
                        <span key={ch} className="px-1.5 py-0.5 bg-slate-700 rounded text-xs text-slate-400 capitalize">
                          {ch}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded text-xs ${
                      item.status === 'completed' ? 'bg-green-500/20 text-green-400' :
                      item.status === 'sending' ? 'bg-yellow-500/20 text-yellow-400' :
                      item.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                      'bg-slate-600 text-slate-400'
                    }`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400 text-sm">
                    {formatDate(item.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length === 0 && (
            <div className="p-8 text-center">
              <Bell className="w-10 h-10 text-slate-600 mx-auto mb-2" />
              <p className="text-slate-400">Нет истории рассылок</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
