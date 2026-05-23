/**
 * Profile edit — universal editable form for the current user/account.
 *
 * Reads current values from AuthContext (user + activeAccount), writes
 * via `PATCH /api/auth/me`. Refreshes AuthContext on success so the
 * change is visible everywhere immediately (public profile, tabs header,
 * provider workbench card etc.).
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput,
  TouchableOpacity, ActivityIndicator, Alert, Platform,
  KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../../src/context/AuthContext';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import { tokens } from '../../src/theme/tokens';

export default function ProfileEditScreen() {
  const router = useRouter();
  const { colors } = useThemeContext();
  // refreshUser() is the canonical reloader after a profile mutation.
  const { user, activeAccount, refreshUser, isLoading: authLoading, isAuthenticated } = useAuth();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const styles = makeStyles(colors);

  // Hydrate from context once it's loaded.
  useEffect(() => {
    if (!user && !activeAccount) return;
    const acc: any = activeAccount;
    const usr: any = user;
    setFirstName(usr?.firstName ?? '');
    setLastName(usr?.lastName ?? '');
    setDisplayName(acc?.displayName ?? '');
    setPhone(usr?.phone ?? '');
  }, [user, activeAccount]);

  const markDirty = useCallback((setter: (v: string) => void) => (val: string) => {
    setter(val);
    setDirty(true);
    setSuccess(false);
    setError(null);
  }, []);

  const onSave = useCallback(async () => {
    setError(null); setSuccess(false); setSaving(true);
    try {
      const body: Record<string, string> = {
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        phone:     phone.trim(),
      };
      if (displayName.trim()) body.displayName = displayName.trim();
      await api.patch('/auth/me', body);
      // Re-read identity from server so every consumer (header, tabs,
      // public-profile screen) sees the new values.
      await refreshUser();
      setDirty(false);
      setSuccess(true);
      // Auto-dismiss success indicator after 2.5s.
      setTimeout(() => setSuccess(false), 2500);
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Не удалось сохранить';
      setError(msg);
    } finally {
      setSaving(false);
    }
  }, [firstName, lastName, displayName, phone, refreshUser]);

  const onBack = useCallback(() => {
    if (!dirty) { router.back(); return; }
    if (Platform.OS === 'web') {
      // Confirm via window.confirm on web.
      // eslint-disable-next-line no-undef
      const ok = (globalThis as any).confirm?.('Изменения не сохранены. Выйти?');
      if (ok) router.back();
      return;
    }
    Alert.alert(
      'Несохранённые изменения',
      'Если выйти сейчас, изменения будут потеряны.',
      [
        { text: 'Остаться', style: 'cancel' },
        { text: 'Выйти', style: 'destructive', onPress: () => router.back() },
      ],
    );
  }, [dirty, router]);

  if (authLoading) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.centered}><ActivityIndicator color={colors.primary} /></View>
      </SafeAreaView>
    );
  }

  if (!isAuthenticated) {
    return (
      <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.centered}>
          <Ionicons name="lock-closed-outline" size={42} color={colors.textSecondary} />
          <Text style={[styles.guestTitle, { color: colors.text }]}>Войдите, чтобы редактировать профиль</Text>
          <TouchableOpacity
            testID="profile-edit-login-cta"
            style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 16 }]}
            onPress={() => router.push('/auth/login' as any)}
            activeOpacity={0.85}
          >
            <Text style={[styles.primaryBtnText, { color: colors.onPrimary ?? '#000' }]}>Войти</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: colors.background }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          testID="profile-edit-back"
          onPress={onBack}
          style={[styles.iconBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Ionicons name="chevron-back" size={20} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Редактировать профиль</Text>
        <View style={{ width: 38 }} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {/* Live preview of the public name */}
        <View style={[styles.previewCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.previewLabel, { color: colors.textSecondary }]}>Превью</Text>
          <Text style={[styles.previewName, { color: colors.text }]} numberOfLines={2}>
            {displayName.trim() || `${firstName.trim()} ${lastName.trim()}`.trim() || '—'}
          </Text>
          {user?.email && (
            <Text style={[styles.previewMeta, { color: colors.textSecondary }]} numberOfLines={1}>
              {user.email}
            </Text>
          )}
        </View>

        {/* Block 1: Personal */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>Личные данные</Text>

        <Field
          label="Имя"
          value={firstName}
          onChangeText={markDirty(setFirstName)}
          placeholder="Сергей"
          colors={colors}
          testID="profile-edit-firstName"
        />
        <Field
          label="Фамилия"
          value={lastName}
          onChangeText={markDirty(setLastName)}
          placeholder="Мастеров"
          colors={colors}
          testID="profile-edit-lastName"
        />
        <Field
          label="Телефон"
          value={phone}
          onChangeText={markDirty(setPhone)}
          placeholder="+49 30 1234567"
          colors={colors}
          keyboardType="phone-pad"
          testID="profile-edit-phone"
        />

        {/* Block 2: Public identity (mirrors activeAccount.displayName) */}
        <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginTop: 18 }]}>
          Публичное имя
        </Text>
        <Text style={[styles.sectionHint, { color: colors.textSecondary }]}>
          Так вас увидят клиенты в каталоге. Если оставить пустым — будет использовано «Имя Фамилия».
        </Text>
        <Field
          label="Отображаемое имя"
          value={displayName}
          onChangeText={markDirty(setDisplayName)}
          placeholder={`${firstName.trim()} ${lastName.trim()}`.trim() || 'Например: Сергей М. — Berlin'}
          colors={colors}
          testID="profile-edit-displayName"
        />

        {/* Status / Error */}
        {error && (
          <View style={[styles.errorBox, { backgroundColor: '#EF44440D', borderColor: '#EF4444' }]}>
            <Ionicons name="alert-circle-outline" size={16} color="#EF4444" />
            <Text style={[styles.errorText, { color: '#EF4444' }]}>{error}</Text>
          </View>
        )}
        {success && (
          <View style={[styles.successBox, { backgroundColor: '#22C55E15', borderColor: '#22C55E' }]}>
            <Ionicons name="checkmark-circle-outline" size={16} color="#22C55E" />
            <Text style={[styles.successText, { color: '#22C55E' }]}>Профиль обновлён</Text>
          </View>
        )}

        {/* Save button */}
        <TouchableOpacity
          testID="profile-edit-save"
          onPress={onSave}
          disabled={!dirty || saving}
          activeOpacity={0.85}
          style={[
            styles.primaryBtn,
            { backgroundColor: dirty && !saving ? colors.primary : (colors.disabled ?? '#3a3a3a'), marginTop: 22 },
          ]}
        >
          {saving ? (
            <ActivityIndicator color={colors.onPrimary ?? '#000'} />
          ) : (
            <>
              <Ionicons name="save-outline" size={16} color={colors.onPrimary ?? '#000'} style={{ marginRight: 6 }} />
              <Text style={[styles.primaryBtnText, { color: colors.onPrimary ?? '#000' }]}>
                {dirty ? 'Сохранить изменения' : 'Сохранено'}
              </Text>
            </>
          )}
        </TouchableOpacity>

        <View style={{ height: 32 }} />
      </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  colors: any;
  keyboardType?: 'default' | 'phone-pad' | 'email-address';
  testID?: string;
}
function Field({ label, value, onChangeText, placeholder, colors, keyboardType = 'default', testID }: FieldProps) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.textSecondary, marginBottom: 6 }}>{label}</Text>
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        keyboardType={keyboardType}
        autoCapitalize="words"
        style={{
          backgroundColor: colors.card,
          borderColor: colors.border,
          borderWidth: 1,
          borderRadius: 10,
          paddingHorizontal: 14,
          paddingVertical: Platform.OS === 'ios' ? 13 : 10,
          fontSize: 15,
          color: colors.text,
        }}
      />
    </View>
  );
}

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

