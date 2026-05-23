/**
 * auto-request — horizontal scrolling chip selector.
 *
 * Used for urgency (inspection flow), fuel + transmission (selection flow).
 * Driven by `{ value, labelKey }[]` options — labelKey resolves via i18n.
 * `allowClear` lets a re-tap on the active chip clear the value (used for
 * optional filters like fuel/transmission).
 */
import React from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { styles } from './styles';
import type { ColorsLike } from './types';

export type ChipOption = { value: string; labelKey?: string; label?: string };

interface Props {
  options: ReadonlyArray<ChipOption>;
  value: string;
  onChange: (next: string) => void;
  colors: ColorsLike;
  testIdPrefix: string;
  allowClear?: boolean;
}

export function ChipRow({ options, value, onChange, colors, testIdPrefix, allowClear }: Props) {
  const { t } = useTranslation();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <TouchableOpacity
            key={o.value}
            testID={`${testIdPrefix}-${o.value}`}
            onPress={() => onChange(allowClear && active ? '' : o.value)}
            style={[
              styles.chip,
              {
                backgroundColor: active ? colors.primary : colors.card,
                borderColor: active ? colors.primary : colors.border,
              },
            ]}
          >
            <Text style={[styles.chipText, { color: active ? '#FFF' : colors.text }]}>
              {o.labelKey ? (t(o.labelKey) as string) : o.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}
