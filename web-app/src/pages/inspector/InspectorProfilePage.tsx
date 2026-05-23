/** /inspector/profile — Editable operating identity. */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Camera, FloppyDisk, ArrowsClockwise } from '@phosphor-icons/react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, Field, TextInput, TextArea, PrimaryButton, GhostButton, Spinner, ErrorBlock, Pill } from '../../components/inspector/cabinet/CabinetUI';

interface Identity { id: string; displayName: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null; city: string | null; role: string; joinedAt: string | null; avatar: string | null; language: string }
interface Trust { verified: boolean; status: string; ratingAvg: number; completedTotal: number }
interface Capability { brands: string[]; languages: string[]; tools: string[] }
interface ProfilePayload { identity: Identity; trust: Trust; capability: Capability; availability: { workingRadiusKm: number } }

function initialsOf(n: string) {
  return n.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase() ?? '').join('') || 'I';
}

export default function InspectorProfilePage() {
  const { t } = useTranslation();
  const [data, setData] = useState<ProfilePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Editable copy
  const [form, setForm] = useState({
    firstName: '', lastName: '', phone: '', city: '', bio: '',
    languages: '', brands: '', tools: '', workingRadiusKm: 0, avatar: '' as string | null,
  });

  useEffect(() => {
    inspectorAPI.getProfile()
      .then(r => {
        const d = r.data as ProfilePayload & { identity: Identity & { bio?: string } };
        setData(d);
        setForm({
          firstName: d.identity.firstName ?? '',
          lastName: d.identity.lastName ?? '',
          phone: d.identity.phone ?? '',
          city: d.identity.city ?? '',
          bio: (d.identity as { bio?: string }).bio ?? '',
          languages: (d.capability.languages || []).join(', '),
          brands: (d.capability.brands || []).join(', '),
          tools: (d.capability.tools || []).join(', '),
          workingRadiusKm: d.availability?.workingRadiusKm ?? 0,
          avatar: d.identity.avatar,
        });
        setLoading(false);
      })
      .catch(e => { setError(e?.message ?? 'failed'); setLoading(false); });
  }, []);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const patch = {
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone,
        city: form.city,
        bio: form.bio,
        languages: form.languages.split(',').map(s => s.trim()).filter(Boolean),
        brands: form.brands.split(',').map(s => s.trim()).filter(Boolean),
        tools: form.tools.split(',').map(s => s.trim()).filter(Boolean),
        workingRadiusKm: Number(form.workingRadiusKm) || 0,
        avatar: form.avatar || undefined,
      };
      await inspectorAPI.updateProfile(patch);
      setSavedAt(new Date().toISOString());
      // Refresh from server
      const r = await inspectorAPI.getProfile();
      setData(r.data);
    } catch (e: unknown) {
      const err = e as { message?: string };
      setError(err?.message ?? 'save failed');
    } finally {
      setSaving(false);
    }
  };

  const onAvatar = async (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setForm(f => ({ ...f, avatar: reader.result as string }));
    reader.readAsDataURL(file);
  };

  if (loading) return <Spinner testId="profile-loading" />;
  if (error && !data) return <PageContainer><ErrorBlock message={error} /></PageContainer>;
  if (!data) return null;

  const display = `${form.firstName} ${form.lastName}`.trim() || data.identity.displayName;
  const initials = initialsOf(display);

  return (
    <PageContainer>
      <PageHeader
        title={t('inspector.profile.title', { defaultValue: 'Профиль' })}
        subtitle={t('inspector.profile.sub', { defaultValue: 'Редактируй свои данные и operating identity' })}
        testId="page-header-profile"
        actions={
          <>
            {savedAt && <span className="text-xs text-emerald-600">сохранено</span>}
            <GhostButton onClick={() => location.reload()}><ArrowsClockwise size={12} className="inline" /> Сбросить</GhostButton>
            <PrimaryButton onClick={save} disabled={saving} data-testid="profile-save-btn">
              <FloppyDisk size={14} className="inline mr-1" />
              {saving ? 'Сохраняю...' : 'Сохранить'}
            </PrimaryButton>
          </>
        }
      />

      {error && <ErrorBlock message={error} />}

      <Card className="p-6">
        <div className="flex items-start gap-5">
          <div className="relative">
            <div className={`h-20 w-20 rounded-full flex items-center justify-center font-bold text-2xl ${data.trust.verified ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-700'} overflow-hidden`}>
              {form.avatar ? <img src={form.avatar} alt="" className="h-full w-full object-cover" /> : initials}
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="absolute -bottom-1 -right-1 bg-white rounded-full border border-zinc-300 p-1.5 shadow-sm hover:bg-zinc-50"
              data-testid="profile-avatar-upload"
              aria-label="Upload avatar"
            >
              <Camera size={14} />
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => e.target.files?.[0] && onAvatar(e.target.files[0])} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-bold">{display}</h2>
              {data.trust.verified && <Pill tone="success"><ShieldCheck size={11} weight="fill" /> Verified Inspector</Pill>}
            </div>
            <div className="text-sm text-zinc-500">{data.identity.email}</div>
            <div className="text-xs text-zinc-400 mt-1">Выполнено: {data.trust.completedTotal} · Рейтинг: {data.trust.ratingAvg ? data.trust.ratingAvg.toFixed(2) : '—'}</div>
          </div>
        </div>
      </Card>

      <Section title="Основные данные">
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Имя"><TextInput value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} data-testid="field-firstName" /></Field>
          <Field label="Фамилия"><TextInput value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))} data-testid="field-lastName" /></Field>
          <Field label="Email" hint="Email менять отдельным flow (verification)"><TextInput value={data.identity.email ?? ''} disabled /></Field>
          <Field label="Телефон"><TextInput value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="+49 30 1234567" data-testid="field-phone" /></Field>
          <Field label="Город"><TextInput value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder="Berlin" data-testid="field-city" /></Field>
          <Field label="Языки" hint="Через запятую"><TextInput value={form.languages} onChange={e => setForm(f => ({ ...f, languages: e.target.value }))} placeholder="ru, en, de" data-testid="field-languages" /></Field>
          <div className="md:col-span-2">
            <Field label="О себе"><TextArea value={form.bio} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} rows={3} placeholder="Опыт, специализации, кейсы" data-testid="field-bio" /></Field>
          </div>
        </Card>
      </Section>

      <Section title="Капability">
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Бренды" hint="Через запятую"><TextInput value={form.brands} onChange={e => setForm(f => ({ ...f, brands: e.target.value }))} placeholder="BMW, Mercedes, Audi" data-testid="field-brands" /></Field>
          <Field label="Инструменты" hint="Через запятую"><TextInput value={form.tools} onChange={e => setForm(f => ({ ...f, tools: e.target.value }))} placeholder="Paint meter, OBD-II, lift" data-testid="field-tools" /></Field>
          <Field label="Радиус работы (км)"><TextInput type="number" min={0} max={500} value={form.workingRadiusKm} onChange={e => setForm(f => ({ ...f, workingRadiusKm: Number(e.target.value) }))} data-testid="field-radius" /></Field>
        </Card>
      </Section>
    </PageContainer>
  );
}
