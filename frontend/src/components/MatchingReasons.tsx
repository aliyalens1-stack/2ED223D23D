import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

interface MatchingReasonsProps {
  reasons: string[];
  limit?: number;
  compact?: boolean;
}

export default function MatchingReasons({ reasons, limit = 2, compact = false }: MatchingReasonsProps) {
  if (!reasons || reasons.length === 0) return null;

  const displayReasons = reasons.slice(0, limit);

  if (compact) {
    return (
      <View style={styles.compactContainer}>
        <Ionicons name="sparkles" size={12} color={colors.success} />
        <Text style={styles.compactText} numberOfLines={1}>
          {displayReasons.join(' • ')}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Почему этот мастер:</Text>
      {displayReasons.map((reason, index) => (
        <View key={index} style={styles.reasonRow}>
          <Ionicons name="checkmark" size={14} color={colors.success} />
          <Text style={styles.reasonText}>{reason}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    padding: 10,
    backgroundColor: colors.successBg,
    borderRadius: 8,
  },
  title: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.success,
    marginBottom: 4,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
  },
  reasonText: {
    fontSize: 12,
    color: colors.success,
    flex: 1,
  },
  compactContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  compactText: {
    fontSize: 11,
    color: colors.success,
    flex: 1,
  },
});
