import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';
import { useAuthStore } from '../../stores/authStore';

// ─── Berlin Provider Onboarding v1 (Sprint B-PO) ────────────────────────
// 3 screens: Landing → Form (single page, 3 blocks) → Confirmation
// All copy in German. Defaults preselected — provider can hit "Jetzt starten"
// and reach a working dashboard with bids placed in <60s.

type Screen = 'landing' | 'form' | 'done';
type Strategy = 'conservative' | 'balanced' | 'aggressive';

interface FormState {
  email: string;
  password: string;
  name: string;
  phone: string;
  clusters: string[];
  profile: {
    tuvVerified: boolean;
    yearsExperience: number;
    brands: string[];
    cities: string[];
  };
  autoMoney: {
    enabled: boolean;
    targetRank: number;
    maxBid: number;
    dailyBudget: number;
    strategy: Strategy;
  };
}

const BRAND_CHIPS = ['BMW', 'Audi', 'Mercedes-Benz', 'VW', 'Opel', 'Ford', 'Skoda', 'Porsche'];
const EXPERIENCE_OPTIONS = [3, 5, 10, 15, 20];

const initialState: FormState = {
  email: '',
  password: '',
  name: '',
  phone: '',
  clusters: ['inspection'],
  profile: {
    tuvVerified: false,
    yearsExperience: 10,
    brands: ['BMW', 'Audi'],
    cities: ['Berlin'],
  },
  autoMoney: {
    enabled: true,
    targetRank: 2,
    maxBid: 30,
    dailyBudget: 300,
    strategy: 'balanced',
  },
};

// ── Visual primitives (inline to avoid coupling new screen to existing UI lib) ──
const cardH3: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  margin: '0 0 16px',
  color: '#fff',
};
const card: React.CSSProperties = {
  background: '#0f1218',
  border: '1px solid #1f2632',
  borderRadius: 16,
  padding: 24,
};
const label: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: '#9aa3b2',
  marginBottom: 6,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
};
const input: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  background: '#171b24',
  border: '1px solid #232a37',
  borderRadius: 10,
  color: '#fff',
  fontSize: 15,
  outline: 'none',
  boxSizing: 'border-box',
};
const chip = (active: boolean): React.CSSProperties => ({
  padding: '8px 14px',
  borderRadius: 999,
  border: `1px solid ${active ? '#facc15' : '#2a3140'}`,
  background: active ? 'rgba(250,204,21,0.12)' : 'transparent',
  color: active ? '#facc15' : '#cbd2e0',
  fontSize: 13,
  cursor: 'pointer',
  userSelect: 'none',
});
const radioOption = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '12px 14px',
  textAlign: 'center',
  borderRadius: 10,
  border: `1px solid ${active ? '#facc15' : '#2a3140'}`,
  background: active ? 'rgba(250,204,21,0.10)' : '#171b24',
  color: active ? '#facc15' : '#cbd2e0',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  userSelect: 'none',
});
const ctaPrimary: React.CSSProperties = {
  width: '100%',
  padding: '16px 20px',
  background: '#facc15',
  color: '#0a0d12',
  border: 'none',
  borderRadius: 12,
  fontSize: 17,
  fontWeight: 700,
  cursor: 'pointer',
  letterSpacing: 0.2,
};

