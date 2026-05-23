import { useState, FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { User, Mail, Lock, Phone, ArrowRight, Search, Wrench, Eye, EyeOff, Shield } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

/**
 * Auth · Register page — light theme (R-Auth-2.1)
 *
 * Зеркальная композиция к LoginPage в light-теме PublicShell.
 */
export default function RegisterPage() {
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', password: '', role: 'customer',
  });
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuthStore();
  const navigate = useNavigate();

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      await register(form);
      navigate(form.role === 'customer' ? '/account' : '/provider');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка регистрации');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen w-full" style={{ background: '#fafafa', color: '#0a0a0a' }} data-testid="register-page">
      <div className="px-5 md:px-10 py-5 flex items-center justify-between border-b border-zinc-200/70 bg-white/70 backdrop-blur sticky top-0 z-10">
        <Link to="/" className="flex items-center gap-2" data-testid="register-brand">
          <img src="/api/web-app/logo.png" alt="Auto Search" style={{ height: 28, width: 'auto' }} />
        </Link>
        <Link
          to="/"
          className="text-xs uppercase tracking-[0.18em] font-bold text-zinc-500 hover:text-black transition"
          data-testid="register-back-home"
        >
          ← На главную
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1.05fr_1fr] gap-0 min-h-[calc(100vh-69px)]">
        {/* ── HERO (left) ───────────────────────────────────────── */}
        <div className="hidden lg:flex flex-col justify-between px-12 xl:px-20 py-12 relative overflow-hidden">
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(60% 50% at 15% 0%, rgba(255,176,32,0.14) 0%, rgba(255,176,32,0) 60%),' +
                'radial-gradient(40% 40% at 85% 100%, rgba(255,176,32,0.08) 0%, rgba(255,255,255,0) 70%)',
            }}
          />
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none opacity-[0.5]"
            style={{
              backgroundImage:
                'linear-gradient(rgba(0,0,0,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.04) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
              maskImage: 'radial-gradient(60% 60% at 30% 40%, black 0%, transparent 80%)',
              WebkitMaskImage: 'radial-gradient(60% 60% at 30% 40%, black 0%, transparent 80%)',
            }}
          />

          <div className="relative z-10">
            <div className="text-[11px] uppercase tracking-[0.32em] font-bold mb-6" style={{ color: '#b45309' }}>
              / Создать аккаунт /
            </div>
            <h1 className="font-black leading-[0.95] tracking-tight"
                style={{ fontSize: 'clamp(48px, 5vw, 76px)', letterSpacing: '-0.02em', color: '#0a0a0a' }}>
              Минута на регистрацию.<br />
              <span style={{ color: '#FFB020' }}>Годы без сюрпризов.</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-zinc-600">
              Создайте аккаунт клиента или мастера. Заявка на проверку — за 30 секунд.
              История каждого автомобиля сохраняется в вашем гараже.
            </p>
          </div>

          <div className="relative z-10 grid grid-cols-2 gap-3 max-w-md">
            <Bullet num="01" text="Заявка → инспектор приедет в течение дня" />
            <Bullet num="02" text="Полный отчёт + видео + фото = решение" />
          </div>
        </div>

        {/* ── FORM (right) ──────────────────────────────────────── */}
        <div
          className="flex items-center justify-center px-5 md:px-10 py-10 lg:py-12"
          style={{ background: '#ffffff', borderLeft: '1px solid #ececec' }}
        >
          <div className="w-full max-w-[480px]" data-testid="register-form-card">
            <div className="text-[11px] uppercase tracking-[0.24em] font-bold mb-2" style={{ color: '#b45309' }}>
              Регистрация
            </div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-none mb-3"
                style={{ letterSpacing: '-0.02em', color: '#0a0a0a' }}>
              Начнём.
            </h2>
            <p className="text-sm text-zinc-500 mb-7">
              Кто вы на платформе — клиент или мастер? Это можно поменять позже.
            </p>

            {/* Role pills */}
            <div className="grid grid-cols-2 gap-2 mb-6" role="tablist">
              <RolePill
                active={form.role === 'customer'}
                icon={Search}
                title="Клиент"
                desc="Хочу проверить или подобрать авто"
                onClick={() => set('role', 'customer')}
                testId="role-customer"
              />
              <RolePill
                active={form.role === 'provider_owner'}
                icon={Wrench}
                title="Мастер / СТО"
                desc="Хочу выполнять инспекции"
                onClick={() => set('role', 'provider_owner')}
                testId="role-provider"
              />
            </div>

            <form onSubmit={submit} className="space-y-3.5" data-testid="register-form">
              <div className="grid grid-cols-2 gap-3">
                <Field icon={User} placeholder="Имя" value={form.firstName} onChange={v => set('firstName', v)} testId="reg-first-name" />
                <Field icon={User} placeholder="Фамилия" value={form.lastName} onChange={v => set('lastName', v)} testId="reg-last-name" />
              </div>
              <Field icon={Mail} type="email" placeholder="you@example.com" value={form.email} onChange={v => set('email', v)} testId="reg-email" autoComplete="email" />
              <Field icon={Phone} placeholder="+49 ..." value={form.phone} onChange={v => set('phone', v)} testId="reg-phone" autoComplete="tel" />

              <div>
                <div
                  className="flex items-center gap-3 h-[52px] px-4 rounded-xl transition focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"
                  style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
                >
                  <Lock size={16} style={{ color: '#FFB020' }} className="shrink-0" />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={form.password}
                    onChange={e => set('password', e.target.value)}
                    placeholder="Пароль (минимум 8 символов)"
                    className="flex-1 bg-transparent outline-none text-[15px] text-zinc-900 placeholder:text-zinc-400"
                    data-testid="reg-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(v => !v)}
                    className="text-zinc-400 hover:text-zinc-900 transition shrink-0"
                    aria-label={showPwd ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {showPwd ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  className="rounded-lg px-4 py-3 text-[13px]"
                  style={{
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#b91c1c',
                  }}
                  data-testid="reg-error"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-[56px] rounded-xl font-black text-[15px] tracking-wide flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-95 mt-2"
                style={{ background: '#FFB020', color: '#0a0a0a' }}
                data-testid="reg-submit"
              >
                {loading ? 'Создание…' : <>Создать аккаунт <ArrowRight size={16} strokeWidth={3} /></>}
              </button>

              <div className="flex items-center gap-2 text-[11px] text-zinc-500 pt-1">
                <Shield size={12} style={{ color: '#FFB020' }} className="shrink-0" />
                Регистрируясь, вы соглашаетесь с условиями использования и политикой конфиденциальности.
              </div>
            </form>

            <div className="mt-7 text-center text-sm text-zinc-500">
              Уже есть аккаунт?{' '}
              <Link to="/login" className="font-bold hover:underline" style={{ color: '#b45309' }} data-testid="register-login-link">
                Войти
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  icon: Icon, value, onChange, placeholder, type = 'text', testId, autoComplete,
}: {
  icon: any; value: string; onChange: (v: string) => void;
  placeholder: string; type?: string; testId: string; autoComplete?: string;
}) {
  return (
    <div
      className="flex items-center gap-3 h-[52px] px-4 rounded-xl transition focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"
      style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
    >
      <Icon size={16} style={{ color: '#FFB020' }} className="shrink-0" />
      <input
        type={type}
        required
        autoComplete={autoComplete}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 bg-transparent outline-none text-[15px] text-zinc-900 placeholder:text-zinc-400"
        data-testid={testId}
      />
    </div>
  );
}

function RolePill({
  active, icon: Icon, title, desc, onClick, testId,
}: {
  active: boolean; icon: any; title: string; desc: string;
  onClick: () => void; testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      role="tab"
      aria-selected={active}
      className="text-left p-3.5 rounded-xl transition"
      style={{
        background: active ? 'rgba(255,176,32,0.10)' : '#fafafa',
        border: active ? '1px solid #FFB020' : '1px solid #ececec',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} style={{ color: active ? '#b45309' : '#71717a' }} />
        <div className="text-[13px] font-bold" style={{ color: active ? '#b45309' : '#0a0a0a' }}>
          {title}
        </div>
      </div>
      <div className="text-[11px] text-zinc-500 leading-snug">{desc}</div>
    </button>
  );
}

function Bullet({ num, text }: { num: string; text: string }) {
  return (
    <div className="flex gap-3 items-start">
      <div className="font-black text-xl shrink-0" style={{ letterSpacing: '-0.02em', color: '#FFB020' }}>
        {num}
      </div>
      <div className="text-[13px] text-zinc-700 leading-snug">{text}</div>
    </div>
  );
}
