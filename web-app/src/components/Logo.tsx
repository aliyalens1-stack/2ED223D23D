import { CSSProperties } from 'react';

type Props = {
  height?: number;
  className?: string;
  testId?: string;
  style?: CSSProperties;
};

/**
 * AutoSearch logo — renders the official PNG.
 * Image natural ratio is 3:2, height drives width.
 */
export default function Logo({ height = 36, className, testId, style }: Props) {
  return (
    <img
      src="/api/web-app/logo.png"
      alt="AutoSearch"
      className={className}
      style={{ height, width: 'auto', objectFit: 'contain', display: 'block', ...style }}
      data-testid={testId || 'autosearch-logo'}
      draggable={false}
    />
  );
}