function makeStyles(colors: any) {
  return StyleSheet.create({
    safe: { flex: 1 },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    guestTitle: { marginTop: 14, fontSize: 16, fontWeight: '700', textAlign: 'center' },

    header: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
    },
    iconBtn: {
      width: 38, height: 38, borderRadius: 11,
      alignItems: 'center', justifyContent: 'center', borderWidth: 1,
    },
    headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

    body: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40 },

    previewCard: {
      padding: 14, borderRadius: R.md - 2, borderWidth: 1, marginBottom: 18,
    },
    previewLabel: {
      fontSize: 10, fontWeight: '800', letterSpacing: 0.8,
      textTransform: 'uppercase', marginBottom: 4,
    },
    previewName: { fontSize: 18, fontWeight: '800' },
    previewMeta: { fontSize: 12, marginTop: 4 },

    sectionTitle: {
      fontSize: 11, fontWeight: '800', letterSpacing: 0.5,
      textTransform: 'uppercase', marginBottom: 10,
    },
    sectionHint: { fontSize: 11, lineHeight: 16, marginBottom: 12 },

    primaryBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
      paddingVertical: 14, borderRadius: R.sm,
    },
    primaryBtnText: { fontSize: 14, fontWeight: '700' },

    errorBox: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      padding: 10, borderRadius: 10, borderWidth: 1, marginTop: 14,
    },
    errorText: { flex: 1, fontSize: 13, fontWeight: '500' },
    successBox: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      padding: 10, borderRadius: 10, borderWidth: 1, marginTop: 14,
    },
    successText: { flex: 1, fontSize: 13, fontWeight: '600' },
  });
}
