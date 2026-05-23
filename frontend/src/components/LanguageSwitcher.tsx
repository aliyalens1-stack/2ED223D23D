/**
 * LanguageSwitcher (mobile)
 * Compact pill button → opens a modal sheet with N selectable languages.
 * Scales naturally for any number of locales (registry in `src/i18n/index.ts`).
 */
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, FlatList } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { LANGUAGES, setAppLanguage, type AppLang } from '../i18n';
import { useThemeContext } from '../context/ThemeContext';

export default function LanguageSwitcher({ compact = true }: { compact?: boolean }) {
  const { i18n } = useTranslation();
  const { colors } = useThemeContext();
  const [open, setOpen] = useState(false);

  const current = (i18n.language || 'de').split('-')[0] as AppLang;
  const currentMeta = LANGUAGES.find((l) => l.code === current) ?? LANGUAGES[0];

  const handlePick = async (code: AppLang) => {
    setOpen(false);
    if (code !== current) await setAppLanguage(code);
  };

  return (
    <>
      <TouchableOpacity
        testID="lang-switcher"
        activeOpacity={0.8}
        onPress={() => setOpen(true)}
        style={[
          styles.pill,
          { backgroundColor: colors.card, borderColor: colors.border },
          !compact && { paddingHorizontal: 14, paddingVertical: 8 },
        ]}
      >
        <Text style={styles.flag}>{currentMeta.flag}</Text>
        <Text style={[styles.label, { color: colors.text }]}>{currentMeta.label}</Text>
        <Ionicons name="chevron-down" size={12} color={colors.textSecondary} style={{ marginLeft: 2 }} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        testID="lang-modal"
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.sheetTitle, { color: colors.textSecondary }]}>Language</Text>
            <FlatList
              data={LANGUAGES}
              keyExtractor={(item) => item.code}
              renderItem={({ item }) => {
                const active = item.code === current;
                return (
                  <TouchableOpacity
                    testID={`lang-${item.code}`}
                    activeOpacity={0.7}
                    onPress={() => handlePick(item.code)}
                    style={[
                      styles.row,
                      { borderColor: colors.border },
                      active && { backgroundColor: 'rgba(245,184,0,0.10)' },
                    ]}
                  >
                    <Text style={styles.rowFlag}>{item.flag}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.rowName, { color: colors.text }]}>{item.name}</Text>
                      <Text style={[styles.rowCode, { color: colors.textSecondary }]}>{item.label}</Text>
                    </View>
                    {active && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                  </TouchableOpacity>
                );
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 999,
  },
  flag: { fontSize: 14 },
  label: { fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  sheet: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 18,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  sheetTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: 8,
    paddingTop: 4,
    paddingBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    gap: 12,
  },
  rowFlag: { fontSize: 22 },
  rowName: { fontSize: 15, fontWeight: '700' },
  rowCode: { fontSize: 11, marginTop: 2, letterSpacing: 0.6 },
});
