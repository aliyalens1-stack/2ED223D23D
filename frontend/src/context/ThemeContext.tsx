/**
 * ThemeContext — SINGLE source of truth for colors.
 *
 * Restored: full dark + light palettes with working runtime toggle.
 * - `setTheme('dark' | 'light' | 'system')` — persisted via AsyncStorage
 * - `toggleTheme()` — flips between dark ↔ light
 * - Brand rules (Day 4): amber `#F5B800` is the PRIMARY action colour in BOTH
 *   themes. CTA buttons stay yellow across light & dark — no variants.
 *
 * Exports:
 *   - `useThemeContext()` hook → `{ colors, isDark, theme, setTheme, toggleTheme }`
 *   - `ThemeProvider`           → wraps the app, restores persisted mode
 *   - `ThemeColors.dark/light`  → raw palettes (for static imports)
 *   - `theme`                   → static alias: `theme.colors.brand` (dark-based)
 */
import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ============================================
// 🎨 DARK PALETTE — marketplace (original Monobank-style)
// ============================================
const darkPalette = {
  // Base surfaces
  bg: '#0B0B0B',
  background: '#0B0B0B',
  backgroundSecondary: '#111113',
  backgroundTertiary: '#161618',
  card: '#1A1A1A',
  cardElevated: '#202023',
  sheet: '#1A1A1A',

  // Brand (amber) — PRIMARY in both themes
  brand: '#F5B800',
  brandSoft: 'rgba(245, 184, 0, 0.18)',
  brandDark: '#D9A200',
  brandText: '#000000',

  primary: '#F5B800',
  primaryLight: '#FFD54A',
  primaryDark: '#D9A200',
  primaryGradient: ['#FFD54A', '#F5B800'],

  cta: '#F5B800',
  ctaText: '#000000',
  ctaPressed: '#D9A200',
  onPrimary: '#000000',

  accent: '#F5B800',
  accentLight: '#FFD54A',
  accentSoft: 'rgba(245, 184, 0, 0.18)',

  // Text
  text: '#FFFFFF',
  textSecondary: '#A1A1AA',
  textMuted: '#71717A',
  textInverse: '#000000',
  subtext: '#A1A1AA',

  // Borders / dividers
  border: '#27272A',
  borderLight: '#3F3F46',
  divider: 'rgba(255,255,255,0.06)',
  hairline: 'rgba(255,255,255,0.08)',

  // Status (narrow use)
  success: '#22C55E',
  successBg: 'rgba(34, 197, 94, 0.15)',
  warning: '#F59E0B',
  warningBg: 'rgba(245, 158, 11, 0.15)',
  danger: '#EF4444',
  error: '#EF4444',
  errorBg: 'rgba(239, 68, 68, 0.15)',
  info: '#F5B800',
  infoBg: 'rgba(245, 184, 0, 0.15)',

  // Tab bar
  tabBar: '#111113',
  tabBarBorder: '#27272A',
  tabInactive: '#71717A',
  tabActive: '#F5B800',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.7)',

  // Input
  inputBg: '#1A1A1A',
  inputBorder: '#27272A',
  inputFocus: '#F5B800',
  inputPlaceholder: '#71717A',

  // Switch / toggle
  switchTrackOn: '#F5B800',
  switchTrackOff: '#27272A',
  switchThumb: '#FFFFFF',

  // Shadow
  shadowColor: '#000000',
  shadowOpacityCard: 0.25,
  shadowOpacityFloat: 0.45,
} as const;

