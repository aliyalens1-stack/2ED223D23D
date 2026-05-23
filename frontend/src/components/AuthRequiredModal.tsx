import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

type Props = {
  visible: boolean;
  onClose: () => void;
  reason?: string;
  intent?: 'customer' | 'provider';
};

// Sprint: Mobile Welcome + Auth Role Flow
// Bottom-sheet модалка для protected actions (booking confirm, favorite, review, garage и т.д.)
export function AuthRequiredModal({ visible, onClose, reason, intent = 'customer' }: Props) {
  const router = useRouter();
  const { theme } = useThemeContext();
  const { t } = useTranslation();
  const palette = theme === 'dark' ? DARK : LIGHT;
  const styles = makeStyles(palette);

  const goLogin = () => {
    onClose();
    router.push(intent === 'provider' ? '/login?role=provider' : '/login');
  };

  const goRegister = () => {
    onClose();
    router.push(intent === 'provider' ? '/register?role=provider' : '/register?role=customer');
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={Platform.OS === 'web' ? 'fade' : 'slide'}
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose} testID="auth-required-overlay">
        <Pressable style={styles.card} onPress={() => undefined} testID="auth-required-modal">
          <View style={styles.handle} />
          <View style={styles.iconBubble}>
            <Ionicons name="lock-closed" size={22} color={palette.primary} />
          </View>

          <Text style={styles.title}>{t('auth_required.title')}</Text>
          <Text style={styles.text}>
            {reason || t('auth_required.default_reason')}
          </Text>

          <TouchableOpacity
            style={styles.primaryButton}
            onPress={goLogin}
            activeOpacity={0.9}
            testID="auth-required-login"
          >
            <Text style={styles.primaryText}>{t('auth_required.login')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={goRegister}
            activeOpacity={0.85}
            testID="auth-required-register"
          >
            <Text style={styles.secondaryText}>{t('auth_required.register')}</Text>
          </TouchableOpacity>

          <TouchableOpacity onPress={onClose} testID="auth-required-cancel">
            <Text style={styles.cancelText}>{t('auth_required.later')}</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const LIGHT = {
  bg: 'rgba(15, 15, 16, 0.42)',
  surface: colors.text,
  text: colors.brandText,
  textMuted: colors.textMuted,
  border: colors.border,
  primary: colors.brand,
  onPrimary: colors.text,
  chip: colors.brandSoft,
  handle: colors.border,
};
const DARK = {
  bg: 'rgba(0, 0, 0, 0.62)',
  surface: colors.backgroundSecondary,
  text: colors.text,
  textMuted: colors.textMuted,
  border: colors.border,
  primary: colors.brand,
  onPrimary: colors.text,
  chip: 'rgba(215, 25, 32, 0.18)',
  handle: colors.border,
};

function makeStyles(c: any) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: c.bg,
      justifyContent: 'flex-end',
    },
    card: {
      backgroundColor: c.surface,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      paddingHorizontal: 22,
      paddingTop: 12,
      paddingBottom: 32,
      maxWidth: 480,
      width: '100%',
      alignSelf: 'center',
    },
    handle: {
      alignSelf: 'center',
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.handle,
      marginBottom: 18,
    },
    iconBubble: {
      width: 48,
      height: 48,
      borderRadius: 16,
      backgroundColor: c.chip,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 14,
    },
    title: {
      color: c.text,
      fontSize: 22,
      fontWeight: '900',
      letterSpacing: -0.5,
    },
    text: {
      color: c.textMuted,
      fontSize: 15,
      lineHeight: 22,
      marginTop: 8,
      marginBottom: 20,
    },
    primaryButton: {
      backgroundColor: c.primary,
      borderRadius: 16,
      paddingVertical: 16,
      marginBottom: 10,
    },
    primaryText: {
      color: c.onPrimary,
      textAlign: 'center',
      fontSize: 16,
      fontWeight: '900',
    },
    secondaryButton: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      paddingVertical: 16,
      marginBottom: 12,
    },
    secondaryText: {
      color: c.text,
      textAlign: 'center',
      fontSize: 16,
      fontWeight: '900',
    },
    cancelText: {
      color: c.textMuted,
      textAlign: 'center',
      fontSize: 15,
      fontWeight: '700',
      paddingVertical: 8,
    },
  });
}
