/**
 * Sprint 11 — Customer Intelligence Hub
 * Aggregates 5 intelligence endpoints into the mobile home screen as action-oriented blocks.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { customerAPI, api } from '../services/api';
import { useTranslation } from 'react-i18next';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;
type Props = {
  colors: any;
};

export default function IntelligenceHub({ colors }: Props) {
  const router = useRouter();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [activeBooking, setActiveBooking] = useState<any>(null);
  const [repeat, setRepeat] = useState<any[]>([]);
  const [favorites, setFavorites] = useState<any[]>([]);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [garage, setGarage] = useState<any[]>([]);
  const [zoneSurge, setZoneSurge] = useState<any>(null);
  const [missedCount, setMissedCount] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rep, fav, rec, gar, zones, bk, hist] = await Promise.all([
        customerAPI.getRepeatOptions().catch(() => ({ data: { options: [] } })),
        customerAPI.getFavorites().catch(() => ({ data: { favorites: [] } })),
        customerAPI.getRecommendations().catch(() => ({ data: { recommendations: [] } })),
        customerAPI.getGarageRecommendations().catch(() => ({ data: { recommendations: [] } })),
        api.get('/zones/live-state').catch(() => ({ data: { zones: [] } })),
        api.get('/bookings/my').catch(() => ({ data: { items: [] } })),
        customerAPI.getHistorySummary().catch(() => ({ data: null })),
      ]);

      const repList = (rep.data as any)?.options || (rep.data as any)?.items || [];
      const favList = (fav.data as any)?.favorites || (fav.data as any)?.items || [];
      const recList = (rec.data as any)?.recommendations || [];
      const garList = (gar.data as any)?.recommendations || (gar.data as any)?.items || [];
      const zList =
        (zones.data as any)?.zones || (zones.data as any) || [];
      const bkList = Array.isArray(bk.data)
        ? bk.data
        : (bk.data as any)?.items || [];

      setRepeat(repList.slice(0, 4));
      setFavorites(favList.slice(0, 4));
      setRecommendations(recList.slice(0, 3));
      setGarage(garList.slice(0, 3));

      const active = bkList.find((b: any) =>
        ['pending', 'confirmed', 'on_route', 'arrived', 'in_progress'].includes(b.status),
      );
      setActiveBooking(active);

      const top = [...(zList as any[])]
        .filter((z) => z?.status === 'SURGE' || z?.status === 'CRITICAL')
        .sort((a, b) => (b.ratio || 0) - (a.ratio || 0))[0];
      setZoneSurge(top);

      // Pressure UX — missed bookings signal
      const h = hist.data as any;
      setMissedCount(h?.cancelled || h?.missed || 0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  if (loading && !activeBooking && !repeat.length && !favorites.length) {
    return (
      <View style={[styles.loaderWrap, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  return (
    <View testID="intelligence-hub" style={{ paddingHorizontal: 16 }}>
      {/* Active booking hero */}
      {activeBooking && (
        <TouchableOpacity
          testID="active-booking-card"
          onPress={() => router.push(`/booking/${activeBooking._id || activeBooking.id}`)}
          style={[styles.heroCard, { backgroundColor: colors.primary }]}
          activeOpacity={0.85}
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.heroLabel}>{t('intel.active_booking_label')}</Text>
            <Text style={styles.heroTitle}>
              {activeBooking.serviceName || t('intel.booking_default')}
            </Text>
            <Text style={styles.heroMeta}>{t('intel.status_prefix')}: {activeBooking.status}</Text>
          </View>
          <Ionicons name="arrow-forward" size={22} color="#fff" />
        </TouchableOpacity>
      )}

      {/* Pressure / opportunity */}
      {zoneSurge && (
        <TouchableOpacity
          testID="zone-opportunity"
          onPress={() => router.push('/auto-request/choose')}
          style={styles.opportunityCard}
          activeOpacity={0.85}
        >
          <View style={styles.opportunityIcon}>
            <Ionicons name="flame" size={18} color={colors.warning} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.opportunityTitle}>
              {t('intel.zone_status_template', { zone: zoneSurge.name || zoneSurge.id, status: zoneSurge.status })}
            </Text>
            <Text style={styles.opportunitySub}>
              {t('intel.zone_status_sub', { eta: String(zoneSurge.avgEta || '—') })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.warning} />
        </TouchableOpacity>
      )}

      {/* 🔁 Repeat */}
      {repeat.length > 0 && (
        <Section title={`🔁 ${t('intel.repeat_section')}`}>
          {repeat.map((r: any, i: number) => (
            <TouchableOpacity
              key={i}
              testID={`repeat-${i}`}
              onPress={async () => {
                try {
                  await customerAPI.createRepeatBooking({
                    providerId: r.providerId || r._id || r.organizationId,
                    serviceId: r.serviceId || r.service?._id,
                    vehicleId: r.vehicleId,
                  });
                  router.push('/(tabs)/quotes');
                } catch {}
              }}
              style={styles.row}
              activeOpacity={0.7}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {r.serviceName || r.service?.name || t('intel.service_default')}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {r.providerName || r.provider?.name || ''}
                  {r.lastBookingDate &&
                    ` · ${new Date(r.lastBookingDate).toLocaleDateString()}`}
                </Text>
              </View>
              <Text style={styles.rowAction}>
                {r.price ? `€${r.price}` : t('intel.repeat_btn')}
              </Text>
            </TouchableOpacity>
          ))}
        </Section>
      )}

      {/* ⭐ Favorites */}
      {favorites.length > 0 && (
        <Section title={`⭐ ${t('intel.favorites_section')}`}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {favorites.map((f: any, i: number) => (
              <TouchableOpacity
                key={i}
                testID={`favorite-${i}`}
                onPress={() => router.push(`/organization/${f.slug || f._id}`)}
                style={styles.favCard}
                activeOpacity={0.8}
              >
                <Text style={styles.favName} numberOfLines={1}>
                  {f.name || f.providerName || '—'}
                </Text>
                <View style={styles.favMetaRow}>
                  <Ionicons name="star" size={12} color={colors.warning} />
                  <Text style={styles.favRating}>
                    {f.rating || f.ratingAvg || '—'}
                  </Text>
                  {f.isOnline && <View style={styles.onlineDot} />}
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </Section>
      )}

      {/* 🛠 Garage recs */}
      {garage.length > 0 && (
        <Section title={`🛠 ${t('intel.car_recs_section')}`}>
          {garage.map((g: any, i: number) => (
            <View key={i} testID={`garage-${i}`} style={styles.row}>
              <Ionicons
                name="build-outline"
                size={18}
                color={colors.brand}
                style={{ marginRight: 10 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {g.title || g.serviceName || g.type}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {g.reason || g.description || ''}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => router.push('/auto-request/choose')}
                style={styles.secondaryBtn}
              >
                <Text style={styles.secondaryBtnText}>{t('intel.find_btn')}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </Section>
      )}

      {/* 🎯 Unified recommendations */}
      {recommendations.length > 0 && (
        <Section title={`🎯 ${t('intel.for_you_section')}`}>
          {recommendations.map((rec: any, i: number) => (
            <View key={i} testID={`rec-${i}`} style={styles.row}>
              <Ionicons
                name="sparkles-outline"
                size={18}
                color={colors.brand}
                style={{ marginRight: 10 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {rec.title || rec.name || rec.serviceName || t('intel.rec_default')}
                </Text>
                <Text style={styles.rowSub} numberOfLines={2}>
                  {rec.reason || rec.description || ''}
                </Text>
              </View>
            </View>
          ))}
        </Section>
      )}

      {/* Pressure — empty state or missed bookings */}
      {!activeBooking && missedCount > 0 && (
        <View style={styles.pressureCard} testID="pressure-missed">
          <Ionicons name="time-outline" size={18} color={colors.brand} />
          <Text style={styles.pressureText}>
            {t('intel.missed_template', { n: missedCount })}
          </Text>
        </View>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 20 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  loaderWrap: { paddingVertical: 20, alignItems: 'center' },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 20,
    marginTop: 8,
    marginBottom: 4,
  },
  heroLabel: { color: '#fff', fontSize: 10, opacity: 0.85, letterSpacing: 1.2 },
  heroTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 4 },
  heroMeta: { color: '#fff', opacity: 0.85, fontSize: 12, marginTop: 4 },
  opportunityCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    backgroundColor: colors.warningBg,
    borderWidth: 1,
    borderColor: colors.warningBg,
    borderRadius: 16,
    marginTop: 12,
  },
  opportunityIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.warningBg,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  opportunityTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  opportunitySub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.border,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  rowAction: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.brand,
    marginLeft: 8,
  },
  favCard: {
    width: 140,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 14,
    marginRight: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  favName: { fontSize: 13, fontWeight: '700', color: colors.text },
  favMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  favRating: { fontSize: 12, color: colors.textMuted, marginLeft: 4 },
  onlineDot: {
    marginLeft: 'auto',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.success,
  },
  secondaryBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: colors.brandSoft,
  },
  secondaryBtnText: { fontSize: 12, fontWeight: '700', color: colors.brand },
  pressureCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.brandSoft,
    borderWidth: 1,
    borderColor: colors.brandSoft,
    marginTop: 18,
  },
  pressureText: {
    flex: 1,
    color: colors.brand,
    fontSize: 13,
    fontWeight: '600',
    marginLeft: 8,
  },
});