// ============================================
// ☀️ LIGHT PALETTE — web-app parity (amber CTA, white surfaces)
// ============================================
const lightPalette = {
  // Base surfaces
  bg: '#F6F7F9',
  background: '#F6F7F9',
  backgroundSecondary: '#FFFFFF',
  backgroundTertiary: '#F0F1F4',
  card: '#FFFFFF',
  cardElevated: '#FFFFFF',
  sheet: '#FFFFFF',

  // Brand (amber) — identical to dark, per Day 4 rule
  brand: '#F5B800',
  brandSoft: 'rgba(245, 184, 0, 0.14)',
  brandDark: '#D9A200',
  brandText: '#000000',

  primary: '#F5B800',
  primaryLight: '#FFD54A',
  primaryDark: '#D9A200',
  primaryGradient: ['#FFD54A', '#F5B800'],

  cta: '#F5B800',
  ctaText: '#000000',
  ctaPressed: '#D9A200',
  onPrimary: '#000000',

  accent: '#F5B800',
  accentLight: '#FFD54A',
  accentSoft: 'rgba(245, 184, 0, 0.10)',

  // Text
  text: '#0F172A',
  textSecondary: '#4B5563',
  textMuted: '#6B7280',
  textInverse: '#FFFFFF',
  subtext: '#4B5563',

  // Borders / dividers
  border: '#E5E7EB',
  borderLight: '#F1F2F5',
  divider: 'rgba(15, 23, 42, 0.08)',
  hairline: 'rgba(15, 23, 42, 0.06)',

  // Status
  success: '#16A34A',
  successBg: '#DCFCE7',
  warning: '#D97706',
  warningBg: '#FEF3C7',
  danger: '#DC2626',
  error: '#DC2626',
  errorBg: '#FEE2E2',
  info: '#F5B800',
  infoBg: 'rgba(245, 184, 0, 0.10)',

  // Tab bar
  tabBar: '#FFFFFF',
  tabBarBorder: '#E5E7EB',
  tabInactive: '#9CA3AF',
  tabActive: '#F5B800',

  // Overlay
  overlay: 'rgba(0, 0, 0, 0.45)',

  // Input
  inputBg: '#FFFFFF',
  inputBorder: '#E5E7EB',
  inputFocus: '#F5B800',
  inputPlaceholder: '#9CA3AF',

  // Switch / toggle
  switchTrackOn: '#F5B800',
  switchTrackOff: '#E5E7EB',
  switchThumb: '#FFFFFF',

  // Shadow
  shadowColor: '#0F172A',
  shadowOpacityCard: 0.08,
  shadowOpacityFloat: 0.14,
} as const;

// ============================================
// EXPORTS
// ============================================
export const ThemeColors = {
  dark: darkPalette,
  light: lightPalette,
};

export type ThemeMode = 'dark' | 'light' | 'system';
export type ThemeColorsType = typeof darkPalette; // both palettes share shape

// Static token object — for imports OUTSIDE React tree (StyleSheet helpers).
// Defaults to dark; components should prefer useThemeContext() for live switching.
export const theme = {
  colors: darkPalette,
};

// ============================================
// Context
// ============================================
interface ThemeContextType {
  theme: ThemeMode;                          // stored preference
  resolvedTheme: 'dark' | 'light';           // actual (resolves 'system')
  setTheme: (_theme: ThemeMode) => void;
  toggleTheme: () => void;
  colors: ThemeColorsType;
  isDark: boolean;
}

const STORAGE_KEY = '@auto_search:theme_mode';

const ThemeContext = createContext<ThemeContextType | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null
  const [themeMode, setThemeMode] = useState<ThemeMode>('dark');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate persisted choice once
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light' || saved === 'system') {
          setThemeMode(saved);
        }
      } catch {
        // ignore — fallback default
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  const resolvedTheme: 'dark' | 'light' =
    themeMode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : themeMode;

  const persist = useCallback(async (mode: ThemeMode) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
  }, []);

  const setTheme = useCallback(
    (mode: ThemeMode) => {
      setThemeMode(mode);
      persist(mode);
    },
    [persist]
  );

  const toggleTheme = useCallback(() => {
    setThemeMode((prev) => {
      const next: ThemeMode = prev === 'dark' ? 'light' : 'dark';
      persist(next);
      return next;
    });
  }, [persist]);

  const colors = resolvedTheme === 'light' ? lightPalette : darkPalette;
  const isDark = resolvedTheme === 'dark';

  // Avoid flashing wrong theme on first paint before hydration
  if (!hydrated) {
    return (
      <ThemeContext.Provider
        value={{
          theme: themeMode,
          resolvedTheme,
          setTheme,
          toggleTheme,
          colors: darkPalette,
          isDark: true,
        }}
      >
        {children}
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider
      value={{
        theme: themeMode,
        resolvedTheme,
        setTheme,
        toggleTheme,
        colors,
        isDark,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextType {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    // Safe fallback: dark palette with no-op toggles (e.g. component rendered outside provider during bootstrap)
    return {
      theme: 'dark',
      resolvedTheme: 'dark',
      setTheme: () => {},
      toggleTheme: () => {},
      colors: darkPalette,
      isDark: true,
    };
  }
  return ctx;
}
