/**
 * auto-request — City picker modal.
 *
 * Searchable list grouped by country. Honors cascade from the Country
 * picker: when `countryFilter` is set, only that country's cities are
 * shown. Multi-select mode used by `selection` flow; single-select mode
 * (auto-close on tap) used by `inspection` flow.
 */
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, ScrollView, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import { FLAG_BY_COUNTRY } from './constants';
import type { City, ColorsLike } from './types';

interface Props {
  visible: boolean;
  onClose: () => void;
  allCities: City[];
  loading: boolean;
  selected: string[];
  onChange: (next: string[], pickedCountry?: string) => void;
  multi: boolean;
  colors: ColorsLike;
  countryFilter?: string | null;
}

export function CityPickerModal({
  visible, onClose, allCities, loading, selected, onChange, multi, colors, countryFilter,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const filtered = useMemo(() => {
    const byCountry = countryFilter
      ? allCities.filter((c) => c.country === countryFilter)
      : allCities;
    const q = fold(query.trim());
    if (!q) return byCountry;
    return byCountry.filter(
      (c) =>
        fold(c.name).includes(q) ||
        c.code.includes(q) ||
        fold(c.country).includes(q) ||
        (c.aliases || []).some((alias) => fold(alias).includes(q)),
    );
  }, [allCities, query, countryFilter]);

  const grouped = useMemo(() => {
    const map: Record<string, City[]> = {};
    for (const c of filtered) {
      const cc = c.country || '??';
      (map[cc] ||= []).push(c);
    }
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const toggle = (city: City) => {
    const isOn = selected.includes(city.name);
    let next: string[];
    if (multi) {
      next = isOn ? selected.filter((s) => s !== city.name) : [...selected, city.name];
    } else {
      next = isOn ? [] : [city.name];
    }
    onChange(next, city.country);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
        <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={onClose} testID="city-modal-close">
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.modalTitle, { color: colors.text }]}>{t('create.modal_pick_city') || 'Choose city'}</Text>
          <View style={{ width: 26 }} />
        </View>

        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="search" size={18} color={colors.textSecondary} />
          <TextInput
            testID="city-modal-search"
            value={query}
            onChangeText={setQuery}
            placeholder={t('common.search') || 'Search'}
            placeholderTextColor={colors.textSecondary}
            style={[styles.searchInput, { color: colors.text }]}
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : grouped.length === 0 ? (
          <View style={styles.modalEmpty} testID="city-modal-empty">
            <Text style={[styles.modalEmptyTitle, { color: colors.text }]}>{t('create.city_not_found') || 'City not found'}</Text>
            <Text style={[styles.modalEmptySub, { color: colors.textSecondary }]}>
              {t('create.city_not_found_hint') || 'Contact support — we will add new cities within 48 hours'}
            </Text>
            <TouchableOpacity
              testID="city-suggest-btn"
              style={[styles.suggestBtn, { borderColor: colors.primary }]}
              onPress={() => {
                Alert.alert(
                  t('create.city_request_sent_title') || 'Request sent',
                  `${t('create.city_request_sent_body') || 'We will review adding the city'} "${query}" ${t('create.within_48h') || 'within 48 hours.'}`,
                );
                onClose();
              }}
            >
              <Text style={[styles.suggestBtnText, { color: colors.primary }]}>{t('create.suggest_city') || 'Suggest a city'}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
            {grouped.map(([cc, items]) => {
              const flag = FLAG_BY_COUNTRY[cc] || '🌍';
              return (
                <View key={cc}>
                  <Text style={[styles.groupTitle, { color: colors.textSecondary }]}>
                    {flag}  {cc}
                  </Text>
                  {items.map((c) => {
                    const isOn = selected.includes(c.name);
                    return (
                      <TouchableOpacity
                        key={c.code}
                        testID={`city-option-${c.code}`}
                        onPress={() => toggle(c)}
                        style={[styles.cityRow, { borderBottomColor: colors.border }]}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.cityName, { color: colors.text }]}>{c.name}</Text>
                          {typeof c.providersCount === 'number' && (
                            <Text style={[styles.cityMeta, { color: colors.textSecondary }]}>
                              {c.providersCount > 0
                                ? `${c.providersCount} ${t('create.inspectors_count') || 'inspectors'}`
                                : (t('create.inspectors_searching') || 'Looking for inspectors (may take longer)')}
                            </Text>
                          )}
                        </View>
                        <View
                          style={[
                            styles.checkbox,
                            {
                              borderColor: isOn ? colors.primary : colors.border,
                              backgroundColor: isOn ? colors.primary : 'transparent',
                            },
                          ]}
                        >
                          {isOn && <Ionicons name="checkmark" size={16} color="#FFF" />}
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              );
            })}
            {multi && (
              <TouchableOpacity
                testID="city-modal-done"
                style={[styles.doneBtn, { backgroundColor: colors.primary }]}
                onPress={onClose}
              >
                <Text style={styles.doneBtnText}>
                  {t('common.confirm') || 'Done'} ({selected.length})
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}
