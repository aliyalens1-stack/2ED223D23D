import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Switch,
} from 'react-native';
import i18n from '../../src/i18n';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';
import { useAuth } from '../../src/context/AuthContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

const DAYS = [
  { key: 'monday', label: i18n.t('provider.ponedelnik'), short: i18n.t('provider.pn') },
  { key: 'tuesday', label: i18n.t('provider.vtornik'), short: i18n.t('provider.vt') },
  { key: 'wednesday', label: i18n.t('provider.sreda'), short: i18n.t('provider.sr') },
  { key: 'thursday', label: i18n.t('provider.chetverg'), short: i18n.t('provider.cht') },
  { key: 'friday', label: i18n.t('provider.pyatnica'), short: i18n.t('provider.pt') },
  { key: 'saturday', label: i18n.t('provider.subbota'), short: i18n.t('provider.sb') },
  { key: 'sunday', label: i18n.t('provider.voskresene'), short: i18n.t('provider.vs') },
];

const TIME_SLOTS = [
  '08:00', '09:00', '10:00', '11:00', '12:00', '13:00',
  '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00',
];

export default function AvailabilityScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [availability, setAvailability] = useState<Record<string, { enabled: boolean; start: string; end: string }>>(
    DAYS.reduce((acc, d) => ({
      ...acc,
      [d.key]: { enabled: d.key !== 'sunday', start: '09:00', end: '18:00' },
    }), {})
  );
  const [exceptions, setExceptions] = useState<any[]>([]);

  useEffect(() => {
    fetchAvailability();
  }, []);

  const fetchAvailability = async () => {
    try {
      const res = await api.get('/provider/availability');
      if (res.data?.schedule) {
        const schedule = res.data.schedule;
        const newAvail = { ...availability };
        DAYS.forEach((d) => {
          if (schedule[d.key]) {
            newAvail[d.key] = {
              enabled: schedule[d.key].isWorking !== false,
              start: schedule[d.key].start || '09:00',
              end: schedule[d.key].end || '18:00',
            };
          }
        });
        setAvailability(newAvail);
      }
      if (res.data?.exceptions) {
        setExceptions(res.data.exceptions);
      }
    } catch (error) {
      console.log('Using default availability');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleDay = (dayKey: string) => {
    setAvailability((prev) => ({
      ...prev,
      [dayKey]: { ...prev[dayKey], enabled: !prev[dayKey].enabled },
    }));
  };

  const handleTimeChange = (dayKey: string, type: 'start' | 'end', value: string) => {
    setAvailability((prev) => ({
      ...prev,
      [dayKey]: { ...prev[dayKey], [type]: value },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const schedule = DAYS.reduce((acc, d) => ({
        ...acc,
        [d.key]: {
          isWorking: availability[d.key].enabled,
          start: availability[d.key].start,
          end: availability[d.key].end,
        },
      }), {});

      await api.put('/provider/availability', { schedule });
      Alert.alert(i18n.t('provider.uspeshno'), i18n.t('provider.raspisanie_sohraneno'));
    } catch (error) {
      Alert.alert(i18n.t('chat.oshibka'), i18n.t('provider.ne_udalos_sohranit_raspisanie'));
    } finally {
      setSaving(false);
    }
  };

  if (!user || (user.role !== 'provider_owner' && user.role !== 'provider_manager')) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>{t('provider.raspisanie')}</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={styles.authPrompt}>
          <Ionicons name="calendar-outline" size={64} color={colors.textMuted} />
          <Text style={styles.authTitle}>{t('provider.tolko_dlya_vladelcev_sto')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>{t('provider.raspisanie_raboty')}</Text>
        <TouchableOpacity onPress={handleSave} style={styles.saveBtn} disabled={saving}>
          {saving ? (
            <ActivityIndicator color={colors.text} size="small" />
          ) : (
            <Text style={styles.saveBtnText}>{t('provider.sohranit')}</Text>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content}>
        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
        ) : (
          <>
            <Text style={styles.sectionTitle}>{t('provider.rabochie_dni')}</Text>
            {DAYS.map((day) => (
              <View key={day.key} style={styles.dayCard}>
                <View style={styles.dayHeader}>
                  <View style={styles.dayInfo}>
                    <View style={[styles.dayBadge, availability[day.key].enabled && styles.dayBadgeActive]}>
                      <Text style={[styles.dayShort, availability[day.key].enabled && styles.dayShortActive]}>
                        {day.short}
                      </Text>
                    </View>
                    <Text style={styles.dayLabel}>{day.label}</Text>
                  </View>
                  <Switch
                    value={availability[day.key].enabled}
                    onValueChange={() => handleToggleDay(day.key)}
                    trackColor={{ false: colors.border, true: colors.brand }}
                    thumbColor={colors.text}
                  />
                </View>
                {availability[day.key].enabled && (
                  <View style={styles.timeRow}>
                    <View style={styles.timeSelect}>
                      <Text style={styles.timeLabel}>{t('provider.s')}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {TIME_SLOTS.slice(0, 10).map((t) => (
                          <TouchableOpacity
                            key={t}
                            style={[styles.timeChip, availability[day.key].start === t && styles.timeChipActive]}
                            onPress={() => handleTimeChange(day.key, 'start', t)}
                          >
                            <Text style={[styles.timeChipText, availability[day.key].start === t && styles.timeChipTextActive]}>
                              {t}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                    <View style={styles.timeSelect}>
                      <Text style={styles.timeLabel}>{t('provider.do')}</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {TIME_SLOTS.slice(3).map((t) => (
                          <TouchableOpacity
                            key={t}
                            style={[styles.timeChip, availability[day.key].end === t && styles.timeChipActive]}
                            onPress={() => handleTimeChange(day.key, 'end', t)}
                          >
                            <Text style={[styles.timeChipText, availability[day.key].end === t && styles.timeChipTextActive]}>
                              {t}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  </View>
                )}
              </View>
            ))}

            {/* Exceptions */}
            <Text style={styles.sectionTitle}>{t('provider.isklyucheniya_vyhodnye')}</Text>
            <View style={styles.exceptionsCard}>
              {exceptions.length === 0 ? (
                <View style={styles.emptyExceptions}>
                  <Ionicons name="calendar-outline" size={32} color={colors.textMuted} />
                  <Text style={styles.emptyText}>{t('provider.net_dobavlennyh_isklyuchenij')}</Text>
                </View>
              ) : (
                exceptions.map((exc, idx) => (
                  <View key={idx} style={styles.exceptionItem}>
                    <Text style={styles.exceptionDate}>
                      {new Date(exc.date).toLocaleDateString('ru-RU')}
                    </Text>
                    <Text style={styles.exceptionReason}>{exc.reason || t('provider.vyhodnoj')}</Text>
                  </View>
                ))
              )}
              <TouchableOpacity style={styles.addExceptionBtn}>
                <Ionicons name="add" size={20} color={colors.brand} />
                <Text style={styles.addExceptionText}>{t('provider.dobavit_isklyuchenie')}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  backBtn: {
    width: 44, height: 44, borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  title: { fontSize: 18, fontWeight: '600', color: colors.text },
  saveBtn: {
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10,
    backgroundColor: colors.primary,
  },
  saveBtnText: { fontSize: 14, fontWeight: '600', color: colors.onPrimary },
  content: { flex: 1, paddingHorizontal: 16 },
  sectionTitle: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    marginTop: 24, marginBottom: 12, textTransform: 'uppercase',
  },
  dayCard: {
    backgroundColor: colors.backgroundTertiary, borderRadius: 14,
    padding: 14, marginBottom: 10,
  },
  dayHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  dayInfo: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  dayBadge: {
    width: 36, height: 36, borderRadius: 8,
    backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  dayBadgeActive: { backgroundColor: colors.primary },
  dayShort: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
  dayShortActive: { color: colors.text },
  dayLabel: { fontSize: 16, color: colors.text },
  timeRow: { marginTop: 12 },
  timeSelect: { marginBottom: 8 },
  timeLabel: { fontSize: 12, color: colors.textMuted, marginBottom: 6 },
  timeChip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8,
    backgroundColor: colors.border, marginRight: 6,
  },
  timeChipActive: { backgroundColor: colors.primary },
  timeChipText: { fontSize: 13, color: colors.onPrimaryMuted },
  timeChipTextActive: { color: colors.text, fontWeight: '600' },
  exceptionsCard: {
    backgroundColor: colors.backgroundTertiary, borderRadius: 14, padding: 16,
  },
  emptyExceptions: { alignItems: 'center', paddingVertical: 20 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 8 },
  exceptionItem: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.05)',
  },
  exceptionDate: { fontSize: 14, color: colors.text },
  exceptionReason: { fontSize: 14, color: colors.textMuted },
  addExceptionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 12, marginTop: 8,
  },
  addExceptionText: { fontSize: 14, color: colors.brand, fontWeight: '500' },
  authPrompt: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  authTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16 },
});
