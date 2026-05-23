import { useEffect, useState } from 'react';
import { CreditCard, Save, RefreshCw, CheckCircle, AlertCircle, Eye, EyeOff, Power } from 'lucide-react';
import axios from 'axios';

interface StripeConfig {
  configured: boolean;
  enabled: boolean;
  secret_key_masked: string;
  webhook_secret_masked: string;
  webhook_url_hint: string;
  env_fallback_available: boolean;
  updated_at?: string;
}

const api = axios.create({ baseURL: '/api' });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export default function StripePaymentsPage() {
  const [cfg, setCfg] = useState<StripeConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form fields (empty = "не менять при сохранении")
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [showWebhook, setShowWebhook] = useState(false);

  const fetchConfig = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<StripeConfig>('/admin/billing/stripe-config');
      setCfg(res.data);
      setEnabled(res.data.enabled);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load config');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: any = { enabled };
      if (secretKey.trim()) payload.secret_key = secretKey.trim();
      if (webhookSecret.trim()) payload.webhook_secret = webhookSecret.trim();
      await api.post('/admin/billing/stripe-config', payload);
      setSecretKey('');
      setWebhookSecret('');
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2500);
      await fetchConfig();
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async () => {
    if (!cfg?.configured && !secretKey.trim()) {
      setError('Сначала введите Secret Key, затем включите интеграцию');
      return;
    }
    const next = !enabled;
    setEnabled(next);
    setSaving(true);
    setError(null);
    try {
      const payload: any = { enabled: next };
      if (secretKey.trim()) payload.secret_key = secretKey.trim();
      if (webhookSecret.trim()) payload.webhook_secret = webhookSecret.trim();
      await api.post('/admin/billing/stripe-config', payload);
      await fetchConfig();
    } catch (err: any) {
      setEnabled(!next); // rollback
      setError(err?.response?.data?.message || 'Failed to toggle');
    } finally {
      setSaving(false);
    }
  };

  const webhookFullUrl = typeof window !== 'undefined'
    ? `${window.location.origin}${cfg?.webhook_url_hint || '/api/billing/webhook'}`
    : (cfg?.webhook_url_hint || '/api/billing/webhook');

  return (
    <div className="p-6 max-w-4xl" data-testid="stripe-settings-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-slate-700 rounded-lg">
            <CreditCard size={24} className="text-green-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Stripe Payments</h1>
            <p className="text-slate-400 text-sm">Конфигурация платежной интеграции (test mode)</p>
          </div>
        </div>
        <button
          onClick={fetchConfig}
          className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg"
          data-testid="stripe-refresh-btn"
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Status card */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 mb-5" data-testid="stripe-status-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${cfg?.enabled ? 'bg-green-500/20' : 'bg-slate-700'}`}>
              <Power size={20} className={cfg?.enabled ? 'text-green-400' : 'text-slate-500'} />
            </div>
            <div>
              <div className="text-sm text-slate-400">Текущий статус</div>
              <div className={`text-lg font-bold ${cfg?.enabled ? 'text-green-400' : 'text-slate-300'}`}>
                {loading ? 'Загрузка...' : cfg?.enabled ? 'Включена' : cfg?.configured ? 'Настроена, выключена' : 'Не настроена'}
              </div>
            </div>
          </div>
          <button
            onClick={handleToggleEnabled}
            disabled={saving || loading}
            className={`px-5 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 ${
              enabled ? 'bg-red-500 hover:bg-red-600 text-white' : 'bg-green-500 hover:bg-green-600 text-white'
            }`}
            data-testid="stripe-toggle-btn"
          >
            {enabled ? 'Выключить' : 'Включить'}
          </button>
        </div>
        {cfg?.updated_at && (
          <div className="mt-3 text-xs text-slate-500">
            Обновлено: {new Date(cfg.updated_at).toLocaleString('ru-RU')}
          </div>
        )}
      </div>

      {/* Webhook URL info card */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 mb-5" data-testid="stripe-webhook-info">
        <div className="flex items-center gap-2 mb-2">
          <AlertCircle size={18} className="text-amber-400" />
          <h3 className="text-white font-semibold">Webhook URL (фиксированный)</h3>
        </div>
        <p className="text-sm text-slate-400 mb-3">
          Зарегистрируйте этот URL в Stripe Dashboard → Developers → Webhooks. Для события <code className="text-amber-300 bg-slate-900 px-1 rounded">checkout.session.completed</code>.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-amber-300 font-mono text-sm" data-testid="webhook-url">
            {webhookFullUrl}
          </code>
          <button
            onClick={() => navigator.clipboard.writeText(webhookFullUrl)}
            className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm"
          >
            Копировать
          </button>
        </div>
      </div>

      {/* Form card */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-5">
        <h3 className="text-white font-semibold">Ключи API</h3>

        {/* Secret Key */}
        <div data-testid="stripe-secret-key-row">
          <label className="block text-sm text-slate-300 mb-1">Stripe Secret Key</label>
          <p className="text-xs text-slate-500 mb-2">
            Текущий: <span className="font-mono text-slate-400">{cfg?.secret_key_masked || '— не задан —'}</span>
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="sk_test_..."
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-4 pr-10 py-2 text-white font-mono"
                data-testid="stripe-secret-key-input"
              />
              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
              >
                {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-1">Только test-режим: ключи начинаются с <code>sk_test_</code></p>
        </div>

        {/* Webhook Secret */}
        <div data-testid="stripe-webhook-secret-row">
          <label className="block text-sm text-slate-300 mb-1">Webhook Signing Secret</label>
          <p className="text-xs text-slate-500 mb-2">
            Текущий: <span className="font-mono text-slate-400">{cfg?.webhook_secret_masked || '— не задан —'}</span>
          </p>
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                type={showWebhook ? 'text' : 'password'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder="whsec_..."
                className="w-full bg-slate-700 border border-slate-600 rounded-lg pl-4 pr-10 py-2 text-white font-mono"
                data-testid="stripe-webhook-secret-input"
              />
              <button
                type="button"
                onClick={() => setShowWebhook(!showWebhook)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white p-1"
              >
                {showWebhook ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-1">Получите при регистрации webhook'а в Stripe Dashboard</p>
        </div>

        {/* Save */}
        <div className="flex items-center justify-between pt-3 border-t border-slate-700">
          <div className="text-sm">
            {error && (
              <span className="text-red-400 flex items-center gap-1">
                <AlertCircle size={14} /> {error}
              </span>
            )}
            {savedAt && !error && (
              <span className="text-green-400 flex items-center gap-1">
                <CheckCircle size={14} /> Сохранено
              </span>
            )}
            {!error && !savedAt && (
              <span className="text-slate-500">Пустые поля не перезаписывают сохранённые ключи</span>
            )}
          </div>
          <button
            onClick={handleSave}
            disabled={saving || (!secretKey.trim() && !webhookSecret.trim() && enabled === cfg?.enabled)}
            className="flex items-center gap-2 px-5 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg disabled:opacity-50"
            data-testid="stripe-save-btn"
          >
            {saving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
            Сохранить
          </button>
        </div>
      </div>

      {/* Test card info */}
      <div className="mt-5 bg-slate-800 rounded-xl border border-slate-700 p-5">
        <h3 className="text-white font-semibold mb-2">Тестирование (test mode)</h3>
        <p className="text-sm text-slate-400 mb-2">Используйте тестовую карту Stripe для проверки оплаты:</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-slate-500">Номер карты</div>
            <code className="text-amber-300 font-mono">4242 4242 4242 4242</code>
          </div>
          <div>
            <div className="text-xs text-slate-500">CVV / срок</div>
            <code className="text-amber-300 font-mono">любые валидные</code>
          </div>
        </div>
      </div>
    </div>
  );
}
