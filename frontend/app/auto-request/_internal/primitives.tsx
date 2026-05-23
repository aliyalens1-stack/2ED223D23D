/**
 * auto-request — micro UI primitives (Label, Hint, MetaChip).
 *
 * Used by both forms (`InspectionForm`, `SelectionForm`) and the
 * `LinkPreview` card. Single-line stateless components — no business
 * logic, no i18n, just typography + spacing tokens.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import { lpStyles } from './lpStyles';
import type { ColorsLike } from './types';

export function Label({ colors, children }: { colors: ColorsLike; children: React.ReactNode }) {
  return <Text style={[styles.label, { color: colors.text }]}>{children}</Text>;
}

export function Hint({ colors, children }: { colors: ColorsLike; children: React.ReactNode }) {
  return <Text style={[styles.hint, { color: colors.textSecondary }]}>{children}</Text>;
}

/**
 * Small inline chip used by `LinkPreview` to render meta facts
 * (year · km · fuel · location).
 */
export function MetaChip({
  icon,
  text,
  colors,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  text: string;
  colors: ColorsLike;
}) {
  return (
    <View style={[lpStyles.metaChip, { backgroundColor: 'rgba(127,127,127,0.10)' }]}>
      <Ionicons name={icon} size={12} color={colors.textSecondary} />
      <Text style={[lpStyles.metaChipTxt, { color: colors.textSecondary }]}>{text}</Text>
    </View>
  );
}
