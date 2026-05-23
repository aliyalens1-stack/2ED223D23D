// BrandPickerModal — searchable bottom-sheet style modal for picking a car brand.
// Used by /auto-request/create.tsx (selection flow). Replaces the bare TextInput
// that previously required typing the brand by hand.
//
// Contract:
//   value          — currently selected brand id ('' if none)
//   onSelect(id)   — fires with the brand id (lowercase) on tap
//   visible / onClose — controlled visibility
//
// The modal exposes search-as-you-type filtering and shows the country flag for
// quick recognition. Country flag map kept local to avoid coupling to other code.
import React, { useMemo, useState } from 'react';
import {
  Modal,
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { CAR_BRANDS, searchBrands, CarBrand } from '../constants/carCatalogue';

const FLAGS: Record<string, string> = {
  DE: '🇩🇪', AT: '🇦🇹', FR: '🇫🇷', IT: '🇮🇹', GB: '🇬🇧', SE: '🇸🇪',
  CZ: '🇨🇿', ES: '🇪🇸', RO: '🇷🇴', JP: '🇯🇵', KR: '🇰🇷', US: '🇺🇸',
  CN: '🇨🇳', NL: '🇳🇱',
};

export type BrandPickerModalProps = {
  visible: boolean;
  value: string;
  onSelect: (brandId: string, brandName: string) => void;
  onClose: () => void;
  colors: any;
};

export default function BrandPickerModal({ visible, value, onSelect, onClose, colors }: BrandPickerModalProps) {
  const [query, setQuery] = useState('');

  const data = useMemo(() => searchBrands(query), [query]);

  const handlePick = (brand: CarBrand) => {
    onSelect(brand.id, brand.name);
    setQuery('');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="brand-picker-modal">
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>Выбор марки</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="brand-picker-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Ionicons name="search" size={18} color={colors.textSecondary} />
          <TextInput
            testID="brand-picker-search"
            value={query}
            onChangeText={setQuery}
            placeholder="Введите марку (BMW, Mercedes, …)"
            placeholderTextColor={colors.textSecondary}
            style={[styles.searchInput, { color: colors.text }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>

        {/* List */}
        <FlatList
          data={data}
          keyExtractor={(b) => b.id}
          contentContainerStyle={{ paddingVertical: 8 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const selected = item.id === value;
            return (
              <TouchableOpacity
                testID={`brand-item-${item.id}`}
                onPress={() => handlePick(item)}
                style={[
                  styles.row,
                  { borderBottomColor: colors.border, backgroundColor: selected ? 'rgba(245,184,0,0.10)' : 'transparent' },
                ]}
                activeOpacity={0.7}
              >
                <Text style={styles.flag}>{item.country ? FLAGS[item.country] || '🌐' : '🌐'}</Text>
                <Text style={[styles.brandName, { color: colors.text }]}>{item.name}</Text>
                {selected && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <Ionicons name="search" size={32} color={colors.textSecondary} />
              <Text style={[styles.emptyTxt, { color: colors.textSecondary }]}>
                Марок не найдено. Попробуйте другой запрос.
              </Text>
            </View>
          }
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'ios' ? 8 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  closeBtn: { padding: 4 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 8,
    paddingHorizontal: 12,
    height: 48,
    borderRadius: 12,
    borderWidth: 1,
  },
  searchInput: { flex: 1, fontSize: 16, paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flag: { fontSize: 22 },
  brandName: { flex: 1, fontSize: 16, fontWeight: '600' },
  emptyBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, gap: 12 },
  emptyTxt: { fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
});
