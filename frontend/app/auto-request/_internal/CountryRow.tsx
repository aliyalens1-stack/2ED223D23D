/**
 * auto-request — country dropdown row.
 *
 * Visual row that opens `CountryPickerModal`. Selected country is
 * shown with flag + display name pulled from canonical /api/geo/countries.
 */
import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import { Label } from './primitives';
import type { ColorsLike, Country } from './types';

interface Props {
  colors: ColorsLike;
  country: string;
  geoCountries: Country[];
  openCountryModal: () => void;
}

export function CountryRow({ colors, country, geoCountries, openCountryModal }: Props) {
  const { t } = useTranslation();
  const current = geoCountries.find((c) => c.code === country);
  return (
    <>
      <Label colors={colors}>{t('create.label_country') || 'Country'}</Label>
      <TouchableOpacity
        testID="create-country-dropdown"
        activeOpacity={0.8}
        onPress={openCountryModal}
        style={[styles.input, styles.cityField, { backgroundColor: colors.card, borderColor: colors.border }]}
      >
        <Text style={{ fontSize: 18 }}>{current?.flag || '🌍'}</Text>
        <Text
          style={[styles.cityFieldText, { color: current ? colors.text : colors.textSecondary }]}
          numberOfLines={1}
        >
          {current ? current.name : (t('create.country_placeholder') || 'Select country')}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </TouchableOpacity>
    </>
  );
}
