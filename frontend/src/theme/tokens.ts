// ═════════════════════════════════════════════════════════
// 🎨 DESIGN TOKENS — single source of truth для UI System
// ═════════════════════════════════════════════════════════
// Правило: amber = всё основное, red = только error, green = success.
// Никаких inline hex в экранах. Все цвета — отсюда.
// ═════════════════════════════════════════════════════════

export const tokens = {
  colors: {
    // Brand
    brand: '#F5B800',
    brandDark: '#D9A200',
    brandSoftDark: 'rgba(245, 184, 0, 0.18)',
    brandSoftLight: 'rgba(245, 184, 0, 0.12)',

    // Surfaces — aligned with ThemeContext (pure neutral dark, not slate-blue).
    // Was '#0A0E14' / '#1A222D' (slate tint) which created a visible gray
    // background mismatch against the rest of the app on dark theme.
    // Now matches ThemeContext.background ('#0B0B0B') + backgroundTertiary ('#161618').
    bgDark: '#0B0B0B',
    bgLight: '#F6F7F9',
    cardDark: '#161618',
    cardLight: '#FFFFFF',

    // Text
    textDark: '#F8FAFC',
    textLight: '#0F172A',
    subtextDark: '#94A3B8',
    subtextLight: '#6B7280',

    // Borders — neutral grays (was slate '#1E293B' which carried blue tint).
    borderDark: '#26262A',
    borderLight: '#E5E7EB',

    // Semantic
    error: '#EF4444',
    success: '#22C55E',
    warning: '#F59E0B',

    // Static
    onBrand: '#0F0F10', // текст на amber кнопках — чёрный (контраст AAA)
    onError: '#FFFFFF',
  },

  radius: {
    sm: 10,
    md: 16,
    lg: 22,
    xl: 28,
    pill: 999,
  },

  spacing: {
    xs: 6,
    sm: 10,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },

  typography: {
    h1: 32,
    h2: 24,
    h3: 18,
    body: 15,
    caption: 13,
    micro: 11,
  },

  shadow: {
    softDark: {
      shadowColor: '#000',
      shadowOpacity: 0.35,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 6 },
      elevation: 4,
    },
    softLight: {
      shadowColor: '#0F172A',
      shadowOpacity: 0.08,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 2,
    },
  },
} as const;

export type Tokens = typeof tokens;
