import React from 'react';

/**
 * Refined dark+yellow primitives — unified 10px radius, no outline-only states.
 */

export function BracketLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`bracket-label ${className}`}>{children}</span>;
}
export function SlashLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`slash-label ${className}`}>{children}</span>;
}
export function StepNum({ n }: { n: number }) {
  return <span className="step-num">{n}</span>;
}

export function Badge({
  children, variant = 'default', className = '',
}: {
  children: React.ReactNode;
  variant?: 'default' | 'solid' | 'muted';
  className?: string;
}) {
  const base = 'badge';
  const map = { default: '', solid: 'badge-solid', muted: 'badge-muted' };
  return <span className={`${base} ${map[variant]} ${className}`}>{children}</span>;
}

export function IconBadge({
  children, variant = 'soft', size = 'md', className = '',
}: {
  children: React.ReactNode;
  variant?: 'soft' | 'solid' | 'tint';   // soft = ink, tint = amber tint, solid = amber solid
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizes = { sm: 'w-8 h-8', md: 'w-10 h-10', lg: 'w-12 h-12' };
  const cls = variant === 'solid' ? 'icon-badge-solid'
            : variant === 'tint'  ? 'icon-badge'
            :                       'icon-badge-soft';
  return <span className={`${cls} ${sizes[size]} ${className}`}>{children}</span>;
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost';
  loading?: boolean;
};
export function Button({
  variant = 'primary', className = '', loading = false, children, disabled, ...rest
}: BtnProps) {
  const cls = variant === 'primary' ? 'btn-primary' : variant === 'secondary' ? 'btn-secondary' : 'btn-ghost';
  return (
    <button
      className={`${cls} ${className}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading
        ? <span className="inline-flex items-center gap-2"><span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> {children}</span>
        : children}
    </button>
  );
}

export function Chip({
  active = false, children, onClick, className = '', ...rest
}: React.HTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick as any}
      className={`chip ${active ? 'chip-active' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Card({
  children, className = '', interactive = false, elevated = false, ...rest
}: React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean; elevated?: boolean }) {
  const base = interactive ? 'card-interactive' : elevated ? 'card-elevated' : 'card';
  return (
    <div className={`${base} ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function LiveDot() {
  return <span className="live-dot" />;
}

export function SectionHeading({
  yellow, white, align = 'center', eyebrow, className = '',
}: {
  yellow: string; white?: string; eyebrow?: string;
  align?: 'left' | 'center'; className?: string;
}) {
  return (
    <div className={`${align === 'center' ? 'text-center' : 'text-left'} ${className}`}>
      {eyebrow && (
        <div className={`mb-4 ${align === 'center' ? 'flex justify-center' : ''}`}>
          <BracketLabel>{eyebrow}</BracketLabel>
        </div>
      )}
      <h2 className="font-heading font-black uppercase tracking-tightest leading-[0.95] text-4xl sm:text-5xl lg:text-6xl">
        <span className="text-amber">{yellow}</span>
        {white && <> <span className="text-white">{white}</span></>}
      </h2>
    </div>
  );
}

export function Stat({ value, label, valueClassName = '' }: { value: string | number; label: string; valueClassName?: string }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className={`font-heading font-black text-4xl sm:text-5xl text-amber leading-none ${valueClassName}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-[0.25em] text-gray-500 font-bold">{label}</div>
    </div>
  );
}

export function Dot({ className = '' }: { className?: string }) {
  return <span className={`inline-block w-1 h-1 rounded-full bg-amber ${className}`} />;
}
