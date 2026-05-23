/** /inspector/availability — work hours, days, zones, blackout, max jobs. */
import { useEffect, useState } from 'react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, Field, TextInput, Toggle, PrimaryButton, Spinner, ErrorBlock, Pill } from '../../components/inspector/cabinet/CabinetUI';

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

interface Avail {
  online: boolean; zones: string[]; radiusKm: number;
  workingDays: number[]; workingHours: { start: string; end: string };
  blackoutDates: string[]; maxJobsPerDay: number;
}

export default function InspectorAvailabilityPage() {
  const [a, setA] = useState<Avail | null>(null);
  const [zonesText, setZonesText] = useState('');
  const [blackoutText, setBlackoutText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    inspectorAPI.getAvailability().then(r => {
      const av: Avail = r.data.availability;
      setA(av);
      setZonesText((av.zones || []).join(', '));
      setBlackoutText((av.blackoutDates || []).join(', '));
      setLoading(false);
    }).catch(e => { setError(e?.message ?? 'load failed'); setLoading(false); });
  }, []);

  const save = async () => {
    if (!a) return;
    setSaving(true); setError(null);
    try {
      const patch = {
        ...a,
        zones: zonesText.split(',').map(s => s.trim()).filter(Boolean),
        blackoutDates: blackoutText.split(',').map(s => s.trim()).filter(Boolean),
      };
      const r = await inspectorAPI.updateAvailability(patch);
      setA(r.data.availability);
      setSavedAt(new Date().toISOString());
    } catch (e: unknown) { setError((e as { message?: string })?.message ?? 'save failed'); }
    finally { setSaving(false); }
  };

  const toggleDow = (d: number) => {
    if (!a) return;
    const set = new Set(a.workingDays);
    set.has(d) ? set.delete(d) : set.add(d);
    setA({ ...a, workingDays: [...set].sort() });
  };

  if (loading) return <Spinner testId="avail-loading" />;
  if (!a) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  return (
    <PageContainer>
      <PageHeader
        title="Доступность"
        subtitle="Когда ты готов брать новые задания"
        testId="page-header-availability"
        actions={
          <>
            {savedAt && <span className="text-xs text-emerald-600">сохранено</span>}
            <PrimaryButton onClick={save} disabled={saving} data-testid="avail-save-btn">{saving ? 'Сохраняю...' : 'Сохранить'}</PrimaryButton>
          </>
        }
      />

      {error && <ErrorBlock message={error} />}

      <Section title="Статус">
        <Card className="px-5 py-4 flex items-center gap-4">
          <Toggle checked={a.online} onChange={v => setA({ ...a, online: v })} testId="avail-online" />
          <div className="flex-1">
            <div className="text-sm font-semibold">{a.online ? 'Сейчас онлайн — принимаю задания' : 'Не на смене'}</div>
            <div className="text-xs text-zinc-500">{a.online ? 'Видишь новые предложения в реальном времени' : 'Новые заявки не приходят'}</div>
          </div>
          <Pill tone={a.online ? 'success' : 'neutral'}>{a.online ? 'online' : 'offline'}</Pill>
        </Card>
      </Section>

      <Section title="Зоны и радиус">
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Рабочие зоны" hint="Через запятую (например, berlin-mitte, berlin-neukolln)">
            <TextInput value={zonesText} onChange={e => setZonesText(e.target.value)} placeholder="berlin-mitte, berlin-neukolln" data-testid="avail-zones" />
          </Field>
          <Field label="Радиус работы (км)">
            <TextInput type="number" min={0} max={500} value={a.radiusKm} onChange={e => setA({ ...a, radiusKm: Number(e.target.value) })} data-testid="avail-radius" />
          </Field>
        </Card>
      </Section>

      <Section title="График">
        <Card className="p-5 space-y-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-2">Рабочие дни</div>
            <div className="flex gap-1.5 flex-wrap">
              {DOW.map((label, idx) => {
                const d = idx + 1;
                const active = a.workingDays.includes(d);
                return (
                  <button
                    key={d}
                    onClick={() => toggleDow(d)}
                    data-testid={`avail-day-${d}`}
                    className={`w-12 py-1.5 rounded-lg text-xs font-bold border ${active ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white text-zinc-700 border-zinc-200'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Начало смены"><TextInput type="time" value={a.workingHours.start} onChange={e => setA({ ...a, workingHours: { ...a.workingHours, start: e.target.value } })} data-testid="avail-start" /></Field>
            <Field label="Конец смены"><TextInput type="time" value={a.workingHours.end} onChange={e => setA({ ...a, workingHours: { ...a.workingHours, end: e.target.value } })} data-testid="avail-end" /></Field>
            <Field label="Макс. заданий в день"><TextInput type="number" min={0} max={50} value={a.maxJobsPerDay} onChange={e => setA({ ...a, maxJobsPerDay: Number(e.target.value) })} data-testid="avail-max-jobs" /></Field>
          </div>
        </Card>
      </Section>

      <Section title="Дни-исключения" subtitle="Даты, когда тебя нет (через запятую, YYYY-MM-DD)">
        <Card className="p-5"><TextInput value={blackoutText} onChange={e => setBlackoutText(e.target.value)} placeholder="2026-06-12, 2026-07-01" data-testid="avail-blackout" /></Card>
      </Section>
    </PageContainer>
  );
}
