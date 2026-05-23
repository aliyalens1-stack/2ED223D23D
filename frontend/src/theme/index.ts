/**
 * AutoService Design System
 *
 * Light palette mirrors the web-app (`/app/web-app`):
 *   amber #F5B800, ink-100 #F6F7F9 page bg, white surfaces, чёрный CTA.
 * Dark palette is the original Monobank-style dark theme.
 *
 * `useTheme()` is a hook that resolves the active palette from
 * `ThemeContext`, so a single component can switch its appearance
 * automatically when the user toggles the theme in Settings.
 */

import { useThemeContext } from '../context/ThemeContext';

// ============================================
// COLORS
// ============================================
export const Colors = {
  // Dark Theme (Monobank style — оригинал, не трогаем)
  dark: {
    background: '#0A0E14',
    backgroundSecondary: '#0F1419',
    card: '#1A222D',
    cardElevated: '#212B38',

    primary: '#3B82F6',
    primaryLight: '#60A5FA',
    primaryDark: '#2563EB',

    text: '#F8FAFC',
    textSecondary: '#94A3B8',
    textMuted: '#64748B',

    border: '#1E293B',
    borderLight: '#334155',

    success: '#22C55E',
    successBg: 'rgba(34, 197, 94, 0.15)',

    warning: '#F59E0B',
    warningBg: 'rgba(245, 158, 11, 0.15)',

    error: '#EF4444',
    errorBg: 'rgba(239, 68, 68, 0.15)',

    info: '#3B82F6',
    infoBg: 'rgba(59, 130, 246, 0.15)',
  },

  // Light Theme — web-app parity (Sprint 14 amber palette)
  light: {
    background: '#F6F7F9',
    backgroundSecondary: '#FFFFFF',
    card: '#FFFFFF',
    cardElevated: '#FFFFFF',

    // primary = чёрный (web "Quick request" / "Log in" CTA)
    primary: '#0F0F10',
    primaryLight: '#1F2937',
    primaryDark: '#000000',

    text: '#0F172A',
    textSecondary: '#4B5563',
    textMuted: '#6B7280',

    border: '#E5E7EB',
    borderLight: '#F3F4F6',

    success: '#16A34A',
    successBg: '#DCFCE7',

    warning: '#D97706',
    warningBg: '#FEF3C7',

    error: '#DC2626',
    errorBg: '#FEE2E2',

    info: '#0F0F10',
    infoBg: '#F3F4F6',
  },
};

// ============================================
// SPACING
// ============================================
export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
};

// ============================================
// TYPOGRAPHY
// ============================================
export const Typography = {
  size: {
    xs: 11,
    sm: 13,
    base: 15,
    md: 17,
    lg: 20,
    xl: 24,
    xxl: 32,
  },
  weight: {
    regular: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  lineHeight: {
    tight: 1.2,
    normal: 1.4,
    relaxed: 1.6,
  },
};

// ============================================
// BORDER RADIUS
// ============================================
export const BorderRadius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
};

// ============================================
// SHADOWS — две палитры (light = soft, dark = deep)
// ============================================
export const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 6,
  },
};

// ============================================
// STATUS COLORS (themed per palette)
// ============================================
export const StatusColors = {
  dark: {
    pending:     { bg: '#374151', text: '#9CA3AF', label: 'Ожидание' },
    confirmed:   { bg: '#1E40AF', text: '#60A5FA', label: 'Подтверждено' },
    in_progress: { bg: '#B45309', text: '#FBBF24', label: 'В работе' },
    completed:   { bg: '#166534', text: '#4ADE80', label: 'Завершено' },
    cancelled:   { bg: '#991B1B', text: '#FCA5A5', label: 'Отменено' },
    paid:        { bg: '#166534', text: '#4ADE80', label: 'Оплачено' },
    failed:      { bg: '#991B1B', text: '#FCA5A5', label: 'Ошибка' },
    refunded:    { bg: '#6B21A8', text: '#C084FC', label: 'Возврат' },
  },
  light: {
    pending:     { bg: '#F3F4F6', text: '#4B5563', label: 'Ожидание' },
    confirmed:   { bg: '#FFF4CC', text: '#0F0F10', label: 'Подтверждено' },
    in_progress: { bg: '#FEF3C7', text: '#92400E', label: 'В работе' },
    completed:   { bg: '#DCFCE7', text: '#166534', label: 'Завершено' },
    cancelled:   { bg: '#FEE2E2', text: '#991B1B', label: 'Отменено' },
    paid:        { bg: '#DCFCE7', text: '#166534', label: 'Оплачено' },
    failed:      { bg: '#FEE2E2', text: '#991B1B', label: 'Ошибка' },
    refunded:    { bg: '#F3E8FF', text: '#6B21A8', label: 'Возврат' },
  },
};

// ============================================
// COMPONENT SIZES
// ============================================
export const ComponentSizes = {
  buttonHeight: { sm: 36, md: 44, lg: 52 },
  inputHeight: 52,
  touchTarget: 48,
  iconSize: { sm: 18, md: 22, lg: 28, xl: 32 },
  avatarSize: { sm: 32, md: 44, lg: 64, xl: 88 },
  tabBarHeight: 80,
  tabBarIconSize: 24,
  headerHeight: 56,
};

// ============================================
// ANIMATION
// ============================================
export const Animation = {
  fast: 150,
  normal: 250,
  slow: 400,
};

// ============================================
// THEME HOOK — теперь динамический, читает ThemeContext
// ============================================
export const useTheme = () => {
  const { colors: ctxColors, isDark } = useThemeContext();
  const palette = isDark ? Colors.dark : Colors.light;
  return {
    colors: { ...palette, ...ctxColors }, // ctx может содержать расширенные токены
    spacing: Spacing,
    typography: Typography,
    borderRadius: BorderRadius,
    shadows: Shadows,
    status: isDark ? StatusColors.dark : StatusColors.light,
    sizes: ComponentSizes,
    animation: Animation,
    isDark,
  };
};

export default {
  Colors,
  Spacing,
  Typography,
  BorderRadius,
  Shadows,
  StatusColors,
  ComponentSizes,
  Animation,
  useTheme,
};
