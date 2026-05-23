import { useEffect, useState } from 'react';
import { adminAPI } from '../services/api';
import { Settings, Sliders, Save, RefreshCw, CheckCircle, Database, CreditCard, Clock, Shield } from 'lucide-react';

interface ConfigItem {
  _id: string;
  key: string;
  value: any;
  description: string;
  isSecret: boolean;
}

const CONFIG_GROUPS: Record<string, { label: string; icon: any; color: string }> = {
  'platform': { label: 'Платформа', icon: Sliders, color: 'text-blue-400' },
  'booking': { label: 'Бронирования', icon: Clock, color: 'text-purple-400' },
  'stripe': { label: 'Stripe (Платежи)', icon: CreditCard, color: 'text-green-400' },
};

export default function SettingsPage() {
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, any>>({});
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await adminAPI.getConfig();
      setConfigs(res.data || []);
      const vals: Record<string, any> = {};
      (res.data || []).forEach((c: ConfigItem) => { vals[c.key] = c.value; });
      setEditValues(vals);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleSave = async (key: string) => {
    setSaving(key);
    try {
      await adminAPI.setConfig(key, editValues[key]);
      setSavedKeys(prev => new Set(prev).add(key));
      setTimeout(() => setSavedKeys(prev => { const n = new Set(prev); n.delete(key); return n; }), 2000);
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(null);
    }
  };

  const handleSaveAll = async () => {
    for (const config of configs) {
      const original = config.isSecret && config.value === '***configured***' ? undefined : config.value;
      if (editValues[config.key] !== original) {
        await handleSave(config.key);
      }
    }
  };

  const isChanged = (key: string) => {
    const config = configs.find(c => c.key === key);
    if (!config) return false;
    if (config.isSecret && config.value === '***configured***') return false;
    return editValues[key] !== config.value;
  };

  const grouped = configs.reduce((acc: Record<string, ConfigItem[]>, c) => {
    const group = c.key.split('.')[0];
    if (!acc[group]) acc[group] = [];
    acc[group].push(c);
    return acc;
  }, {});

  const hasChanges = configs.some(c => isChanged(c.key));

  return (
    <div className="p-6" data-testid="settings-page">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-slate-700 rounded-lg">
            <Settings size={24} className="text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Настройки платформы</h1>
            <p className="text-slate-400 text-sm">Конфигурация системы</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchConfig} className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg" data-testid="refresh-config-btn">
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          {hasChanges && (
            <button onClick={handleSaveAll} className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg" data-testid="save-all-btn">
              <Save size={18} /> Сохранить все изменения
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center text-slate-400">Загрузка конфигурации...</div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([group, items]) => {
            const groupConfig = CONFIG_GROUPS[group] || { label: group, icon: Database, color: 'text-slate-400' };
            const Icon = groupConfig.icon;
            return (
              <div key={group} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
                <div className="p-4 border-b border-slate-700 flex items-center gap-3">
                  <Icon size={20} className={groupConfig.color} />
                  <h2 className="text-lg font-semibold text-white">{groupConfig.label}</h2>
                </div>
                <div className="p-4 space-y-4">
                  {items.map((config) => (
                    <div key={config.key} className="flex items-center gap-4" data-testid={`setting-${config.key}`}>
                      <div className="flex-1">
                        <label className="block text-sm text-slate-300 mb-1">{config.description}</label>
                        <p className="text-xs text-slate-500 font-mono">{config.key}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {config.isSecret ? (
                          <input
                            type="password"
                            value={editValues[config.key] || ''}
                            onChange={e => setEditValues(v => ({ ...v, [config.key]: e.target.value }))}
                            placeholder="***"
                            className="w-64 bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                          />
                        ) : typeof config.value === 'number' ? (
                          <input
                            type="number"
                            value={editValues[config.key] ?? ''}
                            onChange={e => setEditValues(v => ({ ...v, [config.key]: parseFloat(e.target.value) || 0 }))}
                            className="w-32 bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                          />
                        ) : (
                          <input
                            type="text"
                            value={editValues[config.key] ?? ''}
                            onChange={e => setEditValues(v => ({ ...v, [config.key]: e.target.value }))}
                            className="w-64 bg-slate-700 border border-slate-600 rounded-lg px-4 py-2 text-white"
                          />
                        )}
                        {isChanged(config.key) && (
                          <button
                            onClick={() => handleSave(config.key)}
                            disabled={saving === config.key}
                            className="px-3 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm disabled:opacity-50"
                            data-testid={`save-${config.key}`}
                          >
                            {saving === config.key ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                          </button>
                        )}
                        {savedKeys.has(config.key) && (
                          <CheckCircle size={18} className="text-green-400" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
