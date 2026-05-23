/**
 * Security / 2FA setup screen — Sprint 2FA.
 * Authenticated user enables / disables TOTP, sees recovery codes.
 *
 * Available to ALL roles (admin / inspector / customer). Backend gates
 * are role-agnostic — anyone can opt-in to 2FA.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator,
  ScrollView, Image, Alert, Clipboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useThemeContext } from '../src/context/ThemeContext';
import api from '../src/services/api';

type Status = { enabled: boolean; createdAt?: string; lastVerifiedAt?: string; recoveryCodesRemaining: number };
type SetupStart = { secret: string; otpauthUri: string; qrPngBase64: string; issuer: string; account: string };

export default function TwoFactorSetupScreen() {
  const { colors } = useThemeContext();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);

  // setup flow state
  const [setup, setSetup] = useState<SetupStart | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // disable flow state
  const [showDisable, setShowDisable] = useState(false);
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get('/auth/2fa/status');
      setStatus(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Не удалось загрузить статус 2FA');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const startSetup = useCallback(async () => {
    setError(''); setBusy(true);
    try {
      const r = await api.post('/auth/2fa/setup/start', {});
      setSetup(r.data);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Ошибка инициализации 2FA');
    } finally { setBusy(false); }
  }, []);

  const confirmSetup = useCallback(async () => {
    if (code.length !== 6) { setError('Введите 6-значный код'); return; }
    setError(''); setBusy(true);
    try {
      const r = await api.post('/auth/2fa/setup/confirm', { code });
      setRecoveryCodes(r.data.recoveryCodes);
      setSetup(null);
      setCode('');
      await loadStatus();
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Неверный код');
    } finally { setBusy(false); }
  }, [code, loadStatus]);

  const doDisable = useCallback(async () => {
    if (!password) { setError('Введите пароль'); return; }
    if (disableCode.length !== 6) { setError('Введите 6-значный код'); return; }
    setError(''); setBusy(true);
    try {
      await api.post('/auth/2fa/disable', { password, code: disableCode });
      setShowDisable(false);
      setPassword(''); setDisableCode('');
      await loadStatus();
      Alert.alert('Готово', 'Двухфакторная аутентификация выключена');
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Не удалось выключить 2FA');
    } finally { setBusy(false); }
  }, [password, disableCode, loadStatus]);

  const copyAll = useCallback(() => {
    if (!recoveryCodes) return;
    Clipboard.setString(recoveryCodes.join('\n'));
    Alert.alert('Скопировано', '10 кодов восстановления — сохраните их в надёжном месте');
  }, [recoveryCodes]);

  // ── render ───────────────────────────────────────────────────────────
  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.brand || colors.primary} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="security-2fa-screen">
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={{ padding: 8 }} testID="2fa-setup-back">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Безопасность · 2FA</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        {/* ── recovery codes display (one-time) ── */}
        {recoveryCodes ? (
          <View style={[styles.card, { backgroundColor: colors.card }]} testID="2fa-recovery-list">
            <View style={[styles.successBadge, { backgroundColor: '#22C55E22' }]}>
              <Ionicons name="checkmark-circle" size={20} color="#22C55E" />
              <Text style={[styles.successText, { color: '#22C55E' }]}>2FA включена</Text>
            </View>
            <Text style={[styles.title, { color: colors.text, marginTop: 12 }]}>Коды восстановления</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              Сохраните эти 10 кодов в надёжном месте (1Password, бумажный носитель). Каждый код можно использовать только один раз. Они помогут войти, если потеряете доступ к Google Authenticator.
            </Text>
            <View style={[styles.codesBox, { borderColor: colors.border }]}>
              {recoveryCodes.map((c, i) => (
                <Text key={c} style={[styles.codeLine, { color: colors.text }]}>{String(i + 1).padStart(2, '0')}.  {c}</Text>
              ))}
            </View>
            <TouchableOpacity onPress={copyAll} style={[styles.btnPrimary, { backgroundColor: colors.primary }]} testID="2fa-copy-recovery">
              <Ionicons name="copy-outline" size={16} color={colors.onPrimary || '#000'} />
              <Text style={[styles.btnPrimaryText, { color: colors.onPrimary || '#000' }]}>Скопировать все коды</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setRecoveryCodes(null)} style={[styles.btnGhost, { borderColor: colors.border }]} testID="2fa-recovery-done">
              <Text style={[styles.btnGhostText, { color: colors.text }]}>Я сохранил коды</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── enabled state (and no recovery overlay) ── */}
        {!recoveryCodes && status?.enabled ? (
          <View style={[styles.card, { backgroundColor: colors.card }]} testID="2fa-enabled-card">
            <View style={[styles.iconBig, { backgroundColor: '#22C55E20' }]}>
              <Ionicons name="shield-checkmark" size={32} color="#22C55E" />
            </View>
            <Text style={[styles.title, { color: colors.text }]}>2FA включена</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              При каждом входе в Auto Search потребуется 6-значный код из Google Authenticator.
            </Text>
            <Text style={[styles.meta, { color: colors.textMuted || colors.textSecondary }]}>
              Кодов восстановления осталось: {status.recoveryCodesRemaining}
            </Text>
            {showDisable ? (
              <View style={{ width: '100%', gap: 10, marginTop: 12 }}>
                <TextInput
                  testID="2fa-disable-password"
                  secureTextEntry
                  placeholder="Текущий пароль"
                  placeholderTextColor={colors.textMuted || colors.textSecondary}
                  value={password}
                  onChangeText={setPassword}
                  style={[styles.input, { borderColor: colors.border, color: colors.text }]}
                />
                <TextInput
                  testID="2fa-disable-code"
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="Код из приложения (6 цифр)"
                  placeholderTextColor={colors.textMuted || colors.textSecondary}
                  value={disableCode}
                  onChangeText={(v) => setDisableCode(v.replace(/\D/g, '').slice(0, 6))}
                  style={[styles.input, { borderColor: colors.border, color: colors.text, textAlign: 'center', letterSpacing: 6, fontWeight: '700' }]}
                />
                {error ? <Text style={[styles.err, { color: '#EF4444' }]}>{error}</Text> : null}
                <TouchableOpacity onPress={doDisable} disabled={busy} style={[styles.btnDanger, { backgroundColor: '#EF4444', opacity: busy ? 0.6 : 1 }]} testID="2fa-disable-submit">
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={[styles.btnPrimaryText, { color: '#fff' }]}>Выключить 2FA</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setShowDisable(false); setError(''); }} style={[styles.btnGhost, { borderColor: colors.border }]}>
                  <Text style={[styles.btnGhostText, { color: colors.text }]}>Отмена</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => setShowDisable(true)} style={[styles.btnGhost, { borderColor: '#EF4444' }]} testID="2fa-disable-start">
                <Text style={[styles.btnGhostText, { color: '#EF4444' }]}>Выключить 2FA</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : null}

        {/* ── disabled state + setup flow ── */}
        {!recoveryCodes && !status?.enabled ? (
          <View style={[styles.card, { backgroundColor: colors.card }]} testID="2fa-disabled-card">
            {!setup ? (
              <>
                <View style={[styles.iconBig, { backgroundColor: (colors.brand || colors.primary) + '20' }]}>
                  <Ionicons name="lock-closed-outline" size={32} color={colors.brand || colors.primary} />
                </View>
                <Text style={[styles.title, { color: colors.text }]}>Защитите аккаунт</Text>
                <Text style={[styles.body, { color: colors.textSecondary }]}>
                  Включите двухфакторную аутентификацию — при входе понадобится 6-значный код из Google Authenticator, Authy или 1Password. Это защитит от кражи аккаунта, даже если пароль попадёт в чужие руки.
                </Text>
                {error ? <Text style={[styles.err, { color: '#EF4444' }]}>{error}</Text> : null}
                <TouchableOpacity onPress={startSetup} disabled={busy} style={[styles.btnPrimary, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]} testID="2fa-setup-start">
                  {busy ? <ActivityIndicator color={colors.onPrimary || '#000'} /> : <>
                    <Ionicons name="shield-checkmark" size={16} color={colors.onPrimary || '#000'} />
                    <Text style={[styles.btnPrimaryText, { color: colors.onPrimary || '#000' }]}>Включить 2FA</Text>
                  </>}
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={[styles.title, { color: colors.text }]}>1. Отсканируйте QR-код</Text>
                <Text style={[styles.body, { color: colors.textSecondary }]}>
                  Откройте Google Authenticator (Authy, 1Password) → "+" → Сканировать QR
                </Text>
                <View style={styles.qrWrap}>
                  <Image
                    source={{ uri: `data:image/png;base64,${setup.qrPngBase64}` }}
                    style={styles.qr}
                    resizeMode="contain"
                  />
                </View>
                <Text style={[styles.meta, { color: colors.textMuted || colors.textSecondary }]}>Не получается сканировать? Введите вручную:</Text>
                <TouchableOpacity onPress={() => { Clipboard.setString(setup.secret); Alert.alert('Скопировано', 'Секрет скопирован в буфер обмена'); }}>
                  <Text style={[styles.secretCode, { color: colors.text, borderColor: colors.border }]}>{setup.secret}</Text>
                </TouchableOpacity>

                <Text style={[styles.title, { color: colors.text, marginTop: 16 }]}>2. Введите код из приложения</Text>
                <TextInput
                  testID="2fa-setup-code"
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="000000"
                  placeholderTextColor={colors.textMuted || colors.textSecondary}
                  value={code}
                  onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
                  style={[styles.input, { borderColor: colors.border, color: colors.text, textAlign: 'center', fontSize: 26, letterSpacing: 10, fontWeight: '700' }]}
                  autoFocus
                />
                {error ? <Text style={[styles.err, { color: '#EF4444' }]}>{error}</Text> : null}
                <TouchableOpacity onPress={confirmSetup} disabled={busy || code.length !== 6} style={[styles.btnPrimary, { backgroundColor: colors.primary, opacity: (busy || code.length !== 6) ? 0.6 : 1 }]} testID="2fa-setup-confirm">
                  {busy ? <ActivityIndicator color={colors.onPrimary || '#000'} /> : <Text style={[styles.btnPrimaryText, { color: colors.onPrimary || '#000' }]}>Подтвердить и включить</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => { setSetup(null); setCode(''); setError(''); }} style={[styles.btnGhost, { borderColor: colors.border }]}>
                  <Text style={[styles.btnGhostText, { color: colors.text }]}>Отмена</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingVertical: 8, borderBottomWidth: 1 },
  headerTitle: { fontSize: 16, fontWeight: '700' },
  content: { padding: 16 },
  card: { padding: 20, borderRadius: 16, alignItems: 'center', gap: 8 },
  iconBig: { width: 72, height: 72, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', textAlign: 'center' },
  body: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  meta: { fontSize: 12, marginTop: 4 },
  qrWrap: { padding: 12, backgroundColor: '#fff', borderRadius: 12, marginVertical: 12 },
  qr: { width: 220, height: 220 },
  secretCode: { fontFamily: 'monospace', fontSize: 14, fontWeight: '700', letterSpacing: 2, padding: 10, borderRadius: 8, borderWidth: 1, marginVertical: 8 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, width: '100%' },
  btnPrimary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 22, paddingVertical: 13, borderRadius: 12, marginTop: 10, width: '100%' },
  btnPrimaryText: { fontSize: 14, fontWeight: '800' },
  btnGhost: { paddingHorizontal: 22, paddingVertical: 12, borderRadius: 12, marginTop: 8, borderWidth: 1, width: '100%', alignItems: 'center' },
  btnGhostText: { fontSize: 14, fontWeight: '700' },
  btnDanger: { paddingHorizontal: 22, paddingVertical: 13, borderRadius: 12, alignItems: 'center' },
  err: { fontSize: 12, fontWeight: '600', textAlign: 'center', marginTop: 6 },
  successBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 },
  successText: { fontSize: 12, fontWeight: '700' },
  codesBox: { width: '100%', padding: 14, borderRadius: 12, borderWidth: 1, marginTop: 8, gap: 6 },
  codeLine: { fontFamily: 'monospace', fontSize: 14, fontWeight: '700', letterSpacing: 2 },
});
