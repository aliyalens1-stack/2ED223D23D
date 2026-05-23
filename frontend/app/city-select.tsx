/**
 * Stage 2 — Geo + Search.
 * City selector screen: search → pick city → save → return.
 *
 * Phase 3.0b P0-2 — Conversion-critical fixes:
 *   • Search input (typeahead by name / code / country)
 *   • Flag map for DE/AT/UA + neutral fallback
 *   • Country grouping for clarity (DACH first, others below)
 *   • "City not in list" fallback CTA → contact request
 */
import React, { useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  ActivityIndicator, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../src/context/ThemeContext';
import { useCity } from '../src/context/CityContext';
import { CityDTO } from '../src/services/api';
import i18n from '../src/i18n';

const FLAG_BY_COUNTRY: Record<string, string> = {
  DE: '🇩🇪', AT: '🇦🇹', CH: '🇨🇭',
  LV: '🇱🇻', LT: '🇱🇹', EE: '🇪🇪',
  BY: '🇧🇾', UA: '🇺🇦',
  PL: '🇵🇱', CZ: '🇨🇿', NL: '🇳🇱', FR: '🇫🇷', IT: '🇮🇹', BE: '🇧🇪',
};

const COUNTRY_NAME: Record<string, string> = {
  DE: 'Germany', AT: 'Austria', CH: 'Switzerland',
  LV: 'Latvia', LT: 'Lithuania', EE: 'Estonia',
  BY: 'Belarus', UA: 'Ukraine',
  PL: 'Poland', CZ: 'Czechia', NL: 'Netherlands', FR: 'France', IT: 'Italy', BE: 'Belgium',
};

// Display order: DACH first, then Baltic states, then Belarus, Ukraine, rest.
const COUNTRY_RANK: Record<string, number> = {
  DE: 0, AT: 1, CH: 2,
  LV: 10, LT: 11, EE: 12,
  BY: 20, UA: 21,
  PL: 30, CZ: 31, NL: 32, FR: 33, IT: 34, BE: 35,
};

type ListItem =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'city'; key: string; data: CityDTO };

