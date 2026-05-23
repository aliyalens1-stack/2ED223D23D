/**
 * EmptyState — unified component for "nothing-to-show" states.
 *
 * Day 4 rules:
 *  - theme-aware (uses useThemeContext, not static tokens)
 *  - i18n-aware (caller passes translated strings via props)
 *  - brand CTA only (colors.brand + colors.brandText)
 *  - used everywhere: empty lists, search, not-found, tabs
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../context/ThemeContext';

export interface EmptyStateProps {
  icon?: keyof typeof Ionicons.glyphMap;
  iconColor?: string;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** Compact variant — no vertical padding, used in list headers. */
  compact?: boolean;
  testID?: string;
}

export function EmptyState({
  icon = 'file-tray-outline',
  iconColor,
  title,
  subtitle,
  actionLabel,
  onAction,
  compact = false,
  testID = 'empty-state',
}: EmptyStateProps) {
  const { colors } = useThemeContext();
  const iconTone = iconColor || colors.textMuted;
  return (
    <View
      testID={testID}
      style={[
        styles.container,
        compact && styles.containerCompact,
        { backgroundColor: 'transparent' },
      ]}
    >
      <View
        style={[
          styles.iconWrapper,
          { backgroundColor: colors.brandSoft },
        ]}
      >
        <Ionicons name={icon} size={48} color={iconTone} />
      </View>
      <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
        {title}
      </Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>{subtitle}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <TouchableOpacity
          testID={`${testID}-action`}
          style={[styles.button, { backgroundColor: colors.brand }]}
          onPress={onAction}
          activeOpacity={0.85}
        >
          <Text style={[styles.buttonText, { color: colors.brandText }]}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default EmptyState;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  containerCompact: {
    flex: 0,
    paddingVertical: 24,
  },
  iconWrapper: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 20,
    maxWidth: 280,
  },
  button: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '700',
  },
});
