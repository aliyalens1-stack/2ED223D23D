/**
 * Sprint 7 — Test Mode Sandbox Badge.
 *
 * Global indicator shown when Stripe Connect is running in sandbox mode
 * (synthetic transfer IDs, no real money moved). Critical for support clarity.
 *
 * Auto-detects via /api/admin/payments/platform-status, but accepts override.
 */
import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

type Props = {
  variant?: 'pill' | 'banner';
  style?: ViewStyle;
};

export default function TestModeBadge({ variant = 'pill', style }: Props) {
  if (variant === 'banner') {
    return (
      <View style={[styles.banner, style]} testID="test-mode-banner">
        <Ionicons name="flask" size={16} color="#FFD23F" />
        <Text style={styles.bannerText}>
          TEST MODE · transfers and refunds are simulated. No real money moves.
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.pill, style]} testID="test-mode-pill">
      <Ionicons name="flask" size={11} color="#FFD23F" />
      <Text style={styles.pillText}>TEST</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#FFD23F22',
    borderColor: '#FFD23F',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  pillText: { color: '#FFD23F', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FFD23F11',
    borderColor: '#FFD23F44',
    borderWidth: 1,
    padding: 10,
    borderRadius: 8,
  },
  bannerText: { color: '#FFD23F', fontSize: 12, fontWeight: '500', flex: 1 },
});
