import { useState, FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, ArrowRight, Shield, Search, Wrench, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '../../stores/authStore';

/**
 * Auth · Login page — light theme (R-Auth-1.1)
 *
 * Full-screen композиция в light-теме, согласованная с PublicShell белой палитрой.
 * Hero слева (бренд + ценность), форма справа. Mobile — стек, hero скрыт.
 *
 * Admin redirect: при роли admin копирует token → admin_token и делает
 * hard-reload в /api/admin-panel/ (отдельный Vite SPA с собственным storage key).
 */
export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuthStore();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const nextParam = params.get('next');

  const routeAfterLogin = (role?: string, kind?: string) => {
    if (role === 'admin' || kind === 'admin') {
      const tok = localStorage.getItem('token');
      if (tok) localStorage.setItem('admin_token', tok);
      window.location.href = '/api/admin-panel/';
      return;
    }
    if (nextParam) { navigate(nextParam); return; }
    if (kind === 'inspector' || role === 'inspector') { navigate('/inspector/jobs'); return; }
    if (role === 'provider_owner' || role === 'provider_manager') { navigate('/provider'); return; }
    if (role === 'customer') { navigate('/account'); return; }
    navigate('/');
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await login(email, password);
      routeAfterLogin(res?.user?.role, res?.activeAccount?.kind);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Неверный email или пароль');
    } finally { setLoading(false); }
  };

  const useDemo = async (e: string, p: string) => {
    setEmail(e); setPassword(p);
    setError(''); setLoading(true);
    try {
      const res = await login(e, p);
      routeAfterLogin(res?.user?.role, res?.activeAccount?.kind);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Ошибка демо-входа');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen w-full" style={{ background: '#fafafa', color: '#0a0a0a' }} data-testid="login-page">
      {/* Top mini-bar */}
      <div className="px-5 md:px-10 py-5 flex items-center justify-between border-b border-zinc-200/70 bg-white/70 backdrop-blur sticky top-0 z-10">
        <Link to="/" className="flex items-center gap-2" data-testid="login-brand">
          <img src="/api/web-app/logo.png" alt="Auto Search" style={{ height: 28, width: 'auto' }} />
        </Link>
        <Link
          to="/"
          className="text-xs uppercase tracking-[0.18em] font-bold text-zinc-500 hover:text-black transition"
          data-testid="login-back-home"
        >
          ← На главную
        </Link>
      </div>

      <div className="grid lg:grid-cols-[1.05fr_1fr] gap-0 min-h-[calc(100vh-69px)]">
        {/* ── HERO (left) ───────────────────────────────────────── */}
        <div className="hidden lg:flex flex-col justify-between px-12 xl:px-20 py-12 relative overflow-hidden">
          {/* Soft amber radial — на белом фоне, тонкий */}
          <div
            aria-hidden
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                'radial-gradient(60% 50% at 15% 0%, rgba(255,176,32,0.14) 0%, rgba(255,176,32,0) 60%),' +
                'radial-gradient(40% 40% at 85% 100%, rgba(255,176,32,0.08) 0%, rgba(255,255,255,0) 70%)',
            }}
          />
          {/* Subtle grid */}
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
              / Auto Search Platform /
            </div>
            <h1 className="font-black leading-[0.95] tracking-tight"
                style={{ fontSize: 'clamp(48px, 5.2vw, 80px)', letterSpacing: '-0.02em', color: '#0a0a0a' }}>
              Покупай авто <br />
              <span style={{ color: '#FFB020' }}>с открытыми глазами.</span>
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-zinc-600">
              Платформа предпокупочной проверки и подбора автомобилей.
              Сертифицированные инспекторы. Прозрачные отчёты. Гараж и история — в одном месте.
            </p>
          </div>

          <div className="relative z-10 grid grid-cols-3 gap-3 max-w-lg">
            <Trust icon={Search} label="Подбор по бюджету и риску" />
            <Trust icon={Shield} label="60-точечный TÜV-style чек" />
            <Trust icon={Wrench} label="Инспекторы в 50+ городах" />
          </div>
        </div>

        {/* ── FORM (right) ──────────────────────────────────────── */}
        <div
          className="flex items-center justify-center px-5 md:px-10 py-10 lg:py-12"
          style={{ background: '#ffffff', borderLeft: '1px solid #ececec' }}
        >
          <div className="w-full max-w-[440px]" data-testid="login-form-card">
            <div className="text-[11px] uppercase tracking-[0.24em] font-bold mb-2" style={{ color: '#b45309' }}>
              Вход на платформу
            </div>
            <h2 className="text-4xl md:text-5xl font-black tracking-tight leading-none mb-3"
                style={{ letterSpacing: '-0.02em', color: '#0a0a0a' }}>
              С возвращением.
            </h2>
            <p className="text-sm text-zinc-500 mb-8">
              Войдите в кабинет — клиента, инспектора или администратора.
            </p>

            <form onSubmit={submit} className="space-y-4" data-testid="login-form">
              <div>
                <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 block mb-2">
                  Email
                </label>
                <div
                  className="flex items-center gap-3 h-[52px] px-4 rounded-xl transition focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"
                  style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
                >
                  <Mail size={16} style={{ color: '#FFB020' }} className="shrink-0" />
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="flex-1 bg-transparent outline-none text-[15px] text-zinc-900 placeholder:text-zinc-400"
                    data-testid="login-email"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] uppercase tracking-[0.18em] font-bold text-zinc-500 block mb-2">
                  Пароль
                </label>
                <div
                  className="flex items-center gap-3 h-[52px] px-4 rounded-xl transition focus-within:border-amber-500 focus-within:ring-2 focus-within:ring-amber-100"
                  style={{ background: '#ffffff', border: '1px solid #e5e5e5' }}
                >
                  <Lock size={16} style={{ color: '#FFB020' }} className="shrink-0" />
                  <input
                    type={showPwd ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="flex-1 bg-transparent outline-none text-[15px] text-zinc-900 placeholder:text-zinc-400"
                    data-testid="login-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPwd(v => !v)}
                    className="text-zinc-400 hover:text-zinc-900 transition shrink-0"
                    aria-label={showPwd ? 'Скрыть пароль' : 'Показать пароль'}
                    data-testid="login-toggle-password"
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
                  data-testid="login-error"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full h-[56px] rounded-xl font-black text-[15px] tracking-wide flex items-center justify-center gap-2 transition disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-95"
                style={{ background: '#FFB020', color: '#0a0a0a' }}
                data-testid="login-submit"
              >
                {loading ? 'Вход…' : <>Войти <ArrowRight size={16} strokeWidth={3} /></>}
              </button>
            </form>

            {/* Divider */}
            <div className="flex items-center gap-4 my-7">
              <div className="flex-1 h-px" style={{ background: '#ececec' }} />
              <span className="text-[10px] uppercase tracking-[0.24em] font-bold text-zinc-400">
                Demo доступ
              </span>
              <div className="flex-1 h-px" style={{ background: '#ececec' }} />
            </div>

            <div className="space-y-2" data-testid="demo-accounts">
              {DEMO_ACCOUNTS.map((d) => (
                <button
                  key={d.email}
                  type="button"
                  onClick={() => useDemo(d.email, d.pwd)}
                  disabled={loading}
                  className="w-full text-left p-3.5 rounded-xl transition group flex items-center gap-3 disabled:opacity-50 hover:border-amber-400 hover:bg-amber-50/40"
                  style={{ background: '#fafafa', border: '1px solid #ececec' }}
                  data-testid={`demo-${d.kind}`}
                >
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ background: 'rgba(255,176,32,0.14)', color: '#b45309' }}
                  >
                    <d.icon size={16} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-[13px] font-bold text-zinc-900">
                      {d.label}
                      {d.badge && (
                        <span
                          className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded"
                          style={{ background: '#FFB020', color: '#0a0a0a' }}
                        >
                          {d.badge}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate">{d.email}</div>
                  </div>
                  <ArrowRight size={14} className="text-zinc-300 group-hover:text-amber-500 transition shrink-0" />
                </button>
              ))}
            </div>

            <div className="mt-7 text-center text-sm text-zinc-500">
              Нет аккаунта?{' '}
              <Link to="/register" className="font-bold hover:underline" style={{ color: '#b45309' }} data-testid="login-register-link">
                Зарегистрироваться
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Trust({ icon: Icon, label }: { icon: any; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center"
        style={{ background: 'rgba(255,176,32,0.14)', color: '#b45309' }}
      >
        <Icon size={18} />
      </div>
      <div className="text-[12px] font-semibold text-zinc-700 leading-snug">{label}</div>
    </div>
  );
}

const DEMO_ACCOUNTS = [
  {
    kind: 'customer',
    label: 'Клиент',
    email: 'customer@test.com',
    pwd: 'Customer123!',
    icon: Search,
  },
  {
    kind: 'provider',
    label: 'Мастер / Инспектор',
    email: 'provider@test.com',
    pwd: 'Provider123!',
    icon: Wrench,
  },
  {
    kind: 'admin',
    label: 'Администратор',
    email: 'admin@autoservice.com',
    pwd: 'Admin123!',
    icon: Shield,
    badge: 'Admin Panel',
  },
] as const;
