import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl, Animated, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { providerInboxAPI } from '../../src/services/api';
import { useProviderRealtime } from '../../src/hooks/useWebSocket';
import { theme } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';
const colors = theme.colors;

const { width } = Dimensions.get('window');

interface InboxRequest {
  id: string;
  distributionId: string;
  quoteId?: string;
  customerName: string;
  serviceName: string;
  serviceCategory?: string;
  urgency: 'low' | 'medium' | 'high' | 'critical';
  estimatedPrice?: number;
  distance?: number;
  address?: string;
  expiresAt: string;
  createdAt: string;
  status: string;
}

function CountdownTimer({ expiresAt, colors }: { expiresAt: string; colors: any }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const calc = () => {
      const diff = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setSeconds(diff);
    };
    calc();
    const interval = setInterval(calc, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const isUrgent = seconds < 60;
  const color = isUrgent ? colors.error : seconds < 180 ? colors.warning : colors.success;

  return (
    <View testID="countdown-timer" style={[styles.timerBadge, { backgroundColor: color + '20', borderColor: color }]}>
      <Ionicons name="time-outline" size={14} color={color} />
      <Text style={[styles.timerText, { color }]}>
        {mins}:{secs.toString().padStart(2, '0')}
      </Text>
    </View>
  );
}

function UrgencyBadge({ urgency, colors }: { urgency: string; colors: any }) {
  const config: Record<string, { color: string; label: string; icon: string }> = {
    critical: { color: colors.error, label: i18n.t('provider.srochno'), icon: 'flame' },
    high: { color: colors.warning, label: i18n.t('provider.vysokij'), icon: 'alert-circle' },
    medium: { color: colors.info, label: i18n.t('provider.srednij'), icon: 'time' },
    low: { color: colors.textMuted, label: i18n.t('provider.obychnyj'), icon: 'ellipse' },
  };
  const c = config[urgency] || config.low;
  return (
    <View style={[styles.urgencyBadge, { backgroundColor: c.color + '15' }]}>
      <Ionicons name={c.icon as any} size={12} color={c.color} />
      <Text style={[styles.urgencyText, { color: c.color }]}>{c.label}</Text>
    </View>
  );
}

// ─── Sprint 18: Pre-Engagement Card ───────────────────────────────────
interface PreEngagementEvent {
  id: string;
  zoneId: string;
  zoneName: string;
  pressure: number;
  predictedDemand: number;
  expectedRequests: number;
  potentialEarningsPct: number;
  expiresAt: string;
  createdAt: string;
}

function PreEngagementCard({ event, colors, onAccept }: {
  event: PreEngagementEvent; colors: any; onAccept: (id: string) => void;
}) {
  return (
    <View
      testID={`pre-engage-card-${event.id}`}
      style={[
        styles.preEngageCard,
        { backgroundColor: colors.accentSoft ?? colors.warningBg, borderColor: colors.accent ?? colors.brand },
      ]}
    >
      <View style={styles.preEngageHeader}>
        <View style={[styles.preEngageIcon, { backgroundColor: colors.accent ?? colors.brand }]}>
          <Ionicons name="flash" size={18} color={colors.brandText ?? colors.brandText} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.preEngageTitle, { color: colors.text }]}>
            High demand in {event.zoneName}
          </Text>
          <Text style={[styles.preEngageSubtitle, { color: colors.textSecondary }]}>
            +{event.potentialEarningsPct}% earnings potential · ~{event.expectedRequests} expected requests
          </Text>
        </View>
      </View>
      <TouchableOpacity
        testID={`pre-engage-go-online-${event.id}`}
        onPress={() => onAccept(event.id)}
        style={[styles.preEngageBtn, { backgroundColor: colors.primary }]}
        activeOpacity={0.85}
      >
        <Ionicons name="rocket-outline" size={16} color={colors.onPrimary ?? colors.text} />
        <Text style={[styles.preEngageBtnText, { color: colors.onPrimary ?? colors.text }]}>
          Go online now
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function RequestCard({ item, colors, onAccept, onReject }: {
  item: InboxRequest; colors: any; onAccept: (id: string) => void; onReject: (id: string) => void;
}) {
  const { t } = useTranslation();  const slideAnim = useRef(new Animated.Value(0)).current;

  return (
    <Animated.View style={[styles.card, { backgroundColor: colors.card, transform: [{ translateX: slideAnim }] }]}>
      <View style={styles.cardHeader}>
        <View style={styles.cardHeaderLeft}>
          <UrgencyBadge urgency={item.urgency} colors={colors} />
          {item.expiresAt && <CountdownTimer expiresAt={item.expiresAt} colors={colors} />}
        </View>
        {item.distance && (
          <Text style={[styles.distanceText, { color: colors.textSecondary }]}>
            {item.distance < 1 ? t('provider.math_round_item_distance_1000_m') : t('provider.item_distance_tofixed_1_km')}
          </Text>
        )}
      </View>
      <Text style={[styles.serviceName, { color: colors.text }]}>{item.serviceName || t('provider.avto_servis')}</Text>
      <Text style={[styles.customerName, { color: colors.textSecondary }]}>
        <Ionicons name="person-outline" size={13} color={colors.textSecondary} /> {item.customerName || t('inspector.klient')}
      </Text>
      {item.address && (
        <Text style={[styles.addressText, { color: colors.textMuted }]} numberOfLines={1}>
          <Ionicons name="location-outline" size={13} color={colors.textMuted} /> {item.address}
        </Text>
      )}
      {item.estimatedPrice != null && item.estimatedPrice > 0 && (
        <Text style={[styles.priceText, { color: colors.success }]}>
          ₴{item.estimatedPrice.toLocaleString()}
        </Text>
      )}
      <View style={styles.cardActions}>
        <TouchableOpacity
          testID={`reject-request-${item.distributionId}`}
          style={[styles.rejectBtn, { borderColor: colors.border }]}
          onPress={() => onReject(item.distributionId)}
        >
          <Ionicons name="close" size={20} color={colors.error} />
          <Text style={[styles.rejectText, { color: colors.error }]}>{t('inspector.propustit')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID={`accept-request-${item.distributionId}`}
          style={[styles.acceptBtn, { backgroundColor: colors.success }]}
          onPress={() => onAccept(item.distributionId)}
        >
          <Ionicons name="checkmark" size={20} color="#FFF" />
          <Text style={styles.acceptText}>{t('provider.prinyat')}</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

export default function ProviderInboxScreen() {
  const { t } = useTranslation();
  const { colors } = useThemeContext();
  const { user } = useAuth();
  const router = useRouter();
  const [requests, setRequests] = useState<InboxRequest[]>([]);
  const [pressure, setPressure] = useState<any>(null);
  const [preEngagements, setPreEngagements] = useState<PreEngagementEvent[]>([]);   // Sprint 18
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // resolve provider slug — для MVP берём дефолт "avtomaster-pro" (как в остальном UI),
  // на проде это придёт из user.providerSlug.
  const providerSlug = (user as any)?.providerSlug || 'avtomaster-pro';

  const loadData = useCallback(async () => {
    try {
      const [inboxRes, pressureRes, preEngRes] = await Promise.allSettled([
        providerInboxAPI.getInbox(),
        providerInboxAPI.getPressureSummary(),
        providerInboxAPI.getPreEngagement(providerSlug),
      ]);
      if (inboxRes.status === 'fulfilled') {
        const data = inboxRes.value.data;
        setRequests(Array.isArray(data) ? data : data?.items || []);
      }
      if (pressureRes.status === 'fulfilled') setPressure(pressureRes.value.data);
      if (preEngRes.status === 'fulfilled') {
        setPreEngagements(preEngRes.value.data?.events || []);
      }
    } catch (e) { console.log('Inbox load error:', e); }
    finally { setLoading(false); setRefreshing(false); }
  }, [providerSlug]);

  useEffect(() => { loadData(); const iv = setInterval(loadData, 15000); return () => clearInterval(iv); }, [loadData]);

  // WebSocket: instant notification of new requests
  useProviderRealtime({
    onNewRequest: () => loadData(),
    onRequestTaken: (data) => {
      setRequests(prev => prev.filter(r => r.distributionId !== data.distributionId));
    },
    // Sprint 18: pre-engagement push
    onPreEngage: (data) => {
      setPreEngagements(prev => {
        // prepend, dedupe by id
        const filtered = prev.filter(e => e.id !== data.id);
        return [data, ...filtered].slice(0, 5);
      });
    },
  });

  const handleAcceptPreEngagement = async (eventId: string) => {
    try {
      await providerInboxAPI.acceptPreEngagement(providerSlug, eventId);
      setPreEngagements(prev => prev.filter(e => e.id !== eventId));
      setIsOnline(true);
    } catch (e) { console.log('Pre-engage accept error:', e); }
  };

  const handleAccept = async (distributionId: string) => {
    try {
      await providerInboxAPI.acceptRequest(distributionId);
      setRequests(prev => prev.filter(r => r.distributionId !== distributionId));
      router.push('/provider/current-job');
    } catch (e) { console.log('Accept error:', e); }
  };

  const handleReject = async (distributionId: string) => {
    try {
      await providerInboxAPI.rejectRequest(distributionId, 'skipped');
      setRequests(prev => prev.filter(r => r.distributionId !== distributionId));
    } catch (e) { console.log('Reject error:', e); }
  };

  const toggleOnline = async () => {
    try {
      const newStatus = !isOnline;
      await providerInboxAPI.updatePresence(newStatus);
      setIsOnline(newStatus);
    } catch (e) { console.log('Presence error:', e); }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="provider-inbox-screen">
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} testID="inbox-back-btn">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>{t('provider.vhodyaschie_zayavki')}</Text>
        <TouchableOpacity testID="online-toggle" onPress={toggleOnline}
          style={[styles.onlineBadge, { backgroundColor: isOnline ? colors.success + '20' : colors.error + '20' }]}>
          <View style={[styles.onlineDot, { backgroundColor: isOnline ? colors.success : colors.error }]} />
          <Text style={[styles.onlineText, { color: isOnline ? colors.success : colors.error }]}>
            {isOnline ? 'Online' : 'Offline'}
          </Text>
        </TouchableOpacity>
      </View>

      {pressure && (
        <View style={[styles.pressureBar, { backgroundColor: colors.card }]}>
          <View style={styles.pressureItem}>
            <Text style={[styles.pressureValue, { color: colors.warning }]}>{pressure.missedToday || 0}</Text>
            <Text style={[styles.pressureLabel, { color: colors.textMuted }]}>{t('provider.propuscheno')}</Text>
          </View>
          <View style={[styles.pressureDivider, { backgroundColor: colors.border }]} />
          <View style={styles.pressureItem}>
            <Text style={[styles.pressureValue, { color: colors.success }]}>{pressure.acceptedToday || 0}</Text>
            <Text style={[styles.pressureLabel, { color: colors.textMuted }]}>{t('inspector.prinyato')}</Text>
          </View>
          <View style={[styles.pressureDivider, { backgroundColor: colors.border }]} />
          <View style={styles.pressureItem}>
            <Text style={[styles.pressureValue, { color: colors.info }]}>{pressure.responseRate || 0}%</Text>
            <Text style={[styles.pressureLabel, { color: colors.textMuted }]}>{t('provider.otvety')}</Text>
          </View>
        </View>
      )}

      <FlatList
        data={requests}
        keyExtractor={(item) => item.distributionId || item.id}
        renderItem={({ item }) => (
          <RequestCard item={item} colors={colors} onAccept={handleAccept} onReject={handleReject} />
        )}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          preEngagements.length > 0 ? (
            <View testID="pre-engagement-section" style={{ paddingTop: 8 }}>
              {preEngagements.map(e => (
                <PreEngagementCard
                  key={e.id}
                  event={e}
                  colors={colors}
                  onAccept={handleAcceptPreEngagement}
                />
              ))}
            </View>
          ) : null
        }
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); loadData(); }} tintColor={colors.primary} />}
        ListEmptyComponent={
          preEngagements.length === 0 ? (
            <View style={styles.emptyContainer}>
              <Ionicons name="inbox-outline" size={64} color={colors.textMuted} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>{t('provider.net_novyh_zayavok')}</Text>
              <Text style={[styles.emptySubtitle, { color: colors.textSecondary }]}>
                Новые заявки появятся здесь автоматически
              </Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '700', marginLeft: 12 },
  onlineBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, gap: 6 },
  onlineDot: { width: 8, height: 8, borderRadius: 4 },
  onlineText: { fontSize: 12, fontWeight: '600' },
  pressureBar: { flexDirection: 'row', margin: 16, borderRadius: 12, padding: 12 },
  pressureItem: { flex: 1, alignItems: 'center' },
  pressureValue: { fontSize: 20, fontWeight: '700' },
  pressureLabel: { fontSize: 11, marginTop: 2 },
  pressureDivider: { width: 1, marginVertical: 4 },
  list: { padding: 16, paddingTop: 4, gap: 12 },
  card: { borderRadius: 16, padding: 16 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  timerBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, borderWidth: 1, gap: 4 },
  timerText: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  urgencyBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, gap: 4 },
  urgencyText: { fontSize: 11, fontWeight: '600' },
  distanceText: { fontSize: 13, fontWeight: '500' },
  serviceName: { fontSize: 17, fontWeight: '700', marginBottom: 4 },
  customerName: { fontSize: 14, marginBottom: 4 },
  addressText: { fontSize: 13, marginBottom: 6 },
  priceText: { fontSize: 18, fontWeight: '700', marginBottom: 12 },
  cardActions: { flexDirection: 'row', gap: 10 },
  rejectBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 12, borderWidth: 1, gap: 6 },
  rejectText: { fontSize: 14, fontWeight: '600' },
  acceptBtn: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 48, borderRadius: 12, gap: 6 },
  acceptText: { fontSize: 15, fontWeight: '700', color: '#FFF' },
  emptyContainer: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700' },
  emptySubtitle: { fontSize: 14, textAlign: 'center', paddingHorizontal: 40 },

  // ─── Sprint 18: Pre-Engagement Card styles ───────────────────────
  preEngageCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: 1.5,
    padding: 14,
    gap: 12,
  },
  preEngageHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  preEngageIcon: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  preEngageTitle: { fontSize: 15, fontWeight: '700' },
  preEngageSubtitle: { fontSize: 12, marginTop: 2 },
  preEngageBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  preEngageBtnText: { fontSize: 14, fontWeight: '700' },
});
