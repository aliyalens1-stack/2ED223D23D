/**
 * auto-request — city dropdown row.
 *
 * Visual row that opens `CityPickerModal`. Used by both forms.
 * Multi-city pre-selection (selection flow) shows comma-joined names.
 */
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import { Hint, Label } from './primitives';
import type { ColorsLike } from './types';

interface Props {
  colors: ColorsLike;
  text: string;
  onPress: () => void;
  selected: boolean;
  hint?: string;
}

export function CityField({ colors, text, onPress, selected, hint }: Props) {
  const { t } = useTranslation();
  return (
    <>
      <Label colors={colors}>{t('create.label_city') || 'City *'}</Label>
      <TouchableOpacity
        testID="create-city-field"
        activeOpacity={0.8}
        onPress={onPress}
        style={[styles.input, styles.cityField, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <Ionicons name="location-outline" size={18} color={colors.textSecondary} />
        <Text
          style={[styles.cityFieldText, { color: selected ? colors.text : colors.textSecondary }]}
          numberOfLines={1}
        >
          {text}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </TouchableOpacity>
      {hint && <Hint colors={colors}>{hint}</Hint>}
    </>
  );
}