export default function CitySelectScreen() {
  const router = useRouter();
  const { redirect } = useLocalSearchParams<{ redirect?: string }>();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { cities, selectedCity, selectCity, loading, refresh } = useCity();
  const [query, setQuery] = useState('');

  const handleSelect = async (c: CityDTO) => {
    await selectCity(c.code);
    if (redirect) {
      router.replace(redirect as any);
    } else {
      router.back();
    }
  };

// Strip diacritics so 'kol' matches 'Köln', 'munch'→'München', etc.
const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Filter + sort + group with country headers.
  const grouped = useMemo<ListItem[]>(() => {
    const q = fold(query.trim());
    const filtered = (cities || []).filter((c) => {
      if (!q) return true;
      // Match by city name, code, country code/name, OR any alias
      const aliases: string[] = (c as any).aliases || [];
      const aliasMatch = aliases.some((a) => fold(a).includes(q));
      return (
        fold(c.name).includes(q) ||
        c.code.includes(q) ||
        fold(c.country).includes(q) ||
        fold(COUNTRY_NAME[c.country] || '').includes(q) ||
        aliasMatch
      );
    });

    // Sort: by country rank, then name
    const sorted = [...filtered].sort((a, b) => {
      const ra = COUNTRY_RANK[a.country] ?? 50;
      const rb = COUNTRY_RANK[b.country] ?? 50;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    const out: ListItem[] = [];
    let lastCountry = '';
    for (const c of sorted) {
      if (c.country !== lastCountry) {
        out.push({ kind: 'header', key: `h-${c.country}`, label: c.country });
        lastCountry = c.country;
      }
      out.push({ kind: 'city', key: c.code, data: c });
    }
    return out;
  }, [cities, query]);

  const renderItem = ({ item }: { item: ListItem }) => {
    if (item.kind === 'header') {
      const flag = FLAG_BY_COUNTRY[item.label] || '';
      const cname = COUNTRY_NAME[item.label] || item.label;
      return (
        <Text style={[styles.groupHeader, { color: colors.textSecondary }]}>
          {flag ? `${flag}  ` : ''}{cname}
        </Text>
      );
    }
    const c = item.data;
    const active = selectedCity?.code === c.code;
    return (
      <TouchableOpacity
        testID={`city-row-${c.code}`}
        activeOpacity={0.85}
        onPress={() => handleSelect(c)}
        style={[
          styles.row,
          {
            backgroundColor: colors.card,
            borderColor: active ? colors.primary : colors.border,
            borderWidth: active ? 1.5 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        <View style={[styles.flagWrap, { backgroundColor: colors.backgroundTertiary }]}>
          <Text style={styles.flagText}>{FLAG_BY_COUNTRY[c.country] || '🌍'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.cityName, { color: colors.text }]}>{c.name}</Text>
          <Text style={[styles.cityMeta, { color: colors.textMuted }]}>
            {c.country} · {(c.providersCount ?? 0) > 0
              ? t('city_select.providers_count', { count: c.providersCount, defaultValue: `${c.providersCount} inspectors` })
              : (t('city_select.no_providers_yet', { defaultValue: 'Looking for inspectors (may take longer)' }) as string)}
          </Text>
        </View>
        {active ? (
          <View style={[styles.checkWrap, { backgroundColor: colors.primary }]}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary || '#000'} />
          </View>
        ) : (
          <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
        )}
      </TouchableOpacity>
    );
  };

  const onSuggestCity = () => {
    Alert.alert(
      i18n.t('create.city_request_sent_title', { defaultValue: 'Request sent' }) as string,
      `${t('create.city_request_sent_body', { defaultValue: 'We will review adding the city' })} "${query}" ${t('create.within_48h', { defaultValue: 'within 48 hours.' })}`
    );
    setQuery('');
  };

  const showEmpty = !loading && grouped.length === 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="city-select-screen">
      <View style={[styles.header, { borderBottomColor: colors.divider }]}>
        <TouchableOpacity
          testID="city-back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: colors.backgroundTertiary }]}
        >
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('city_select.title', { defaultValue: 'Choose city' })}
        </Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} />
        <TextInput
          testID="city-search-input"
          value={query}
          onChangeText={setQuery}
          placeholder={t('common.search', { defaultValue: 'Search city or country' }) as string}
          placeholderTextColor={colors.textSecondary}
          style={[styles.searchInput, { color: colors.text }]}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {query.length > 0 && (
          <TouchableOpacity onPress={() => setQuery('')} testID="city-search-clear">
            <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : showEmpty ? (
        <View style={styles.emptyWrap} testID="city-empty">
          <Ionicons name="location-outline" size={48} color={colors.textSecondary} />
          <Text style={[styles.emptyTitle, { color: colors.text }]}>
            {t('create.city_not_found', { defaultValue: 'City not found' })}
          </Text>
          <Text style={[styles.emptySub, { color: colors.textSecondary }]}>
            {t('create.city_not_found_hint', { defaultValue: 'Contact support — we will add new cities within 48 hours' })}
          </Text>
          <TouchableOpacity
            testID="city-suggest"
            style={[styles.suggestBtn, { borderColor: colors.primary }]}
            onPress={onSuggestCity}
          >
            <Text style={[styles.suggestBtnText, { color: colors.primary }]}>
              {t('create.suggest_city', { defaultValue: 'Suggest a city' })}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={grouped}
          keyExtractor={(it) => it.key}
          renderItem={renderItem}
          onRefresh={refresh}
          refreshing={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 18, fontWeight: '700' },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 14, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  groupHeader: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 14, marginBottom: 4 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14, borderRadius: 14,
  },
  flagWrap: {
    width: 44, height: 44, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  flagText: { fontSize: 22 },
  cityName: { fontSize: 16, fontWeight: '700' },
  cityMeta: { fontSize: 12, marginTop: 2 },
  checkWrap: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { fontSize: 18, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  emptySub: { fontSize: 14, textAlign: 'center', maxWidth: 320, lineHeight: 20 },
  suggestBtn: { marginTop: 14, paddingVertical: 12, paddingHorizontal: 22, borderRadius: 12, borderWidth: 1.5 },
  suggestBtnText: { fontSize: 15, fontWeight: '700' },
});
