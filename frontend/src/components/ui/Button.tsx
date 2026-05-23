// ═════════════════════════════════════════════════════════
// 🔘 UI Button — единственный способ создавать кнопки
// ═════════════════════════════════════════════════════════
import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, ViewStyle, TextStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../context/ThemeContext';
import { tokens } from '../../theme/tokens';
import { theme } from '../../../src/context/ThemeContext';
const colors = theme.colors;

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

type Props = {
  title?: string;
  children?: React.ReactNode;
  onPress?: () => void;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  testID?: string;
  style?: ViewStyle;
};

export default function Button({
  title,
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  icon,
  iconRight,
  testID,
  style,
}: Props) {
  const { colors } = useThemeContext();

  const sizeMap = {
    sm: { paddingVertical: 10, paddingHorizontal: 14, fontSize: 13 },
    md: { paddingVertical: 14, paddingHorizontal: 18, fontSize: 15 },
    lg: { paddingVertical: 16, paddingHorizontal: 20, fontSize: 16 },
  };
  const sz = sizeMap[size];

  // Цвета по варианту — всегда из theme tokens
  const variantStyles: Record<Variant, { bg: string; border?: string; fg: string }> = {
    primary: { bg: colors.brand, fg: tokens.colors.onBrand },
    secondary: { bg: colors.card, border: colors.border, fg: colors.text },
    ghost: { bg: 'transparent', fg: colors.textSecondary },
    danger: { bg: colors.error, fg: tokens.colors.onError },
  };
  const v = variantStyles[variant];

  const isDisabled = disabled || loading;

  return (
    <TouchableOpacity
      testID={testID}
      activeOpacity={0.85}
      onPress={isDisabled ? undefined : onPress}
      style={[
        styles.base,
        {
          backgroundColor: v.bg,
          borderWidth: v.border ? 1 : 0,
          borderColor: v.border,
          paddingVertical: sz.paddingVertical,
          paddingHorizontal: sz.paddingHorizontal,
          opacity: isDisabled ? 0.55 : 1,
          width: fullWidth ? '100%' : undefined,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={v.fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={sz.fontSize + 4} color={v.fg} style={{ marginRight: 8 }} />}
          <Text style={[styles.label, { color: v.fg, fontSize: sz.fontSize }]}>{title ?? children}</Text>
          {iconRight && <Ionicons name={iconRight} size={sz.fontSize + 4} color={v.fg} style={{ marginLeft: 8 }} />}
        </>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: tokens.radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  label: {
    fontWeight: '700',
    letterSpacing: -0.2,
    textAlign: 'center',
  } as TextStyle,
});
