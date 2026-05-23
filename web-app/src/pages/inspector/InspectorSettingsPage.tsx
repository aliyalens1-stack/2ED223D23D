/** /inspector/settings — language, timezone, notifications, channels, privacy. */
import { useEffect, useState } from 'react';
import { inspectorAPI } from '../../services/api';
import { PageContainer, PageHeader, Section, Card, Field, Toggle, PrimaryButton, Spinner, ErrorBlock } from '../../components/inspector/cabinet/CabinetUI';

interface Settings {
  language: string;
  timezone: string;
  notifications: { newJobOffers: boolean; reportReminders: boolean; payoutUpdates: boolean; disputeAlerts: boolean; marketing: boolean };
  channels: { email: boolean; push: boolean; sms: boolean };
  reportDefaults: { autoSaveDraft: boolean; suggestVerdict: boolean };
  privacy: { showRatingPublic: boolean; showStatsPublic: boolean };
}

const LANGS = [
  { v: 'ru', l: 'Русский' },
  { v: 'en', l: 'English' },
  { v: 'de', l: 'Deutsch' },
];
const TIMEZONES = ['Europe/Berlin', 'Europe/Moscow', 'Europe/Kiev', 'Europe/London', 'UTC'];

export default function InspectorSettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    inspectorAPI.getSettings().then(r => { setS(r.data.settings); setLoading(false); }).catch(e => { setError(e?.message ?? 'fail'); setLoading(false); });
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true); setError(null);
    try {
      const r = await inspectorAPI.updateSettings(s);
      setS(r.data.settings);
      setSavedAt(new Date().toISOString());
    } catch (e: unknown) { setError((e as { message?: string })?.message ?? 'save failed'); }
    finally { setSaving(false); }
  };

  if (loading) return <Spinner testId="settings-loading" />;
  if (!s) return <PageContainer><ErrorBlock message={error ?? 'no data'} /></PageContainer>;

  const setNotif = (k: keyof Settings['notifications'], v: boolean) =>
    setS({ ...s, notifications: { ...s.notifications, [k]: v } });
  const setChan = (k: keyof Settings['channels'], v: boolean) =>
    setS({ ...s, channels: { ...s.channels, [k]: v } });
  const setRD = (k: keyof Settings['reportDefaults'], v: boolean) =>
    setS({ ...s, reportDefaults: { ...s.reportDefaults, [k]: v } });
  const setPriv = (k: keyof Settings['privacy'], v: boolean) =>
    setS({ ...s, privacy: { ...s.privacy, [k]: v } });

  return (
    <PageContainer>
      <PageHeader
        title="Настройки"
        subtitle="Язык, часовой пояс, уведомления"
        testId="page-header-settings"
        actions={
          <>
            {savedAt && <span className="text-xs text-emerald-600">сохранено</span>}
            <PrimaryButton onClick={save} disabled={saving} data-testid="settings-save-btn">{saving ? 'Сохраняю...' : 'Сохранить'}</PrimaryButton>
          </>
        }
      />

      {error && <ErrorBlock message={error} />}

      <Section title="Локализация">
        <Card className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Язык">
            <select
              value={s.language}
              onChange={e => setS({ ...s, language: e.target.value })}
              data-testid="settings-language"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              {LANGS.map(l => <option key={l.v} value={l.v}>{l.l}</option>)}
            </select>
          </Field>
          <Field label="Часовой пояс">
            <select
              value={s.timezone}
              onChange={e => setS({ ...s, timezone: e.target.value })}
              data-testid="settings-timezone"
              className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm"
            >
              {TIMEZONES.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
          </Field>
        </Card>
      </Section>

      <Section title="Уведомления">
        <Card className="p-5 space-y-3">
          <ToggleRow label="Новые предложения заданий" value={s.notifications.newJobOffers} onChange={v => setNotif('newJobOffers', v)} testId="notif-newJobOffers" />
          <ToggleRow label="Напоминания об отчётах" value={s.notifications.reportReminders} onChange={v => setNotif('reportReminders', v)} testId="notif-reportReminders" />
          <ToggleRow label="Обновления выплат" value={s.notifications.payoutUpdates} onChange={v => setNotif('payoutUpdates', v)} testId="notif-payoutUpdates" />
          <ToggleRow label="Открытые споры" value={s.notifications.disputeAlerts} onChange={v => setNotif('disputeAlerts', v)} testId="notif-disputeAlerts" />
          <ToggleRow label="Маркетинг и новости" value={s.notifications.marketing} onChange={v => setNotif('marketing', v)} testId="notif-marketing" />
        </Card>
      </Section>

      <Section title="Каналы доставки">
        <Card className="p-5 space-y-3">
          <ToggleRow label="Email" value={s.channels.email} onChange={v => setChan('email', v)} testId="chan-email" />
          <ToggleRow label="Push-уведомления" value={s.channels.push} onChange={v => setChan('push', v)} testId="chan-push" />
          <ToggleRow label="SMS" value={s.channels.sms} onChange={v => setChan('sms', v)} testId="chan-sms" />
        </Card>
      </Section>

      <Section title="Параметры отчётов">
        <Card className="p-5 space-y-3">
          <ToggleRow label="Авто-сохранение черновика" value={s.reportDefaults.autoSaveDraft} onChange={v => setRD('autoSaveDraft', v)} testId="rd-autoSaveDraft" />
          <ToggleRow label="AI подсказывает verdict" value={s.reportDefaults.suggestVerdict} onChange={v => setRD('suggestVerdict', v)} testId="rd-suggestVerdict" />
        </Card>
      </Section>

      <Section title="Приватность">
        <Card className="p-5 space-y-3">
          <ToggleRow label="Публично показывать рейтинг" value={s.privacy.showRatingPublic} onChange={v => setPriv('showRatingPublic', v)} testId="priv-rating" />
          <ToggleRow label="Публично показывать статистику" value={s.privacy.showStatsPublic} onChange={v => setPriv('showStatsPublic', v)} testId="priv-stats" />
        </Card>
      </Section>
    </PageContainer>
  );
}

function ToggleRow({ label, value, onChange, testId }: { label: string; value: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-zinc-800">{label}</span>
      <Toggle checked={value} onChange={onChange} testId={testId} />
    </div>
  );
}
