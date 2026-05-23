/**
 * Регистрация партнёра — СТО / подборщика / автосалона / автомойки.
 *
 * Поток:
 *   1. Партнёр выбирает тип (workshop / inspector / dealer / carwash)
 *   2. Заполняет имя/email/пароль/телефон + город
 *   3. Ставит точку на карте: автоматически (expo-location) или вручную
 *   4. POST /api/marketplace/partner/register → создаётся org с
 *      status=pending_verification + запись в verification_queue
 *   5. После approve администратором org.status станет 'active' и метка
 *      покажется на публичной /map.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  ActivityIndicator, Alert, Platform, KeyboardAvoidingView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { useThemeContext } from '../src/context/ThemeContext';
import { api } from '../src/services/api';
import MapLocationPicker from '../src/components/map/MapLocationPicker';
import { PARTNER_KINDS, PartnerKind } from '../src/lib/map/kinds';

const KIND_OPTIONS = PARTNER_KINDS;
type Kind = PartnerKind;

export default function PartnerRegisterScreen() {
  const { colors } = useThemeContext();
  const router = useRouter();

  const [kind, setKind] = useState<Kind>('workshop');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState<string>('');
  const [lng, setLng] = useState<string>('');
  const [cities, setCities] = useState<any[]>([]);
  const [locLoading, setLocLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState<null | { organizationId: string; message: string }>(null);

  useEffect(() => {
    api.get('/cities').then(r => setCities(r.data?.cities || r.data || [])).catch(() => {});
  }, []);

  const requestGps = async () => {
    setLocLoading(true);
    try {
      if (Platform.OS === 'web') {
        // expo-location uses navigator.geolocation under the hood on web.
        const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
          if (!navigator.geolocation) return reject(new Error('no geolocation'));
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000 });
        });
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
      } else {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Доступ к локации', 'Разрешите доступ к геолокации или введите координаты вручную.');
          return;
        }
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
      }
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось получить координаты. Введите вручную.');
    } finally {
      setLocLoading(false);
    }
  };

  const useCityCenter = (cityCode: string) => {
    const c = cities.find((x: any) => x.code === cityCode);
    if (c) {
      setLat(String(c.lat));
      setLng(String(c.lng));
      setCity(cityCode);
    }
  };

  const submit = async () => {
    if (!name || !email || !password || !city || !lat || !lng) {
      Alert.alert('Ошибка', 'Заполните все обязательные поля и поставьте точку на карте.');
      return;
    }
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN) || latN < -90 || latN > 90 || lngN < -180 || lngN > 180) {
      Alert.alert('Ошибка', 'Некорректные координаты.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await api.post('/marketplace/partner/register', {
        name, email: email.toLowerCase().trim(), password, phone: phone || undefined,
        kind, city, address: address || undefined, lat: latN, lng: lngN,
      });
      setSubmitted({ organizationId: r.data.organizationId, message: r.data.message });
    } catch (e: any) {
      const msg = e?.response?.data?.detail || e?.message || 'Не удалось отправить заявку';
      Alert.alert('Ошибка', String(msg));
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
        <View style={styles.successWrap} testID="partner-register-success">
          <Ionicons name="checkmark-circle" size={84} color="#10b981" />
          <Text style={[styles.successTitle, { color: colors.text }]}>Заявка отправлена</Text>
          <Text style={[styles.successText, { color: colors.textMuted }]}>
            {submitted.message}
          </Text>
          <Text style={[styles.successId, { color: colors.textMuted }]} selectable>
            ID организации: {submitted.organizationId}
          </Text>
          <TouchableOpacity
            testID="partner-register-done"
            onPress={() => router.replace('/(tabs)')}
            style={[styles.primaryBtn, { backgroundColor: colors.primary, marginTop: 24 }]}
          >
            <Text style={[styles.primaryBtnText, { color: '#000' }]}>Понятно</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} edges={['top']}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 }}>
          <View style={styles.header}>
            <TouchableOpacity testID="partner-register-back" onPress={() => router.back()} style={[styles.backBtn, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Ionicons name="chevron-back" size={20} color={colors.text} />
            </TouchableOpacity>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Стать партнёром</Text>
            <View style={{ width: 36 }} />
          </View>

          <Text style={[styles.section, { color: colors.text }]}>1. Кто вы?</Text>
          <View style={styles.kindGrid}>
            {KIND_OPTIONS.map(opt => {
              const selected = kind === opt.kind;
              return (
                <TouchableOpacity
                  key={opt.kind}
                  testID={`partner-kind-${opt.kind}`}
                  onPress={() => setKind(opt.kind)}
                  activeOpacity={0.8}
                  style={[
                    styles.kindCard,
                    { backgroundColor: selected ? opt.color : colors.card, borderColor: selected ? opt.color : colors.border },
                  ]}
                >
                  <Text style={styles.kindEmoji}>{opt.emoji}</Text>
                  <Text style={[styles.kindLabel, { color: selected ? '#000' : colors.text }]}>{opt.label}</Text>
                  <Text style={[styles.kindSub, { color: selected ? '#0a0a0a' : colors.textMuted }]}>{opt.sub}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.section, { color: colors.text }]}>2. Контакты</Text>
          <View style={styles.fieldsGroup}>
            <TextInput testID="partner-name"  style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Название организации *"  placeholderTextColor={colors.textMuted} value={name}  onChangeText={setName} />
            <TextInput testID="partner-email" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Email *"               placeholderTextColor={colors.textMuted} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
            <TextInput testID="partner-password" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Пароль (мин. 6 симв.) *" placeholderTextColor={colors.textMuted} value={password} onChangeText={setPassword} secureTextEntry />
            <TextInput testID="partner-phone" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Телефон"               placeholderTextColor={colors.textMuted} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          </View>

          <Text style={[styles.section, { color: colors.text }]}>3. Где вы работаете</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cityRow}>
            {cities.slice(0, 40).map((c: any) => {
              const sel = city === c.code;
              return (
                <TouchableOpacity key={c.code} testID={`partner-city-${c.code}`} onPress={() => useCityCenter(c.code)} style={[styles.cityChip, { backgroundColor: sel ? colors.primary : colors.card, borderColor: sel ? colors.primary : colors.border }]}>
                  <Text style={[styles.cityChipText, { color: sel ? '#000' : colors.text }]}>{c.name}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          <TextInput testID="partner-address" style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.card, marginTop: 8 }]} placeholder="Адрес (улица, дом)" placeholderTextColor={colors.textMuted} value={address} onChangeText={setAddress} />

          <Text style={[styles.section, { color: colors.text }]}>4. Геолокация (кликните по карте, чтобы поставить точку)</Text>
          <View style={{ paddingHorizontal: 16, marginBottom: 8 }}>
            <MapLocationPicker
              testID="partner-location-picker"
              value={{ lat: Number(lat) || 52.52, lng: Number(lng) || 13.41 }}
              onChange={(p) => { setLat(p.lat.toFixed(6)); setLng(p.lng.toFixed(6)); }}
              height={280}
            />
          </View>
          <View style={styles.gpsRow}>
            <TextInput testID="partner-lat" style={[styles.input, { flex: 1, color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Широта *"  placeholderTextColor={colors.textMuted} value={lat} onChangeText={setLat} keyboardType="numbers-and-punctuation" />
            <TextInput testID="partner-lng" style={[styles.input, { flex: 1, color: colors.text, borderColor: colors.border, backgroundColor: colors.card }]} placeholder="Долгота *" placeholderTextColor={colors.textMuted} value={lng} onChangeText={setLng} keyboardType="numbers-and-punctuation" />
          </View>
          <TouchableOpacity testID="partner-use-gps" onPress={requestGps} style={[styles.secondaryBtn, { borderColor: colors.border }]}>
            {locLoading ? <ActivityIndicator color={colors.text} /> : <>
              <Ionicons name="locate" size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Использовать моё текущее местоположение</Text>
            </>}
          </TouchableOpacity>
          <Text style={[styles.gpsHint, { color: colors.textMuted }]}>
            После одобрения администратором метка появится на публичной карте.
          </Text>

          <TouchableOpacity testID="partner-submit" onPress={submit} disabled={submitting} style={[styles.primaryBtn, { backgroundColor: colors.primary, opacity: submitting ? 0.6 : 1 }]}>
            {submitting ? <ActivityIndicator color="#000" /> : <Text style={[styles.primaryBtnText, { color: '#000' }]}>Отправить на верификацию</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12 },
  backBtn: { width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  section: { fontSize: 15, fontWeight: '700', marginTop: 18, marginBottom: 10, paddingHorizontal: 16 },
  kindGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 8 },
  kindCard: { width: '47%', borderRadius: 14, borderWidth: 1, padding: 14 },
  kindEmoji: { fontSize: 28, marginBottom: 6 },
  kindLabel: { fontSize: 16, fontWeight: '800' },
  kindSub: { fontSize: 12, marginTop: 2 },
  fieldsGroup: { paddingHorizontal: 16, gap: 10 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  cityRow: { paddingHorizontal: 14, gap: 8, paddingVertical: 4 },
  cityChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 18, borderWidth: 1, marginRight: 6 },
  cityChipText: { fontSize: 13, fontWeight: '600' },
  gpsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  secondaryBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginHorizontal: 16, marginTop: 10, padding: 12, borderRadius: 12, borderWidth: 1 },
  secondaryBtnText: { fontSize: 14, fontWeight: '600' },
  gpsHint: { fontSize: 12, paddingHorizontal: 16, marginTop: 8 },
  primaryBtn: { marginHorizontal: 16, marginTop: 22, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  primaryBtnText: { fontSize: 16, fontWeight: '800' },
  successWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  successTitle: { fontSize: 22, fontWeight: '800', marginTop: 14 },
  successText: { fontSize: 14, marginTop: 8, textAlign: 'center', lineHeight: 20 },
  successId: { fontSize: 11, marginTop: 12 },
});
