import { Compass } from '@phosphor-icons/react';

interface Props {
  title: string;
  hint?: string;
}

/**
 * EmptyState — light-theme operational idle. NOT an error.
 */
export default function EmptyState({ title, hint }: Props) {
  return (
    <div className="h-full flex items-center justify-center p-12" data-testid="empty-state">
      <div className="text-center max-w-md">
        <div
          className="inline-flex w-14 h-14 rounded-2xl items-center justify-center mb-4"
          style={{ background: 'rgba(255,176,32,0.12)', color: '#b45309' }}
        >
          <Compass size={26} weight="duotone" />
        </div>
        <h2 className="text-lg font-bold text-zinc-900 mb-2">{title}</h2>
        {hint && <p className="text-sm text-zinc-500 leading-relaxed">{hint}</p>}
      </div>
    </div>
  );
}
