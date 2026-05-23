// ═════════════════════════════════════════════════════════
// 🌈 Brand gradients — единый источник для CTA / hero
// ═════════════════════════════════════════════════════════
import { tokens } from '../theme/tokens';

export const getBrandGradient = (_colors?: any): readonly [string, string, ...string[]] => {
  return [tokens.colors.brand, tokens.colors.brandDark] as const;
};

export const getDangerGradient = (): readonly [string, string, ...string[]] => {
  return [colors.brand, '#B91C1C'] as const;
};

export const getSuccessGradient = (): readonly [string, string, ...string[]] => {
  return [colors.success, colors.success] as const;
};
