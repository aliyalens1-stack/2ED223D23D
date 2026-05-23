import { useState, useEffect } from 'react';
import api from '../services/api';
import { toast } from 'sonner';

type ProviderRecord = {
  provider: string;
  mode: 'test' | 'live';
  enabled: boolean;
  payload: Record<string, string>;
  updated_at?: string;
  updated_by?: string;
};

type TestResult = {
  ok: boolean;
  stage: string;
  livemode?: boolean;
  available_currencies?: string[];
  error?: string;
  note?: string;
};

// Per-provider field templates. Admin can edit existing values or add fields.
const PROVIDER_FIELDS: Record<string, string[]> = {
  stripe: ['publishable_key', 'secret_key', 'restricted_key', 'webhook_secret'],
  paypal: ['client_id', 'client_secret', 'webhook_id'],
  firebase_push: ['service_account_json'],
  expo_push: ['access_token'],
  postmark: ['api_key', 'from_email'],
  sendgrid: ['api_key', 'from_email'],
  twilio_sms: ['account_sid', 'auth_token', 'from_number'],
};

const SECRET_FIELDS = new Set([
  'secret_key', 'restricted_key', 'webhook_secret',
  'client_secret', 'api_key', 'private_key',
  'service_account_json', 'access_token', 'auth_token',
]);