export default function ProviderOnboarding() {
  const nav = useNavigate();
  const setAuth = useAuthStore((s) => s as any); // direct setter access below
  const [screen, setScreen] = useState<Screen>('landing');
  const [data, setData] = useState<FormState>(initialState);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setData((d) => ({ ...d, [k]: v }));
  const setProfile = (patch: Partial<FormState['profile']>) =>
    setData((d) => ({ ...d, profile: { ...d.profile, ...patch } }));
  const setAutoMoney = (patch: Partial<FormState['autoMoney']>) =>
    setData((d) => ({ ...d, autoMoney: { ...d.autoMoney, ...patch } }));

  const toggleBrand = (b: string) =>
    setProfile({
      brands: data.profile.brands.includes(b)
        ? data.profile.brands.filter((x) => x !== b)
        : [...data.profile.brands, b],
    });
  const toggleCluster = (c: string) =>
    set('clusters',
      data.clusters.includes(c) ? data.clusters.filter((x) => x !== c) : [...data.clusters, c]);

  const submit = async () => {
    setError(null);
    if (!data.email || !data.password) {
      setError('E-Mail und Passwort sind erforderlich.');
      return;
    }
    if (data.password.length < 6) {
      setError('Passwort muss mindestens 6 Zeichen haben.');
      return;
    }
    if (data.clusters.length === 0) {
      setError('Bitte wählen Sie mindestens einen Service aus.');
      return;
    }
    setSubmitting(true);
    try {
      const { data: r } = await api.post('/provider/onboarding', data);
      // Persist JWT + user the same way authStore does
      localStorage.setItem('token', r.accessToken);
      localStorage.setItem('user', JSON.stringify(r.user));
      // Force store update so ProtectedRoute sees us
      try { (setAuth as any).setState?.({ user: r.user, token: r.accessToken }); } catch {}
      setResult(r);
      setScreen('done');
    } catch (e: any) {
      const code = e?.response?.status;
      const msg = e?.response?.data?.detail || e?.message || 'Fehler bei der Registrierung.';
      setError(code === 409 ? 'Diese E-Mail ist bereits registriert.' : String(msg));
    } finally {
      setSubmitting(false);
    }
  };

  // ─── SCREEN 1: Landing ────────────────────────────────────────────────
  if (screen === 'landing') {
    return (
      <div data-testid="onboarding-landing" style={{ minHeight: '100vh', background: '#0a0d12', color: '#fff' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '64px 20px 80px' }}>
          <div style={{ fontSize: 12, letterSpacing: 2, color: '#facc15', marginBottom: 12 }}>
            ● BERLIN · WERKSTATT-PROGRAMM
          </div>
          <h1 style={{ fontSize: 44, fontWeight: 800, lineHeight: 1.1, margin: '0 0 18px', color: '#fff' }}>
            Verdienen Sie €300–1000<br />pro Auftrag
          </h1>
          <p style={{ fontSize: 18, color: '#cbd2e0', lineHeight: 1.6, margin: '0 0 36px', maxWidth: 580 }}>
            Kunden suchen täglich Auto-Checks auf mobile.de — wir bringen sie direkt zu Ihnen.
            Keine Kaltakquise, keine Vermittlungsgebühren.
          </p>

          <button
            data-testid="onboarding-cta-start"
            onClick={() => setScreen('form')}
            style={ctaPrimary}
          >
            Jetzt starten →
          </button>

          <div style={{ marginTop: 32, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {[
              { t: 'TÜV-geprüft', s: 'Plattform' },
              { t: 'Keine Fixkosten', s: 'Pay-per-Lead' },
              { t: '< 24h', s: 'Erste Kunden' },
            ].map((it) => (
              <div key={it.t} style={{ ...card, padding: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#facc15' }}>✓ {it.t}</div>
                <div style={{ fontSize: 12, color: '#7a8294', marginTop: 4 }}>{it.s}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 48, fontSize: 13, color: '#6b7383', textAlign: 'center' }}>
            Bereits registriert? <a href="/api/web-app/login" style={{ color: '#facc15' }}>Anmelden</a>
          </div>
        </div>
      </div>
    );
  }

  // ─── SCREEN 2: Form (3 blocks on one page) ────────────────────────────
  if (screen === 'form') {
    return (
      <div data-testid="onboarding-form" style={{ minHeight: '100vh', background: '#0a0d12', color: '#fff' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 20px 80px' }}>
          <div style={{ marginBottom: 28, fontSize: 12, color: '#7a8294' }}>
            <span onClick={() => setScreen('landing')} style={{ cursor: 'pointer' }}>← Zurück</span>
          </div>

          {/* Account */}
          <div style={{ ...card, marginBottom: 16 }}>
            <h3 style={{fontSize: 18, fontWeight: 700, margin: '0 0 16px', color: '#fff' }}>Ihr Account</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Name oder Werkstatt</label>
                <input
                  data-testid="onboarding-name"
                  style={input}
                  placeholder="z.B. KFZ Müller Berlin"
                  value={data.name}
                  onChange={(e) => set('name', e.target.value)}
                />
              </div>
              <div>
                <label style={label}>E-Mail</label>
                <input
                  data-testid="onboarding-email"
                  type="email"
                  style={input}
                  placeholder="meister@werkstatt.de"
                  value={data.email}
                  onChange={(e) => set('email', e.target.value)}
                />
              </div>
              <div>
                <label style={label}>Passwort</label>
                <input
                  data-testid="onboarding-password"
                  type="password"
                  style={input}
                  placeholder="mind. 6 Zeichen"
                  value={data.password}
                  onChange={(e) => set('password', e.target.value)}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={label}>Telefon (optional)</label>
                <input
                  data-testid="onboarding-phone"
                  style={input}
                  placeholder="+49 30 ..."
                  value={data.phone}
                  onChange={(e) => set('phone', e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* Block 1 — Was bieten Sie an? */}
          <div style={{ ...card, marginBottom: 16 }}>
            <h3 style={{fontSize: 18, fontWeight: 700, margin: '0 0 4px', color: '#fff' }}>Was bieten Sie an?</h3>
            <p style={{ fontSize: 13, color: '#7a8294', margin: '0 0 16px' }}>
              Mehrere Services möglich. Inspection ist als Standard aktiv.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { id: 'inspection', t: 'Fahrzeugprüfung', s: 'Pre-Kauf-Inspektion vor Ort · €120–250 / Auftrag', recommended: true },
                { id: 'selection',  t: 'Autokauf-Beratung', s: 'Begleitung beim Kaufprozess · €80–180 / Auftrag' },
                { id: 'delivery',   t: 'Fahrzeugtransport', s: 'Überführung · €150–500 / Auftrag' },
              ].map((c) => {
                const active = data.clusters.includes(c.id);
                return (
                  <div
                    key={c.id}
                    data-testid={`onboarding-cluster-${c.id}`}
                    onClick={() => toggleCluster(c.id)}
                    style={{
                      padding: '14px 16px',
                      borderRadius: 12,
                      border: `1px solid ${active ? '#facc15' : '#2a3140'}`,
                      background: active ? 'rgba(250,204,21,0.08)' : '#171b24',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div style={{
                      width: 22, height: 22, borderRadius: 6,
                      background: active ? '#facc15' : 'transparent',
                      border: `2px solid ${active ? '#facc15' : '#3a4252'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: '#0a0d12', fontWeight: 800, fontSize: 14,
                    }}>{active ? '✓' : ''}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 15 }}>
                        {c.t} {c.recommended && <span style={{ marginLeft: 6, fontSize: 11, color: '#facc15' }}>· empfohlen</span>}
                      </div>
                      <div style={{ fontSize: 12, color: '#7a8294', marginTop: 3 }}>{c.s}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Block 2 — Ihre Erfahrung */}
          <div style={{ ...card, marginBottom: 16 }}>
            <h3 style={{fontSize: 18, fontWeight: 700, margin: '0 0 4px', color: '#fff' }}>Ihre Erfahrung</h3>
            <p style={{ fontSize: 13, color: '#7a8294', margin: '0 0 16px' }}>
              Diese Daten erscheinen auf Ihrem Profil und erhöhen die Conversion.
            </p>

            <div
              data-testid="onboarding-tuv"
              onClick={() => setProfile({ tuvVerified: !data.profile.tuvVerified })}
              style={{
                padding: '12px 14px',
                borderRadius: 10,
                border: `1px solid ${data.profile.tuvVerified ? '#22c55e' : '#2a3140'}`,
                background: data.profile.tuvVerified ? 'rgba(34,197,94,0.10)' : '#171b24',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 14,
              }}
            >
              <span style={{ fontSize: 18 }}>{data.profile.tuvVerified ? '✓' : '○'}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  TÜV-Zertifikat / Sachverständigen-Befähigung
                </div>
                <div style={{ fontSize: 12, color: '#7a8294' }}>
                  Stark vertrauensbildend für Käufer (Trust-Badge auf Ihrem Profil)
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={label}>Erfahrung</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {EXPERIENCE_OPTIONS.map((y) => (
                  <div
                    key={y}
                    data-testid={`onboarding-years-${y}`}
                    onClick={() => setProfile({ yearsExperience: y })}
                    style={chip(data.profile.yearsExperience === y)}
                  >
                    {y}+ Jahre
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label style={label}>Marken-Spezialisierung</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {BRAND_CHIPS.map((b) => (
                  <div
                    key={b}
                    data-testid={`onboarding-brand-${b}`}
                    onClick={() => toggleBrand(b)}
                    style={chip(data.profile.brands.includes(b))}
                  >
                    {b}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Block 3 — Auto-Money */}
          <div style={{ ...card, marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <h3 style={{fontSize: 18, fontWeight: 700, margin: 0, color: '#fff' }}>
                🤖 Automatischer Einnahmenmodus
              </h3>
              <div
                data-testid="onboarding-am-toggle"
                onClick={() => setAutoMoney({ enabled: !data.autoMoney.enabled })}
                style={{
                  width: 46, height: 26, borderRadius: 999,
                  background: data.autoMoney.enabled ? '#facc15' : '#2a3140',
                  position: 'relative', cursor: 'pointer',
                }}
              >
                <div style={{
                  position: 'absolute', top: 3, left: data.autoMoney.enabled ? 23 : 3,
                  width: 20, height: 20, borderRadius: '50%', background: '#0a0d12',
                  transition: 'left 0.15s',
                }} />
              </div>
            </div>
            <p style={{ fontSize: 13, color: '#7a8294', margin: '0 0 18px' }}>
              Wir halten Ihr Profil automatisch in den Top-Positionen für Berlin.
              Kein manuelles Bieten — Sie bekommen einfach Aufträge.
            </p>

            {data.autoMoney.enabled && (
              <>
                <div style={{ marginBottom: 14 }}>
                  <label style={label}>Ziel-Position</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[1, 2, 3].map((r) => (
                      <div
                        key={r}
                        data-testid={`onboarding-rank-${r}`}
                        onClick={() => setAutoMoney({ targetRank: r })}
                        style={radioOption(data.autoMoney.targetRank === r)}
                      >
                        Top {r}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                  <div>
                    <label style={label}>Max. Gebot pro Lead</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        data-testid="onboarding-max-bid"
                        type="number"
                        style={{ ...input, paddingRight: 32 }}
                        value={data.autoMoney.maxBid}
                        onChange={(e) => setAutoMoney({ maxBid: Number(e.target.value) || 0 })}
                      />
                      <span style={{ position: 'absolute', right: 14, top: 12, color: '#7a8294' }}>€</span>
                    </div>
                  </div>
                  <div>
                    <label style={label}>Tagesbudget</label>
                    <div style={{ position: 'relative' }}>
                      <input
                        data-testid="onboarding-daily-budget"
                        type="number"
                        style={{ ...input, paddingRight: 32 }}
                        value={data.autoMoney.dailyBudget}
                        onChange={(e) => setAutoMoney({ dailyBudget: Number(e.target.value) || 0 })}
                      />
                      <span style={{ position: 'absolute', right: 14, top: 12, color: '#7a8294' }}>€</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label style={label}>Strategie</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(['conservative', 'balanced', 'aggressive'] as Strategy[]).map((s) => (
                      <div
                        key={s}
                        data-testid={`onboarding-strategy-${s}`}
                        onClick={() => setAutoMoney({ strategy: s })}
                        style={radioOption(data.autoMoney.strategy === s)}
                      >
                        {s === 'conservative' ? 'Konservativ' : s === 'balanced' ? 'Ausgewogen' : 'Aggressiv'}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {error && (
            <div data-testid="onboarding-error" style={{
              padding: 14, marginBottom: 16,
              background: 'rgba(248,113,113,0.10)', border: '1px solid #7f1d1d',
              borderRadius: 10, color: '#fca5a5', fontSize: 14,
            }}>
              {error}
            </div>
          )}

          <button
            data-testid="onboarding-submit"
            onClick={submit}
            disabled={submitting}
            style={{ ...ctaPrimary, opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
          >
            {submitting ? 'Wird eingerichtet …' : 'Account erstellen & loslegen →'}
          </button>

          <div style={{ marginTop: 12, fontSize: 12, color: '#6b7383', textAlign: 'center' }}>
            Mit dem Klick stimmen Sie den AGB und der Datenschutzerklärung zu.
          </div>
        </div>
      </div>
    );
  }

  // ─── SCREEN 3: Confirmation ───────────────────────────────────────────
  const seededCount = result?.seededBids?.length ?? 0;
  const tickUpdates = result?.autoMoney?.tick?.updates ?? [];
  const placedBids = (Array.isArray(tickUpdates) ? tickUpdates : []).filter((u: any) => u.bid);

  return (
    <div data-testid="onboarding-done" style={{ minHeight: '100vh', background: '#0a0d12', color: '#fff' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '80px 20px 60px' }}>
        <div style={{
          width: 80, height: 80, borderRadius: '50%',
          background: 'rgba(34,197,94,0.15)', border: '2px solid #22c55e',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 40, margin: '0 auto 24px',
        }}>🎯</div>

        <h1 style={{fontSize: 32, fontWeight: 800, textAlign: 'center', margin: '0 0 12px', color: '#fff' }}>
          Sie sind bereit zu verdienen
        </h1>
        <p style={{ fontSize: 16, color: '#cbd2e0', textAlign: 'center', margin: '0 0 28px', lineHeight: 1.6 }}>
          Erste Anfragen werden Ihnen jetzt zugewiesen — Auto-Money platziert
          Ihre Gebote in <strong style={{ color: '#facc15' }}>Berlin Mitte</strong> und
          {' '}<strong style={{ color: '#facc15' }}>Neukölln</strong>.
        </p>

        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#7a8294', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            Initial-Setup
          </div>
          <div style={{ display: 'grid', gap: 10, fontSize: 14 }}>
            <Row label="Provider" value={result?.provider?.name || result?.provider?.slug} />
            <Row label="Services" value={(result?.provider?.clusters || []).join(', ')} />
            <Row label="Auto-Money" value={result?.autoMoney?.enabled ? 'Aktiv ✓' : 'Inaktiv'} />
            <Row label="Initial-Gebote" value={`${seededCount} Zonen seedet${placedBids.length ? ` · ${placedBids.length} live` : ''}`} />
            {placedBids.map((u: any, i: number) => (
              <div key={i} style={{ fontSize: 12, color: '#facc15', paddingLeft: 12 }}>
                · {u.zone} · {u.cluster} · €{u.bid}
              </div>
            ))}
          </div>
        </div>

        <button
          data-testid="onboarding-go-dashboard"
          onClick={() => nav('/provider')}
          style={ctaPrimary}
        >
          Zum Dashboard →
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ color: '#7a8294' }}>{label}</span>
      <span style={{ color: '#fff', fontWeight: 600 }}>{value || '—'}</span>
    </div>
  );
}
