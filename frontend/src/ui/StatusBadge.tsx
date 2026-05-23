import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { StatusColors, BorderRadius, Spacing, Typography } from '../theme';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type StatusType = keyof typeof StatusColors.dark;

interface StatusBadgeProps {
  status: StatusType | string;
  label?: string;
  size?: 'sm' | 'md';
}

export function StatusBadge({ status, label, size = 'md' }: StatusBadgeProps) {
  const { isDark, colors } = useThemeContext();
  const palette = isDark ? StatusColors.dark : StatusColors.light;

  const config = palette[status as StatusType] || {
    bg: isDark ? colors.border : colors.backgroundTertiary,
    text: isDark ? colors.textMuted : colors.textMuted,
    label: status,
  };

  const displayLabel = label || (config as any).label;
  const isSmall = size === 'sm';

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: (config as any).bg,
          paddingHorizontal: isSmall ? Spacing.sm : Spacing.md,
          paddingVertical: isSmall ? 2 : Spacing.xs,
        },
      ]}
    >
      <Text
        style={[
          styles.text,
          {
            color: (config as any).text,
            fontSize: isSmall ? Typography.size.xs : Typography.size.sm,
          },
        ]}
      >
        {displayLabel}
      </Text>
    </View>
  );
}

export function PaymentStatusBadge({ status }: { status: string }) {
  const mapping: Record<string, StatusType> = {
    pending: 'pending',
    processing: 'pending',
    paid: 'paid',
    confirmed: 'paid',
    failed: 'failed',
    refunded: 'refunded',
    cancelled: 'cancelled',
  };
  return <StatusBadge status={mapping[status] || status} />;
}

export function BookingStatusBadge({ status }: { status: string }) {
  return <StatusBadge status={status} />;
}

const styles = StyleSheet.create({
  badge: {
    borderRadius: BorderRadius.sm,
    alignSelf: 'flex-start',
  },
  text: {
    fontWeight: '600',
  },
});