function IntegrationsPage() {
  const [providers, setProviders] = useState<ProviderRecord[]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [formMode, setFormMode] = useState<'test' | 'live'>('test');
  const [formEnabled, setFormEnabled] = useState(true);
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/admin/integrations/');
      setProviders(res.data.providers || []);
      setKnown(res.data.known_providers || []);
    } catch (e: any) {
      toast.error(`Failed to load: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const startEdit = (provider: string) => {
    setEditing(provider);
    const existing = providers.find((p) => p.provider === provider);
    if (existing) {
      // Don't pre-fill masked secret values — admin must re-enter to rotate.
      const cleanPayload: Record<string, string> = {};
      const fields = PROVIDER_FIELDS[provider] || Object.keys(existing.payload);
      for (const k of fields) {
        const val = existing.payload[k];
        // If masked (contains "..." or "***"), leave blank. Else carry over (publishable, from_email, etc.)
        if (typeof val === 'string' && !val.includes('...') && val !== '***') {
          cleanPayload[k] = val;
        } else {
          cleanPayload[k] = '';
        }
      }
      setFormData(cleanPayload);
      setFormMode(existing.mode);
      setFormEnabled(existing.enabled);
    } else {
      // New provider
      const fields = PROVIDER_FIELDS[provider] || [];
      setFormData(Object.fromEntries(fields.map((f) => [f, ''])));
      setFormMode('test');
      setFormEnabled(true);
    }
  };

  const saveProvider = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      // Merge with existing payload — admin only updates fields they edited.
      const existing = providers.find((p) => p.provider === editing);
      const finalPayload: Record<string, string> = {};
      for (const [k, v] of Object.entries(formData)) {
        if (v && v.trim() !== '') {
          finalPayload[k] = v.trim();
        } else if (existing && existing.payload[k] && !existing.payload[k].includes('...') && existing.payload[k] !== '***') {
          // Keep existing non-masked value (e.g. publishable_key reuse)
          finalPayload[k] = existing.payload[k];
        }
      }
      await api.put(`/admin/integrations/${editing}`, {
        payload: finalPayload,
        mode: formMode,
        enabled: formEnabled,
      });
      toast.success(`${editing} saved`);
      setEditing(null);
      setFormData({});
      load();
    } catch (e: any) {
      toast.error(`Save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (provider: string, enabled: boolean) => {
    try {
      await api.post(`/admin/integrations/${provider}/toggle`, { enabled });
      toast.success(`${provider} ${enabled ? 'enabled' : 'disabled'}`);
      load();
    } catch (e: any) {
      toast.error(`Toggle failed: ${e.message}`);
    }
  };

  const runTest = async (provider: string) => {
    setTestResults((r) => ({ ...r, [provider]: { ok: false, stage: 'running...' } }));
    try {
      const res = await api.post(`/admin/integrations/${provider}/test`, {});
      setTestResults((r) => ({ ...r, [provider]: res.data }));
      if (res.data.ok) {
        toast.success(`${provider}: ${res.data.stage}`);
      } else {
        toast.error(`${provider} test failed: ${res.data.error || res.data.stage}`);
      }
    } catch (e: any) {
      setTestResults((r) => ({ ...r, [provider]: { ok: false, stage: 'request_error', error: e.message } }));
      toast.error(`Test request failed: ${e.message}`);
    }
  };

  const deleteProvider = async (provider: string) => {
    if (!confirm(`Delete ${provider} credentials? This cannot be undone.`)) return;
    try {
      await api.delete(`/admin/integrations/${provider}`);
      toast.success(`${provider} deleted`);
      load();
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  const unconfigured = known.filter((p) => !providers.find((x) => x.provider === p));

  return (
    <div className="p-6 max-w-5xl mx-auto" data-testid="integrations-page">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-1">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Manage third-party provider credentials. Test mode keys are seeded by default; rotate or switch to live from here.
        </p>
      </div>

      {loading ? (
        <div className="text-center py-10">Loading...</div>
      ) : (
        <>
          {/* Configured providers */}
          <div className="space-y-4 mb-8">
            {providers.map((p) => (
              <div key={p.provider} className="border rounded-lg p-5 bg-card" data-testid={`integration-card-${p.provider}`}>
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold capitalize">{p.provider.replace('_', ' ')}</h2>
                      <span className={`text-xs px-2 py-0.5 rounded ${p.mode === 'live' ? 'bg-red-100 text-red-800' : 'bg-blue-100 text-blue-800'}`}>
                        {p.mode.toUpperCase()}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded ${p.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                        {p.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </div>
                    {p.updated_at && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Updated {new Date(p.updated_at).toLocaleString()} by {p.updated_by || '—'}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => runTest(p.provider)} className="text-sm px-3 py-1 border rounded hover:bg-muted" data-testid={`test-${p.provider}-btn`}>
                      Test
                    </button>
                    <button onClick={() => toggleEnabled(p.provider, !p.enabled)} className="text-sm px-3 py-1 border rounded hover:bg-muted" data-testid={`toggle-${p.provider}-btn`}>
                      {p.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => startEdit(p.provider)} className="text-sm px-3 py-1 border rounded bg-primary text-primary-foreground hover:bg-primary/90" data-testid={`edit-${p.provider}-btn`}>
                      Edit
                    </button>
                    <button onClick={() => deleteProvider(p.provider)} className="text-sm px-3 py-1 border rounded text-red-700 hover:bg-red-50" data-testid={`delete-${p.provider}-btn`}>
                      Delete
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
                  {Object.entries(p.payload).map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <span className="text-muted-foreground min-w-[140px]">{k}:</span>
                      <code className="text-xs break-all">{v || '—'}</code>
                    </div>
                  ))}
                </div>

                {testResults[p.provider] && (
                  <div className={`mt-3 p-2 rounded text-sm ${testResults[p.provider].ok ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`} data-testid={`test-result-${p.provider}`}>
                    <strong>{testResults[p.provider].ok ? '✅' : '❌'} {testResults[p.provider].stage}</strong>
                    {testResults[p.provider].error && <div className="text-xs mt-1">{testResults[p.provider].error}</div>}
                    {testResults[p.provider].livemode !== undefined && (
                      <div className="text-xs mt-1">
                        livemode: {String(testResults[p.provider].livemode)}
                        {testResults[p.provider].available_currencies && ` · currencies: ${testResults[p.provider].available_currencies?.join(', ')}`}
                      </div>
                    )}
                    {testResults[p.provider].note && <div className="text-xs mt-1 italic">{testResults[p.provider].note}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add new */}
          {unconfigured.length > 0 && (
            <div className="border-t pt-6">
              <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Add new integration</h2>
              <div className="flex flex-wrap gap-2">
                {unconfigured.map((p) => (
                  <button
                    key={p}
                    onClick={() => startEdit(p)}
                    className="text-sm px-3 py-1.5 border rounded bg-card hover:bg-muted"
                    data-testid={`add-${p}-btn`}
                  >
                    + {p.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Edit modal */}
          {editing && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" data-testid="integration-edit-modal">
              <div className="bg-card border rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto">
                <h2 className="text-xl font-bold mb-4 capitalize">{editing.replace('_', ' ')} configuration</h2>

                <div className="space-y-3">
                  {Object.entries(formData).map(([k, v]) => (
                    <div key={k}>
                      <label className="block text-sm font-medium mb-1">{k}</label>
                      {SECRET_FIELDS.has(k) ? (
                        <input
                          type="password"
                          value={v}
                          onChange={(e) => setFormData({ ...formData, [k]: e.target.value })}
                          placeholder={`Enter ${k} (leave blank to keep existing)`}
                          className="w-full px-3 py-2 border rounded text-sm font-mono"
                          data-testid={`field-${editing}-${k}`}
                        />
                      ) : k === 'service_account_json' ? (
                        <textarea
                          value={v}
                          onChange={(e) => setFormData({ ...formData, [k]: e.target.value })}
                          placeholder="Paste service account JSON"
                          className="w-full px-3 py-2 border rounded text-sm font-mono"
                          rows={6}
                          data-testid={`field-${editing}-${k}`}
                        />
                      ) : (
                        <input
                          type="text"
                          value={v}
                          onChange={(e) => setFormData({ ...formData, [k]: e.target.value })}
                          placeholder={k}
                          className="w-full px-3 py-2 border rounded text-sm font-mono"
                          data-testid={`field-${editing}-${k}`}
                        />
                      )}
                    </div>
                  ))}

                  <div className="flex gap-4 pt-2">
                    <label className="flex items-center gap-2 text-sm">
                      <span>Mode:</span>
                      <select
                        value={formMode}
                        onChange={(e) => setFormMode(e.target.value as 'test' | 'live')}
                        className="border rounded px-2 py-1"
                        data-testid={`field-${editing}-mode`}
                      >
                        <option value="test">test</option>
                        <option value="live">live</option>
                      </select>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={formEnabled}
                        onChange={(e) => setFormEnabled(e.target.checked)}
                        data-testid={`field-${editing}-enabled`}
                      />
                      Enabled
                    </label>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-6">
                  <button
                    onClick={() => { setEditing(null); setFormData({}); }}
                    className="px-4 py-2 border rounded hover:bg-muted"
                    data-testid="integration-cancel-btn"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveProvider}
                    disabled={saving}
                    className="px-4 py-2 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    data-testid="integration-save-btn"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default IntegrationsPage;
