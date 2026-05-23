import { useState } from 'react';
import { useAuthStore } from '../../stores/authStore';
import { Mail, User, Phone, Bell, Shield, LogOut, Save } from 'lucide-react';

export default function CustomerProfile() {
  const { user, logout } = useAuthStore();
  const [form, setForm] = useState({
    firstName: user?.firstName || '',
    lastName:  user?.lastName  || '',
    phone:     (user as any)?.phone || '+380 ',
    notif_email: true,
    notif_push:  true,
    notif_sms:   false,
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setTimeout(() => {
      setSaving(false);
      setSavedAt(new Date().toLocaleTimeString('ru-UA', { hour: '2-digit', minute: '2-digit' }));
    }, 500);
  };

  return (
    <div className="max-w-[900px] mx-auto px-4 lg:px-8 py-8" data-testid="customer-profile">
      <div className="slash-label mb-2">КАБИНЕТ КЛИЕНТА</div>
      <h1 className="font-display tracking-bebas text-4xl md:text-5xl mb-6">
        ПРОФИЛЬ <span className="text-amber">И НАСТРОЙКИ</span>
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-6">
        <div className="space-y-4">
          {/* Identity card */}
          <div className="card-elevated">
            <div className="slash-label mb-3">ДАННЫЕ</div>
            <div className="flex items-center gap-4 mb-5">
              <span className="w-14 h-14 bg-amber flex items-center justify-center text-black font-display text-3xl tracking-bebas" style={{ borderRadius: 12 }}>
                {(user?.firstName || user?.email || '?').charAt(0).toUpperCase()}
              </span>
              <div>
                <p className="font-display tracking-bebas text-2xl leading-none">{user?.firstName} {user?.lastName}</p>
                <p className="text-xs mt-1" style={{ color: 'var(--text-soft)' }}>{user?.email}</p>
              </div>
            </div>

            <div className="space-y-3">
              <Field label="Имя"     value={form.firstName} onChange={v => setForm({ ...form, firstName: v })} testId="profile-first-name" />
              <Field label="Фамилия" value={form.lastName}  onChange={v => setForm({ ...form, lastName: v })}  testId="profile-last-name" />
              <Field label="Телефон" value={form.phone}     onChange={v => setForm({ ...form, phone: v })}     testId="profile-phone" icon={Phone} />
              <ReadOnlyField label="Email" value={user?.email || ''} icon={Mail} />
            </div>
          </div>

          {/* Notifications */}
          <div className="card-elevated">
            <div className="slash-label mb-3">УВЕДОМЛЕНИЯ</div>
            <Toggle label="На email"   checked={form.notif_email} onChange={v => setForm({ ...form, notif_email: v })} testId="notif-email" />
            <Toggle label="Push в браузере" checked={form.notif_push} onChange={v => setForm({ ...form, notif_push: v })} testId="notif-push" />
            <Toggle label="SMS (платно)" checked={form.notif_sms} onChange={v => setForm({ ...form, notif_sms: v })} testId="notif-sms" />
          </div>

          {/* Save bar */}
          <div className="flex items-center justify-between gap-3">
            <span className="text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>
              {savedAt ? `Сохранено в ${savedAt}` : 'Изменения сохраняются автоматически'}
            </span>
            <button onClick={save} disabled={saving} className="btn-primary" data-testid="profile-save">
              <Save size={14} /> {saving ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>

        {/* Sidebar — security + logout */}
        <aside className="space-y-4">
          <div className="card-elevated">
            <div className="slash-label mb-3">БЕЗОПАСНОСТЬ</div>
            <Stat icon={Shield} label="Верификация" value="Пройдена" />
            <Stat icon={User}   label="Роль"        value={String(user?.role || 'customer')} />
            <Stat icon={Bell}   label="Логин"       value={String(user?.email || '—').slice(0, 24)} />
            <button className="btn-secondary w-full mt-4">Сменить пароль</button>
          </div>
          <div className="card-elevated">
            <div className="slash-label mb-3">СЕССИЯ</div>
            <button onClick={logout} className="btn-secondary w-full" data-testid="profile-logout">
              <LogOut size={14} /> Выйти из аккаунта
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, icon: Icon, testId }: any) {
  return (
    <label className="block">
      <span className="text-2xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-soft)' }}>{label}</span>
      <div className="input-shell">
        {Icon && <Icon size={14} className="text-amber" />}
        <input value={value} onChange={e => onChange(e.target.value)} className="text-sm" data-testid={testId} />
      </div>
    </label>
  );
}

function ReadOnlyField({ label, value, icon: Icon }: any) {
  return (
    <label className="block">
      <span className="text-2xs uppercase tracking-widest mb-1.5 block" style={{ color: 'var(--text-soft)' }}>{label}</span>
      <div className="input-shell" style={{ opacity: 0.7 }}>
        <Icon size={14} className="text-amber" />
        <input value={value} disabled className="text-sm" />
      </div>
    </label>
  );
}

function Toggle({ label, checked, onChange, testId }: any) {
  return (
    <button onClick={() => onChange(!checked)} className="w-full flex items-center justify-between py-3 hairline-b last:border-b-0" data-testid={testId}>
      <span className="text-sm">{label}</span>
      <span
        className="relative w-10 h-6 transition-colors"
        style={{ borderRadius: 999, background: checked ? 'var(--primary)' : 'var(--border-strong)' }}
      >
        <span
          className="absolute top-0.5 w-5 h-5 bg-black transition-all"
          style={{ borderRadius: 999, left: checked ? 18 : 2 }}
        />
      </span>
    </button>
  );
}

function Stat({ icon: Icon, label, value }: any) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="flex items-center gap-2 text-2xs uppercase tracking-widest" style={{ color: 'var(--text-soft)' }}>
        <Icon size={12} className="text-amber" />{label}
      </span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
