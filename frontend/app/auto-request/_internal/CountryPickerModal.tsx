/**
 * auto-request — Geo-1 canonical country picker modal.
 *
 * Replaces the legacy hardcoded country chips. Data comes from
 * /api/geo/countries (canonical /geo namespace). Selecting a country
 * cascades into the city picker (CitiesPickerModal filters by ISO-2 code).
 */
import React from 'react';
import { FlatList, Modal, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import type { ColorsLike, Country } from './types';

interface Props {
  visible: boolean;
  onClose: () => void;
  countries: Country[];
  selected: string;
  onSelect: (code: string) => void;
  colors: ColorsLike;
}

export function CountryPickerModal({ visible, onClose, countries, selected, onSelect, colors }: Props) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>
              {t('create.label_country') || 'Select country'}
            </Text>
            <TouchableOpacity onPress={onClose} style={styles.modalCloseBtn} testID="country-modal-close">
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>
          <FlatList
            data={countries}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const active = item.code === selected;
              return (
                <TouchableOpacity
                  testID={`country-row-${item.code}`}
                  onPress={() => { onSelect(item.code); onClose(); }}
                  style={[
                    styles.countryRow,
                    {
                      backgroundColor: active ? (colors.brandSoft || colors.card) : colors.background,
                      borderColor: active ? (colors.brand || colors.primary) : colors.border,
                    },
                  ]}
                >
                  <Text style={{ fontSize: 22, marginRight: 12 }}>{item.flag}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.countryRowName, { color: colors.text }]}>{item.name}</Text>
                    <Text style={[styles.countryRowMeta, { color: colors.textSecondary }]}>
                      {item.cityCount} {item.cityCount === 1 ? 'city' : 'cities'} · {item.currency}
                    </Text>
                  </View>
                  {active && <Ionicons name="checkmark-circle" size={22} color={colors.brand || colors.primary} />}
                </TouchableOpacity>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}
