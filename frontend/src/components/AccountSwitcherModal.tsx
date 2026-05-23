/**
 * Sprint 1E — Account Switcher Modal (Mobile).
 *
 * UX: a sheet listing all accounts the current user owns. Tapping a row that
 * is NOT the active one fires `switchAccount(accountId)`, which in turn calls
 * POST /api/auth/switch-account. The new JWT replaces the stored token; mode
 * derives from `activeAccount.kind` so navigation refreshes for free.
 *
 * NOT a "role switcher" — strings say "Режим работы / Work mode / Modus".
 *
 * Out of 1E scope (deferred to Phase 2A organizations / future): creating
 * new accounts, dealer onboarding, organization-team flows.
 */
import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  Pressable,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuth, AccountView } from '../context/AuthContext';
import { useThemeContext } from '../context/ThemeContext';
import i18n from '../../src/i18n';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const KIND_ICON: Record<string, string> = {
  customer: 'person-circle-outline',
  inspector: 'shield-checkmark-outline',
  admin: 'star-outline',
  service_provider: 'construct-outline',
  dealer: 'business-outline',
  transport: 'car-outline',
};

export default function AccountSwitcherModal({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { accounts, activeAccount, switchAccount } = useAuth();
  const [switching, setSwitching] = useState<string | null>(null);

  const handleSwitch = async (acc: AccountView) => {
    if (acc.id === activeAccount?.id) {
      onClose();
      return;
    }
    setSwitching(acc.id);
    try {
      const next = await switchAccount(acc.id);
      if (next) {
        onClose();
      } else {
        Alert.alert(i18n.t('workMode.error'), i18n.t('workMode.errorDesc'));
      }
    } catch (e: any) {
      Alert.alert(i18n.t('workMode.error'), e?.response?.data?.message || e?.message || String(e));
    } finally {
      setSwitching(null);
    }
  };

  // No accounts → don't even show the sheet (auth state probably loading)
  if (!accounts || accounts.length === 0) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      testID="account-switcher-modal"
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { backgroundColor: colors.surface }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.handle} />
          <Text style={[styles.title, { color: colors.text }]}>
            {t('workMode.title')}
          </Text>
          <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
            {t('workMode.subtitle')}
          </Text>

          <ScrollView style={{ maxHeight: 400 }}>
            {accounts.map((acc) => {
              const isActive = acc.id === activeAccount?.id;
              const isLoading = switching === acc.id;
              const iconName = (KIND_ICON[acc.kind] || 'ellipse-outline') as any;
              return (
                <TouchableOpacity
                  key={acc.id}
                  testID={`account-row-${acc.kind}`}
                  style={[
                    styles.row,
                    {
                      borderColor: isActive ? colors.primary : colors.border,
                      backgroundColor: isActive ? colors.primary + '12' : 'transparent',
                    },
                  ]}
                  onPress={() => handleSwitch(acc)}
                  disabled={!!switching}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={iconName}
                    size={28}
                    color={isActive ? colors.primary : colors.text}
                  />
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: colors.text }]}>
                      {t(`workMode.kind.${acc.kind}`)}
                    </Text>
                    <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
                      {acc.displayName}
                    </Text>
                  </View>
                  {isLoading ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : isActive ? (
                    <View style={[styles.activeBadge, { backgroundColor: colors.primary }]}>
                      <Text style={styles.activeBadgeText}>{t('workMode.active')}</Text>
                    </View>
                  ) : (
                    <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <TouchableOpacity
            style={[styles.cancelBtn, { borderColor: colors.border }]}
            onPress={onClose}
            testID="account-switcher-cancel"
          >
            <Text style={[styles.cancelText, { color: colors.text }]}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    minHeight: 280,
  },
  handle: {
    alignSelf: 'center',
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#888',
    marginBottom: 16,
    opacity: 0.4,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 13,
    marginBottom: 20,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 10,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  rowSub: {
    fontSize: 12,
    marginTop: 2,
  },
  activeBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  activeBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  cancelBtn: {
    marginTop: 14,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
