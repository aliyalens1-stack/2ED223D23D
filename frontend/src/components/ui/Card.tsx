// ═════════════════════════════════════════════════════════
// 🧱 UI Card — обычная и elevated карточка через theme
// ═════════════════════════════════════════════════════════
import React from 'react';
import { View, ViewStyle, Platform } from 'react-native';
import { useThemeContext } from '../../context/ThemeContext';
import { tokens } from '../../theme/tokens';
import { theme } from '../../../src/context/ThemeContext';
const colors = theme.colors;

type Props = {
  children: React.ReactNode;
  variant?: 'default' | 'elevated' | 'outlined';
  padding?: keyof typeof tokens.spacing;
  style?: ViewStyle;
  testID?: string;
};

export default function Card({ children, variant = 'default', padding = 'md', style, testID }: Props) {
  const { colors, isDark } = useThemeContext();
  const shadow = variant === 'elevated' ? (isDark ? tokens.shadow.softDark : tokens.shadow.softLight) : null;

  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: colors.card,
          borderRadius: tokens.radius.lg,
          padding: tokens.spacing[padding],
          borderWidth: variant === 'outlined' ? 1 : 0,
          borderColor: colors.border,
          ...(shadow && Platform.OS !== 'web' ? shadow : {}),
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
