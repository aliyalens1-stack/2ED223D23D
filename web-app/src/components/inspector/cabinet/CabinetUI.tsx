/**
 * Shared visual primitives for /inspector/* pages.
 *
 * Why a single file: 10 pages share the exact same chrome (page header,
 * section, metric tile, empty state, etc.). Inlining them in every page
 * leads to drift; one tiny module keeps the cabinet feeling like one
 * product, not 10 mini-apps.
 */
import { ReactNode } from 'react';
import { Warning } from '@phosphor-icons/react';

export function PageContainer({ children }: { children: ReactNode }) {
  return <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">{children}</div>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  testId,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4" data-testid={testId}>
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">{title}</h1>
        {subtitle && <p className="text-sm text-zinc-500 mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  actions,
  children,
  testId,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section data-testid={testId}>
      {(title || actions) && (
        <div className="flex items-end justify-between mb-3">
          <div>
            {title && <h2 className="text-xs uppercase tracking-wider font-bold text-zinc-500">{title}</h2>}
            {subtitle && <p className="text-xs text-zinc-400 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Card({
  children,
  className = '',
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={`bg-white rounded-2xl border border-zinc-200 ${className}`}
      data-testid={testId}
    >
      {children}
    </div>
  );
}

export function MetricTile({
  label,
  value,
  sub,
  icon,
  testId,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="px-4 py-3" testId={testId}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500 font-semibold">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-1.5 text-xl font-bold text-zinc-900 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-zinc-500 mt-0.5">{sub}</div>}
    </Card>
  );
}

export function Empty({
  title,
  hint,
  icon,
  testId,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  testId?: string;
}) {
  return (
    <Card className="px-6 py-12 text-center" testId={testId}>
      <div className="text-zinc-300 flex justify-center mb-2">{icon}</div>
      <div className="text-sm text-zinc-700 font-semibold">{title}</div>
      {hint && <div className="text-xs text-zinc-500 mt-1">{hint}</div>}
    </Card>
  );
}

export function ErrorBlock({ message, testId }: { message: string; testId?: string }) {
  return (
    <Card className="px-4 py-3 flex items-center gap-2 text-rose-700 border-rose-200" testId={testId}>
      <Warning size={16} weight="fill" />
      <span className="text-sm">{message}</span>
    </Card>
  );
}

export function Spinner({ testId }: { testId?: string }) {
  return (
    <div className="flex items-center justify-center py-16" data-testid={testId}>
      <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-zinc-900" />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex items-center gap-2 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      data-testid={testId}
    >
      <span
        className={`relative inline-block h-5 w-9 rounded-full transition ${
          checked ? 'bg-emerald-500' : 'bg-zinc-300'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </span>
      {label && <span className="text-sm">{label}</span>}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
        {label}
      </div>
      {children}
      {hint && <div className="text-[11px] text-zinc-400 mt-1">{hint}</div>}
    </label>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 ${
        props.className ?? ''
      }`}
    />
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 ${
        props.className ?? ''
      }`}
    />
  );
}

export function PrimaryButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-50 disabled:cursor-not-allowed ${
        rest.className ?? ''
      }`}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={`px-3 py-1.5 rounded-lg text-sm text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 ${
        rest.className ?? ''
      }`}
    >
      {children}
    </button>
  );
}

export function Pill({
  children,
  tone = 'neutral',
  testId,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  testId?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-800 border-amber-200',
    danger: 'bg-rose-50 text-rose-700 border-rose-200',
    info: 'bg-blue-50 text-blue-700 border-blue-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tones[tone]}`}
      data-testid={testId}
    >
      {children}
    </span>
  );
}
