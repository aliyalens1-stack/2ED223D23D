/** /inspector/security — change password, sessions, email/phone, 2FA placeholder. */
import { useEffect, useState } from 'react';
import { ShieldCheck, Lock, EnvelopeSimple, Phone, Monitor, Key } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, Field, TextInput, PrimaryButton, Spinner, ErrorBlock, Pill } from '../../components/inspector/cabinet/CabinetUI';

interface Sec {
  emailStatus: { address: string | null; verified: boolean };
  phoneStatus: { phone: string | null; verified: boolean };
  passwordUpdatedAt: string | null;
  twoFactor: { enabled: boolean; available: boolean; note: string };
  recovery: { methods: unknown[]; note: string };
  sessions: { id: string; userAgent: string | null; ip: string | null; createdAt: string | null; lastSeenAt: string | null; current: boolean }[];
}

export default function InspectorSecurityPage() {
  const [d, setD] = useState<Sec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [pwOk, setPwOk] = useState<string | null>(null);
  const [pwErr, setPwErr] = useState<string | null>(null);

  const load = () => inspectorAPI.getSecurity().then(r => { setD(r.data); setLoading(false); }).catch(e => { setError(e?.message ?? 'fail'); setLoading(false); });
  useEffect(() => { load(); }, []);

  const submitChange = async () => {
    setPwErr(null); setPwOk(null);
    if (!cur || !next) { setPwErr('Заполни оба поля'); return; }
    if (next.length < 8) { setPwErr('Новый пароль минимум 8 символов'); return; }
    if (next !== confirm) { setPwErr('Подтверждение не совпадает'); return; }
    setSaving(true);
    try {
      await inspectorAPI.changePassword(cur, next);
      setPwOk('Пароль обновлён');
      setCur(''); setNext(''); setConfirm('');
      load();
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } }; message?: string };
      setPwErr(err?.response?.data?.message ?? err?.message ?? 'ошибка смены пароля');
    } finally { setSaving(false); }
  };

  if (loading) return <Spinner testId="sec-loading" />;
  if (!d) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader title="Безопасность" subtitle="Управление паролем, сессиями и контактами" testId="page-header-security" />

      <Section title="Email">
        <Card className="px-5 py-4 flex items-center gap-3" testId="sec-email">
          <EnvelopeSimple size={18} className="text-zinc-400" />
          <div className="flex-1">
            <div className="text-sm font-semibold">{d.emailStatus.address ?? '—'}</div>
            <div className="text-[11px] text-zinc-500">Email используется для входа</div>
          </div>
          <Pill tone={d.emailStatus.verified ? 'success' : 'warning'}>{d.emailStatus.verified ? 'verified' : 'not verified'}</Pill>
        </Card>
      </Section>

      <Section title="Телефон">
        <Card className="px-5 py-4 flex items-center gap-3" testId="sec-phone">
          <Phone size={18} className="text-zinc-400" />
          <div className="flex-1">
            <div className="text-sm font-semibold">{d.phoneStatus.phone ?? 'не указан'}</div>
            <div className="text-[11px] text-zinc-500">Используется для контакта с клиентом во время выезда</div>
          </div>
          <Pill tone={d.phoneStatus.verified ? 'success' : 'neutral'}>{d.phoneStatus.verified ? 'verified' : 'not verified'}</Pill>
        </Card>
      </Section>

      <Section title="Пароль" subtitle={d.passwordUpdatedAt ? `Обновлён: ${new Date(d.passwordUpdatedAt).toLocaleString()}` : ''}>
        <Card className="p-5 space-y-3" testId="sec-password">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Текущий пароль"><TextInput type="password" value={cur} onChange={e => setCur(e.target.value)} data-testid="sec-pw-current" /></Field>
            <Field label="Новый пароль" hint="Минимум 8 символов"><TextInput type="password" value={next} onChange={e => setNext(e.target.value)} data-testid="sec-pw-next" /></Field>
            <Field label="Подтверждение"><TextInput type="password" value={confirm} onChange={e => setConfirm(e.target.value)} data-testid="sec-pw-confirm" /></Field>
          </div>
          {pwErr && <div className="text-xs text-rose-600 flex items-center gap-1"><Lock size={12} /> {pwErr}</div>}
          {pwOk && <div className="text-xs text-emerald-600 flex items-center gap-1"><ShieldCheck size={12} weight="fill" /> {pwOk}</div>}
          <div>
            <PrimaryButton onClick={submitChange} disabled={saving} data-testid="sec-pw-submit">{saving ? 'Меняю...' : 'Сменить пароль'}</PrimaryButton>
          </div>
        </Card>
      </Section>

      <Section title="Активные сессии">
        <Card testId="sec-sessions">
          <ul>
            {d.sessions.map(s => (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3 border-b border-zinc-100 last:border-0" data-testid={`session-${s.id}`}>
                <Monitor size={16} className="text-zinc-400" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">{s.userAgent ?? 'Unknown agent'}</div>
                  <div className="text-[11px] text-zinc-500 truncate">{s.ip ?? ''}{s.lastSeenAt ? ` · ${new Date(s.lastSeenAt).toLocaleString()}` : ''}</div>
                </div>
                {s.current && <Pill tone="success">текущая</Pill>}
              </li>
            ))}
          </ul>
        </Card>
      </Section>

      <Section title="Двухфакторная аутентификация">
        <Card className="px-5 py-4 flex items-center gap-3 opacity-70" testId="sec-2fa">
          <Key size={18} className="text-zinc-400" />
          <div className="flex-1">
            <div className="text-sm font-semibold">2FA</div>
            <div className="text-[11px] text-zinc-500">{d.twoFactor.note}</div>
          </div>
          <Pill tone="neutral">скоро</Pill>
        </Card>
      </Section>

      <Section title="Восстановление">
        <Card className="px-5 py-4 flex items-center gap-3 opacity-70" testId="sec-recovery">
          <Key size={18} className="text-zinc-400" />
          <div className="flex-1">
            <div className="text-sm font-semibold">Методы восстановления</div>
            <div className="text-[11px] text-zinc-500">{d.recovery.note}</div>
          </div>
          <Pill tone="neutral">скоро</Pill>
        </Card>
      </Section>
    </PageContainer>
  );
}
