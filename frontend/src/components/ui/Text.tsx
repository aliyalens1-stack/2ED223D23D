// ═════════════════════════════════════════════════════════
// 🔤 UI Text — типографика через theme. Никаких inline размеров.
// ═════════════════════════════════════════════════════════
import React from 'react';
import { Text as RNText, TextStyle, TextProps as RNTextProps } from 'react-native';
import { useThemeContext } from '../../context/ThemeContext';
import { tokens } from '../../theme/tokens';
import { theme } from '../../../src/context/ThemeContext';
const colors = theme.colors;

type Variant = 'h1' | 'h2' | 'h3' | 'body' | 'caption' | 'micro' | 'kicker';
type Tone = 'default' | 'muted' | 'brand' | 'error' | 'success' | 'inverse';

type Props = RNTextProps & {
  variant?: Variant;
  tone?: Tone;
  weight?: '400' | '500' | '600' | '700' | '800' | '900';
  align?: 'left' | 'center' | 'right';
  children?: React.ReactNode;
};

const SIZES: Record<Variant, { fontSize: number; lineHeight: number; weight: TextStyle['fontWeight']; letterSpacing?: number }> = {
  h1:      { fontSize: tokens.typography.h1, lineHeight: 38, weight: '900', letterSpacing: -0.8 },
  h2:      { fontSize: tokens.typography.h2, lineHeight: 30, weight: '800', letterSpacing: -0.4 },
  h3:      { fontSize: tokens.typography.h3, lineHeight: 24, weight: '700' },
  body:    { fontSize: tokens.typography.body, lineHeight: 22, weight: '500' },
  caption: { fontSize: tokens.typography.caption, lineHeight: 18, weight: '500' },
  micro:   { fontSize: tokens.typography.micro, lineHeight: 14, weight: '700', letterSpacing: 1.4 },
  kicker:  { fontSize: tokens.typography.micro, lineHeight: 14, weight: '900', letterSpacing: 1.6 },
};

export default function Text({
  variant = 'body',
  tone = 'default',
  weight,
  align,
  style,
  children,
  ...rest
}: Props) {
  const { colors } = useThemeContext();
  const cfg = SIZES[variant];

  const toneColor: Record<Tone, string> = {
    default: colors.text,
    muted: colors.textSecondary,
    brand: colors.brand,
    error: colors.error,
    success: colors.success,
    inverse: colors.textInverse,
  };

  return (
    <RNText
      {...rest}
      style={[
        {
          fontSize: cfg.fontSize,
          lineHeight: cfg.lineHeight,
          fontWeight: weight ?? cfg.weight,
          letterSpacing: cfg.letterSpacing,
          color: toneColor[tone],
          textAlign: align,
        },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}
