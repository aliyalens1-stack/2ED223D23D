import React from 'react';
import {
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  View,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Spacing, BorderRadius, ComponentSizes, Typography } from '../theme';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'cta';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps {
  children: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: keyof typeof Ionicons.glyphMap;
  iconPosition?: 'left' | 'right';
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  testID?: string;
}

export function Button({
  children,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'left',
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  textStyle,
  testID,
}: ButtonProps) {
  const { colors } = useThemeContext();

  const variantStyles: Record<ButtonVariant, { bg: string; text: string; border: string }> = {
    // primary = чёрный CTA на light, синий на dark
    primary: {
      bg: colors.primary,
      text: colors.textInverse,
      border: 'transparent',
    },
    // cta = жёлтый акцент (web "Search" / "Solve problem")
    cta: {
      bg: colors.cta,
      text: colors.ctaText,
      border: 'transparent',
    },
    secondary: {
      bg: 'transparent',
      text: colors.text,
      border: colors.border,
    },
    ghost: {
      bg: 'transparent',
      text: colors.primary,
      border: 'transparent',
    },
    danger: {
      bg: colors.error,
      text: colors.text,
      border: 'transparent',
    },
  };

  const sizeStyles = {
    sm: {
      height: ComponentSizes.buttonHeight.sm,
      paddingHorizontal: Spacing.md,
      fontSize: Typography.size.sm,
      iconSize: 16,
    },
    md: {
      height: ComponentSizes.buttonHeight.md,
      paddingHorizontal: Spacing.base,
      fontSize: Typography.size.base,
      iconSize: 18,
    },
    lg: {
      height: ComponentSizes.buttonHeight.lg,
      paddingHorizontal: Spacing.lg,
      fontSize: Typography.size.md,
      iconSize: 20,
    },
  };

  const v = variantStyles[variant];
  const s = sizeStyles[size];

  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.7}
      style={[
        styles.button,
        {
          height: s.height,
          paddingHorizontal: s.paddingHorizontal,
          backgroundColor: v.bg,
          borderColor: v.border,
          borderWidth: variant === 'secondary' ? 1.5 : 0,
          opacity: disabled ? 0.5 : 1,
        },
        fullWidth && styles.fullWidth,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={v.text} size="small" />
      ) : (
        <View style={styles.content}>
          {icon && iconPosition === 'left' && (
            <Ionicons name={icon} size={s.iconSize} color={v.text} style={styles.iconLeft} />
          )}
          <Text style={[styles.text, { color: v.text, fontSize: s.fontSize }, textStyle]}>
            {children}
          </Text>
          {icon && iconPosition === 'right' && (
            <Ionicons name={icon} size={s.iconSize} color={v.text} style={styles.iconRight} />
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// Shortcut components
export const PrimaryButton = (props: Omit<ButtonProps, 'variant'>) => <Button {...props} variant="primary" />;
export const SecondaryButton = (props: Omit<ButtonProps, 'variant'>) => <Button {...props} variant="secondary" />;
export const GhostButton = (props: Omit<ButtonProps, 'variant'>) => <Button {...props} variant="ghost" />;
export const DangerButton = (props: Omit<ButtonProps, 'variant'>) => <Button {...props} variant="danger" />;
export const CtaButton = (props: Omit<ButtonProps, 'variant'>) => <Button {...props} variant="cta" />;

const styles = StyleSheet.create({
  button: {
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  fullWidth: {
    width: '100%',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    fontWeight: '600',
  },
  iconLeft: {
    marginRight: Spacing.sm,
  },
  iconRight: {
    marginLeft: Spacing.sm,
  },
});
