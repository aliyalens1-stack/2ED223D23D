/**
 * StripeSettingsPage — Master Admin runtime configuration for Stripe.
 *
 * Sections:
 *  1. API Keys      — secret_key / publishable_key / webhook_secret (with show/hide + test-key validation)
 *  2. Currency      — dropdown of all Stripe-supported currencies
 *  3. Payment Methods — checkboxes for card / klarna / paypal / sepa / crypto / etc, grouped by category
 *  4. Advanced      — automatic_payment_methods / capture_method / promo codes / billing collection
 *
 * All changes are saved to MongoDB collection `stripe_settings` (single doc id="global").
 * Backend `app/payments/router.py` uses these values at runtime via `get_active_config()`.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  CreditCard, Save, RefreshCw, CheckCircle, AlertTriangle, Eye, EyeOff,
  Globe, Wallet, Building2, ArrowLeftRight, CalendarClock, Bitcoin,
  Key, ShieldCheck, Zap, Landmark, Settings as SettingsIcon, ExternalLink,
} from 'lucide-react';
import {
  stripeAdminAPI,
  type StripeConfig,
  type StripePaymentMethod,
  type StripeCurrency,
} from '../services/api';

const CATEGORY_META: Record<StripePaymentMethod['category'], { label: string; icon: any; color: string }> = {
  global:   { label: 'Cards & Wallets',   icon: CreditCard,    color: 'text-blue-400' },
  wallet:   { label: 'Digital Wallets',   icon: Wallet,        color: 'text-purple-400' },
  bank:     { label: 'Bank Debits',       icon: Building2,     color: 'text-emerald-400' },
  redirect: { label: 'European Banks',    icon: ArrowLeftRight, color: 'text-cyan-400' },
  bnpl:     { label: 'Buy Now, Pay Later', icon: CalendarClock, color: 'text-amber-400' },
  crypto:   { label: 'Cryptocurrency',    icon: Bitcoin,       color: 'text-orange-400' },
};

export default function StripeSettingsPage() {
  const [cfg, setCfg] = useState<StripeConfig | null>(null);
  const [pms, setPms] = useState<StripePaymentMethod[]>([]);
  const [currencies, setCurrencies] = useState<StripeCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedTimestamp, setSavedTimestamp] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // form state
  const [secretKey, setSecretKey] = useState('');
  const [publishableKey, setPublishableKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [showWebhook, setShowWebhook] = useState(false);
  const [currency, setCurrency] = useState('eur');
  const [enabledMethods, setEnabledMethods] = useState<Set<string>>(new Set(['card']));
  const [mode, setMode] = useState<'test' | 'live'>('test');
  const [autoPm, setAutoPm] = useState(true);
  const [captureMethod, setCaptureMethod] = useState<'automatic' | 'manual'>('automatic');
  const [promoCodes, setPromoCodes] = useState(false);
  const [billingCollection, setBillingCollection] = useState<'auto' | 'required'>('auto');

  // test-key UI
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; mode?: string; accountId?: string | null; country?: string | null; error?: string } | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, pmRes, curRes] = await Promise.all([
        stripeAdminAPI.getConfig(),
        stripeAdminAPI.listPaymentMethods(),
        stripeAdminAPI.listCurrencies(),
      ]);
      const c = cfgRes.data;
      setCfg(c);
      setPms(pmRes.data.paymentMethods);
      setCurrencies(curRes.data.currencies);

      setPublishableKey(c.publishableKey || '');
      setCurrency(c.currency);
      setEnabledMethods(new Set(c.paymentMethods));
      setMode(c.mode);
      setAutoPm(c.automaticPaymentMethods);
      setCaptureMethod(c.captureMethod);
      setPromoCodes(c.allowPromotionCodes);
      setBillingCollection(c.billingAddressCollection);
      // Don't pre-fill secret/webhook for security — user types only when changing
      setSecretKey('');
      setWebhookSecret('');
    } catch (e: any) {
      setError(e?.message || 'Failed to load Stripe settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const grouped = useMemo(() => {
    const map: Record<string, StripePaymentMethod[]> = {};
    pms.forEach((m) => {
      (map[m.category] ||= []).push(m);
    });
    return map;
  }, [pms]);

  const toggleMethod = (code: string) => {
    setEnabledMethods((prev) => {
      const next = new Set(prev);
      if (next.has(code)) {
        if (next.size === 1) return prev; // require at least 1 enabled
        next.delete(code);
      } else {
        next.add(code);
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: any = {
        currency,
        paymentMethods: Array.from(enabledMethods),
        mode,
        automaticPaymentMethods: autoPm,
        captureMethod,
        allowPromotionCodes: promoCodes,
        billingAddressCollection: billingCollection,
      };
      // Only include keys if user actually typed something (empty = no change)
      if (secretKey.trim()) patch.secretKey = secretKey.trim();
      if (publishableKey.trim() !== (cfg?.publishableKey || '')) patch.publishableKey = publishableKey.trim();
      if (webhookSecret.trim()) patch.webhookSecret = webhookSecret.trim();

      const res = await stripeAdminAPI.updateConfig(patch);
      setCfg(res.data);
      setSecretKey('');
      setWebhookSecret('');
      setSavedTimestamp(Date.now());
      setTimeout(() => setSavedTimestamp(null), 3500);
    } catch (e: any) {
      setError(e?.message || 'Failed to save Stripe settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTestKey = async () => {
    if (!secretKey.trim()) {
      setError('Enter a secret key first to test it');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await stripeAdminAPI.testKey(secretKey.trim());
      setTestResult({
        ok: true,
        mode: res.data.mode,
        accountId: res.data.accountId,
        country: res.data.country,
      });
    } catch (e: any) {
      setTestResult({ ok: false, error: e?.message || 'Validation failed' });
    } finally {
      setTesting(false);
    }
  };

  if (loading) {
    return (
      <div className="p-6" data-testid="stripe-settings-loading">
        <div className="bg-slate-800 rounded-xl border border-slate-700 p-12 text-center text-slate-400">
          <RefreshCw size={32} className="mx-auto mb-3 animate-spin" />
          Loading Stripe settings...
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="stripe-settings-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-gradient-to-br from-indigo-600/20 to-purple-600/20 rounded-xl border border-indigo-500/30">
            <CreditCard size={28} className="text-indigo-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Stripe Settings</h1>
            <p className="text-slate-400 text-sm">Manage payment processing — keys, currencies, methods</p>
          </div>
          {cfg && (
            <span
              className={`ml-4 px-3 py-1 rounded-full text-xs font-bold uppercase ${
                cfg.mode === 'live'
                  ? 'bg-red-500/20 text-red-300 border border-red-500/40'
                  : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
              }`}
              data-testid="stripe-mode-badge"
            >
              {cfg.mode}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="p-2 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition"
            data-testid="stripe-refresh-btn"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg font-semibold disabled:opacity-50 transition shadow-lg shadow-indigo-500/20"
            data-testid="stripe-save-btn"
          >
            {saving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
            Save All Changes
          </button>
        </div>
      </div>

      {/* Status banners */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 flex items-start gap-3" data-testid="stripe-error">
          <AlertTriangle size={20} className="text-red-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-red-200 font-semibold">Error</p>
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        </div>
      )}
      {savedTimestamp && (
        <div className="bg-emerald-500/10 border border-emerald-500/40 rounded-xl p-4 flex items-center gap-3" data-testid="stripe-saved">
          <CheckCircle size={20} className="text-emerald-400" />
          <p className="text-emerald-200 font-semibold">Settings saved successfully — applies immediately to next checkout</p>
        </div>
      )}

      {/* Section 1: API Keys */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden" data-testid="stripe-keys-section">
        <div className="p-4 border-b border-slate-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Key size={20} className="text-indigo-400" />
            <div>
              <h2 className="text-lg font-semibold text-white">API Keys</h2>
              <p className="text-xs text-slate-400">Get them from Stripe Dashboard → Developers → API keys</p>
            </div>
          </div>
          <a
            href="https://dashboard.stripe.com/apikeys"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-indigo-300 hover:text-indigo-200"
          >
            Open Stripe Dashboard <ExternalLink size={12} />
          </a>
        </div>
        <div className="p-5 space-y-5">

          {/* Secret Key */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                Secret Key
                <span className="text-xs font-normal text-slate-400">(sk_test_… or sk_live_…)</span>
              </label>
              {cfg?.secretKeyIsSet && !secretKey && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle size={12} /> Currently set: {cfg.secretKeyMasked} <span className="text-slate-500">({cfg.source.secretKey})</span>
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder={cfg?.secretKeyIsSet ? 'Leave empty to keep current value' : 'sk_test_...'}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-4 pr-10 py-2.5 text-white font-mono text-sm focus:border-indigo-500 outline-none"
                  data-testid="stripe-secret-key-input"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-white"
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
              <button
                onClick={handleTestKey}
                disabled={testing || !secretKey.trim()}
                className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 rounded-lg font-medium flex items-center gap-2 transition"
                data-testid="stripe-test-key-btn"
              >
                {testing ? <RefreshCw size={16} className="animate-spin" /> : <Zap size={16} />}
                Test Key
              </button>
            </div>
            {testResult && (
              <div
                className={`text-xs rounded-lg p-3 ${
                  testResult.ok
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/10 border border-red-500/30 text-red-300'
                }`}
                data-testid="stripe-test-result"
              >
                {testResult.ok ? (
                  <span>
                    ✔ Key is valid · mode={testResult.mode} · account={testResult.accountId} · country={testResult.country}
                  </span>
                ) : (
                  <span>✖ {testResult.error}</span>
                )}
              </div>
            )}
          </div>

          {/* Publishable Key */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              Publishable Key
              <span className="text-xs font-normal text-slate-400">(pk_test_… or pk_live_…) · safe to expose to frontend</span>
            </label>
            <input
              type="text"
              value={publishableKey}
              onChange={(e) => setPublishableKey(e.target.value)}
              placeholder="pk_test_..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-white font-mono text-sm focus:border-indigo-500 outline-none"
              data-testid="stripe-publishable-key-input"
            />
          </div>

          {/* Webhook Secret */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                Webhook Secret
                <span className="text-xs font-normal text-slate-400">(whsec_…) · from Stripe → Webhooks → Endpoint</span>
              </label>
              {cfg?.webhookSecretIsSet && !webhookSecret && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle size={12} /> Set: {cfg.webhookSecretMasked}
                </span>
              )}
              {!cfg?.webhookSecretIsSet && (
                <span className="text-xs text-amber-400 flex items-center gap-1">
                  <AlertTriangle size={12} /> Not set — webhook validation disabled
                </span>
              )}
            </div>
            <div className="relative">
              <input
                type={showWebhook ? 'text' : 'password'}
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                placeholder={cfg?.webhookSecretIsSet ? 'Leave empty to keep current value' : 'whsec_...'}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-4 pr-10 py-2.5 text-white font-mono text-sm focus:border-indigo-500 outline-none"
                data-testid="stripe-webhook-secret-input"
              />
              <button
                type="button"
                onClick={() => setShowWebhook((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-slate-400 hover:text-white"
              >
                {showWebhook ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Section 2: Currency */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden" data-testid="stripe-currency-section">
        <div className="p-4 border-b border-slate-700 flex items-center gap-3">
          <Globe size={20} className="text-emerald-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Default Currency</h2>
            <p className="text-xs text-slate-400">Currency for all checkouts (per-payment override possible later)</p>
          </div>
        </div>
        <div className="p-5">
          <select
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            className="w-full md:w-80 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:border-emerald-500 outline-none cursor-pointer"
            data-testid="stripe-currency-select"
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.symbol} {c.code.toUpperCase()} — {c.name} {c.zero_decimal ? '· (zero-decimal)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Section 3: Payment Methods */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden" data-testid="stripe-methods-section">
        <div className="p-4 border-b border-slate-700 flex items-center gap-3">
          <Landmark size={20} className="text-purple-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Payment Methods</h2>
            <p className="text-xs text-slate-400">
              Enable methods for Checkout — users will see only checked options · {enabledMethods.size} enabled
            </p>
          </div>
        </div>
        <div className="p-5 space-y-5">
          {Object.entries(grouped).map(([cat, methods]) => {
            const meta = CATEGORY_META[cat as StripePaymentMethod['category']];
            const Icon = meta.icon;
            return (
              <div key={cat} data-testid={`pm-category-${cat}`}>
                <div className="flex items-center gap-2 mb-3">
                  <Icon size={16} className={meta.color} />
                  <h3 className="text-sm font-bold uppercase tracking-wide text-slate-300">{meta.label}</h3>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                  {methods.map((m) => {
                    const checked = enabledMethods.has(m.code);
                    return (
                      <label
                        key={m.code}
                        className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition ${
                          checked
                            ? 'bg-indigo-500/10 border-indigo-500/40 text-white'
                            : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                        }`}
                        data-testid={`pm-toggle-${m.code}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMethod(m.code)}
                          className="w-4 h-4 accent-indigo-500"
                        />
                        <div className="flex-1">
                          <div className="text-sm font-semibold flex items-center gap-2">
                            {m.name}
                            {m.auto_with_card && (
                              <span className="text-[10px] font-normal text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">auto</span>
                            )}
                          </div>
                          <div className="text-[10px] text-slate-500 font-mono">{m.code}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="text-xs text-slate-500 bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
            <strong className="text-slate-400">Note:</strong> Some methods (e.g. <code className="text-amber-400">klarna</code>,{' '}
            <code className="text-amber-400">crypto</code>) must also be enabled in your Stripe Dashboard → Settings → Payment Methods. If
            Stripe rejects a method (e.g. not enabled on your account), Checkout will gracefully fall back to <code>card</code>.
          </div>
        </div>
      </div>

      {/* Section 4: Advanced */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden" data-testid="stripe-advanced-section">
        <div className="p-4 border-b border-slate-700 flex items-center gap-3">
          <SettingsIcon size={20} className="text-cyan-400" />
          <div>
            <h2 className="text-lg font-semibold text-white">Advanced</h2>
            <p className="text-xs text-slate-400">Mode, capture, billing collection, promo codes</p>
          </div>
        </div>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Mode */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200">Stripe Mode</label>
            <div className="flex gap-2">
              {(['test', 'live'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`flex-1 px-4 py-2.5 rounded-lg font-bold uppercase text-xs transition ${
                    mode === m
                      ? m === 'live'
                        ? 'bg-red-500/20 border border-red-500/50 text-red-300'
                        : 'bg-amber-500/20 border border-amber-500/50 text-amber-300'
                      : 'bg-slate-900 border border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                  data-testid={`stripe-mode-${m}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          {/* Capture */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200">Capture Method</label>
            <select
              value={captureMethod}
              onChange={(e) => setCaptureMethod(e.target.value as 'automatic' | 'manual')}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-white"
              data-testid="stripe-capture-method"
            >
              <option value="automatic">Automatic (charge on confirm)</option>
              <option value="manual">Manual (authorize, capture later)</option>
            </select>
          </div>

          {/* Billing collection */}
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-200">Billing Address</label>
            <select
              value={billingCollection}
              onChange={(e) => setBillingCollection(e.target.value as 'auto' | 'required')}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-white"
              data-testid="stripe-billing-collection"
            >
              <option value="auto">Auto (Stripe decides)</option>
              <option value="required">Always required</option>
            </select>
          </div>

          {/* Auto PM */}
          <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-lg p-4">
            <div>
              <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <ShieldCheck size={16} className="text-emerald-400" />
                Automatic Payment Methods
              </div>
              <div className="text-xs text-slate-500 mt-1">Let Stripe decide locale-best methods automatically</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer" data-testid="stripe-auto-pm">
              <input type="checkbox" checked={autoPm} onChange={(e) => setAutoPm(e.target.checked)} className="sr-only peer" />
              <div className="w-11 h-6 bg-slate-700 peer-checked:bg-emerald-500 rounded-full transition relative">
                <div className={`absolute top-0.5 left-0.5 bg-white w-5 h-5 rounded-full transition ${autoPm ? 'translate-x-5' : ''}`} />
              </div>
            </label>
          </div>

          {/* Promo codes */}
          <div className="flex items-center justify-between bg-slate-900 border border-slate-700 rounded-lg p-4 md:col-span-2">
            <div>
              <div className="text-sm font-semibold text-slate-200">Allow Promotion Codes</div>
              <div className="text-xs text-slate-500 mt-1">Show "Add promo code" field in Checkout</div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer" data-testid="stripe-promo-codes">
              <input
                type="checkbox"
                checked={promoCodes}
                onChange={(e) => setPromoCodes(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-slate-700 peer-checked:bg-indigo-500 rounded-full transition relative">
                <div className={`absolute top-0.5 left-0.5 bg-white w-5 h-5 rounded-full transition ${promoCodes ? 'translate-x-5' : ''}`} />
              </div>
            </label>
          </div>
        </div>
      </div>

      {/* Footer save */}
      <div className="flex items-center justify-between bg-slate-800/50 border border-slate-700 rounded-xl p-4">
        <div className="text-xs text-slate-400">
          {cfg?.updatedAt ? (
            <>
              Last updated:{' '}
              <span className="text-slate-300 font-mono">{new Date(cfg.updatedAt).toLocaleString()}</span>
              {cfg.updatedBy && <> by <span className="text-slate-300">{cfg.updatedBy}</span></>}
            </>
          ) : (
            <>Settings have never been customised — using ENV fallback values</>
          )}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg font-semibold disabled:opacity-50 transition shadow-lg shadow-indigo-500/20"
          data-testid="stripe-save-btn-footer"
        >
          {saving ? <RefreshCw size={18} className="animate-spin" /> : <Save size={18} />}
          Save All Changes
        </button>
      </div>
    </div>
  );
}
