// ModelPickerModal — searchable bottom-sheet for picking a model after the brand
// is chosen. Loads models from the local catalogue keyed by brand id. If the
// brand has no entries in the catalogue (rare brand), falls back to a free-form
// text input UI so the user can still proceed.
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
import { searchModels, CAR_MODELS } from '../constants/carCatalogue';

export type ModelPickerModalProps = {
  visible: boolean;
  brandId: string;     // lowercase brand id
  brandName: string;
  value: string;       // currently selected model name
  onSelect: (model: string) => void;
  onClose: () => void;
  colors: any;
};

export default function ModelPickerModal({
  visible, brandId, brandName, value, onSelect, onClose, colors,
}: ModelPickerModalProps) {
  const [query, setQuery] = useState('');
  const [customInput, setCustomInput] = useState('');

  const data = useMemo(() => searchModels(brandId, query), [brandId, query]);
  const hasCatalogue = !!CAR_MODELS[brandId];

  const handlePick = (model: string) => {
    onSelect(model);
    setQuery('');
    setCustomInput('');
    onClose();
  };

  const handleCustomSubmit = () => {
    const v = customInput.trim();
    if (v.length === 0) return;
    handlePick(v);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.container, { backgroundColor: colors.background }]} testID="model-picker-modal">
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: colors.text }]}>Выбор модели</Text>
            {brandName ? <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{brandName}</Text> : null}
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="model-picker-close">
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        {/* When brand has catalogue → show search + list. Otherwise → free-form input. */}
        {hasCatalogue ? (
          <>
            <View style={[styles.searchBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="search" size={18} color={colors.textSecondary} />
              <TextInput
                testID="model-picker-search"
                value={query}
                onChangeText={setQuery}
                placeholder="Найти модель…"
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

            <FlatList
              data={data}
              keyExtractor={(m) => m}
              contentContainerStyle={{ paddingVertical: 8 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const selected = item === value;
                return (
                  <TouchableOpacity
                    testID={`model-item-${item.replace(/\s+/g, '-').toLowerCase()}`}
                    onPress={() => handlePick(item)}
                    activeOpacity={0.7}
                    style={[
                      styles.row,
                      { borderBottomColor: colors.border, backgroundColor: selected ? 'rgba(245,184,0,0.10)' : 'transparent' },
                    ]}
                  >
                    <Text style={[styles.modelName, { color: colors.text }]}>{item}</Text>
                    {selected && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={
                <View style={styles.emptyBox}>
                  <Ionicons name="search" size={32} color={colors.textSecondary} />
                  <Text style={[styles.emptyTxt, { color: colors.textSecondary }]}>
                    Не нашли в списке? Введите модель вручную ниже.
                  </Text>
                </View>
              }
              ListFooterComponent={
                <View style={[styles.footer, { borderTopColor: colors.border }]}>
                  <Text style={[styles.footerLabel, { color: colors.textSecondary }]}>
                    Не нашли свою модель?
                  </Text>
                  <View style={[styles.customBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    <TextInput
                      testID="model-picker-custom-input"
                      value={customInput}
                      onChangeText={setCustomInput}
                      placeholder="Введите свою модель"
                      placeholderTextColor={colors.textSecondary}
                      style={[styles.customInput, { color: colors.text }]}
                      onSubmitEditing={handleCustomSubmit}
                      returnKeyType="done"
                    />
                    <TouchableOpacity
                      testID="model-picker-custom-submit"
                      onPress={handleCustomSubmit}
                      disabled={customInput.trim().length === 0}
                      style={[styles.addBtn, { backgroundColor: customInput.trim().length === 0 ? colors.border : colors.primary }]}
                    >
                      <Ionicons name="checkmark" size={20} color={customInput.trim().length === 0 ? colors.textSecondary : '#000'} />
                    </TouchableOpacity>
                  </View>
                </View>
              }
            />
          </>
        ) : (
          <View style={{ padding: 20 }}>
            <Text style={[styles.footerLabel, { color: colors.textSecondary, marginBottom: 8 }]}>
              Для марки {brandName || 'этой'} список моделей не найден. Введите модель вручную:
            </Text>
            <View style={[styles.customBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TextInput
                testID="model-picker-custom-input-only"
                value={customInput}
                onChangeText={setCustomInput}
                placeholder="Например: Roma"
                placeholderTextColor={colors.textSecondary}
                style={[styles.customInput, { color: colors.text }]}
                autoFocus
                onSubmitEditing={handleCustomSubmit}
                returnKeyType="done"
              />
              <TouchableOpacity
                testID="model-picker-custom-submit-only"
                onPress={handleCustomSubmit}
                disabled={customInput.trim().length === 0}
                style={[styles.addBtn, { backgroundColor: customInput.trim().length === 0 ? colors.border : colors.primary }]}
              >
                <Ionicons name="checkmark" size={20} color={customInput.trim().length === 0 ? colors.textSecondary : '#000'} />
              </TouchableOpacity>
            </View>
          </View>
        )}
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
  subtitle: { fontSize: 13, fontWeight: '600', marginTop: 2 },
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
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modelName: { fontSize: 16, fontWeight: '600' },
  emptyBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40, gap: 12 },
  emptyTxt: { fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },
  footer: { padding: 20, borderTopWidth: StyleSheet.hairlineWidth, marginTop: 8 },
  footerLabel: { fontSize: 13, fontWeight: '600' },
  customBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
  },
  customInput: { flex: 1, fontSize: 16, paddingVertical: 8 },
  addBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
