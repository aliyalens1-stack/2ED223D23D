import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/context/AuthContext';
import { quotesAPI, bookingsAPI } from '../../src/services/api';
import ProviderInbox from '../../src/components/ProviderInbox';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

function TTLBadge({ expiresAt }: { expiresAt: string }) {
  const [timeLeft, setTimeLeft] = useState('');
  useEffect(() => {
    const update = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) { setTimeLeft('Истекла'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setTimeLeft(`${h}:${String(m).padStart(2, '0')}`);
    };
    update();
    const interval = setInterval(update, 60000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  const isLow = new Date(expiresAt).getTime() - Date.now() < 3600000;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Ionicons name="time-outline" size={13} color={isLow ? colors.brand : colors.warning} />
      <Text style={{ fontSize: 12, color: isLow ? colors.brand : colors.warning, fontWeight: '600' }}>
        ещё {timeLeft}
      </Text>
    </View>
  );
}

export default function QuotesScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quotes, setQuotes] = useState<any[]>([]);
  const [bookings, setBookings] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'quotes' | 'bookings'>('quotes');

  const isProvider = user?.role?.startsWith('provider');
  // 🔥 Inbox PRO: provider's slug — try multiple shapes (provider_owner / provider_member / provider)
  const providerSlug =
    (user as any)?.providerSlug ||
    (user as any)?.organization?.slug ||
    'avtomaster-pro';

  const fetchData = async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    try {
      // Customer: fetch my quotes and bookings
      const [quotesRes, bookingsRes] = await Promise.all([
        quotesAPI.getMy(),
        bookingsAPI.getMy(),
      ]);
      setQuotes(quotesRes.data || []);
      setBookings(bookingsRes.data || []);
    } catch (error) {
      console.log('Error fetching data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    // For provider — Inbox PRO loads data itself; skip the customer fetch
    if (!isProvider) fetchData();
    else setLoading(false);
  }, [user, isProvider]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return colors.warning;
      case 'responded': return colors.brand;
      case 'accepted': return colors.success;
      case 'completed': return colors.success;
      case 'cancelled': return colors.brand;
      case 'confirmed': return colors.brand;
      case 'in_progress': return colors.brand;
      default: return colors.textMuted;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return 'Ожидание';
      case 'in_review': return 'На рассмотрении';
      case 'responded': return 'Есть ответы';
      case 'accepted': return 'Принято';
      case 'cancelled': return 'Отменено';
      case 'confirmed': return 'Подтверждено';
      case 'in_progress': return 'В работе';
      case 'completed': return 'Завершено';
      default: return status;
    }
  };

  if (!user) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.authPrompt}>
          <Ionicons name="document-text-outline" size={64} color={colors.textMuted} />
          <Text style={styles.authTitle}>Войдите для просмотра заявок</Text>
          <TouchableOpacity
            testID="quotes-login-btn"
            style={styles.authButton}
            onPress={() => router.push('/login')}
          >
            <Text style={styles.authButtonText}>Войти</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 🔥 PROVIDER INBOX PRO — Operational Center
  // Tabs: Новые / В работе / Завершённые + earnings strip
  // ═══════════════════════════════════════════════════════════
  if (isProvider) {
    return (
      <SafeAreaView style={styles.container} testID="provider-inbox-screen">
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Inbox</Text>
            <Text style={styles.subtitle}>Управляй заказами в одном месте</Text>
          </View>
          <TouchableOpacity
            testID="provider-inbox-settings"
            style={[styles.iconBtn, { backgroundColor: colors.card }]}
            onPress={() => router.push('/(tabs)/profile')}
          >
            <Ionicons name="settings-outline" size={20} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ProviderInbox providerSlug={providerSlug} />
      </SafeAreaView>
    );
  }

  // ═══════════════════════════════════════════════════════════
  // 👤 CUSTOMER VIEW — quotes + bookings (existing)
  // ═══════════════════════════════════════════════════════════
  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Мои заявки</Text>
        <TouchableOpacity
          testID="create-quote-btn"
          style={styles.createButton}
          onPress={() => router.push('/create-quote')}
        >
          <Ionicons name="add" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          testID="customer-tab-quotes"
          style={[styles.tab, activeTab === 'quotes' && styles.tabActive]}
          onPress={() => setActiveTab('quotes')}
        >
          <Text style={[styles.tabText, activeTab === 'quotes' && styles.tabTextActive]}>
            Заявки ({quotes.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="customer-tab-bookings"
          style={[styles.tab, activeTab === 'bookings' && styles.tabActive]}
          onPress={() => setActiveTab('bookings')}
        >
          <Text style={[styles.tabText, activeTab === 'bookings' && styles.tabTextActive]}>
            Записи ({bookings.length})
          </Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
        ) : activeTab === 'quotes' ? (
          quotes.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="document-text-outline" size={64} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>Нет заявок</Text>
              <Text style={styles.emptyText}>Создайте заявку на поиск СТО</Text>
              <TouchableOpacity
                style={styles.createEmptyButton}
                onPress={() => router.push('/create-quote')}
              >
                <Text style={styles.createEmptyButtonText}>Создать заявку</Text>
              </TouchableOpacity>
            </View>
          ) : (
            quotes.map((quote: any, index: number) => (
              <TouchableOpacity
                key={quote._id || index}
                testID={`customer-quote-${quote._id || index}`}
                style={styles.card}
                onPress={() => router.push(`/quote/${quote._id}`)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    Заявка #{String(quote._id).slice(-6)}
                  </Text>
                  <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(quote.status)}20` }]}>
                    <Text style={[styles.statusText, { color: getStatusColor(quote.status) }]}>
                      {getStatusText(quote.status)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.cardDescription} numberOfLines={2}>
                  {quote.description || 'Описание не указано'}
                </Text>
                <View style={styles.cardFooter}>
                  <View style={styles.cardStat}>
                    <Ionicons name="chatbubbles-outline" size={14} color={colors.textMuted} />
                    <Text style={styles.cardStatText}>{quote.responsesCount || 0} ответов</Text>
                  </View>
                  {quote.expiresAt && new Date(quote.expiresAt) > new Date() ? (
                    <TTLBadge expiresAt={quote.expiresAt} />
                  ) : quote.expiresAt && new Date(quote.expiresAt) <= new Date() ? (
                    <Text style={[styles.cardDate, { color: colors.brand }]}>Истекла</Text>
                  ) : (
                    <Text style={styles.cardDate}>
                      {new Date(quote.createdAt).toLocaleDateString('ru-RU')}
                    </Text>
                  )}
                </View>
              </TouchableOpacity>
            ))
          )
        ) : (
          bookings.length === 0 ? (
            <View style={styles.emptyState}>
              <Ionicons name="calendar-outline" size={64} color={colors.textMuted} />
              <Text style={styles.emptyTitle}>Нет записей</Text>
              <Text style={styles.emptyText}>Записи появятся после принятия заявки</Text>
            </View>
          ) : (
            bookings.map((booking: any, index: number) => (
              <TouchableOpacity
                key={booking._id || index}
                testID={`customer-booking-${booking._id || index}`}
                style={styles.card}
                onPress={() => router.push(`/booking/${booking._id}`)}
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>
                    {booking.snapshot?.serviceName || 'Услуга'}
                  </Text>
                  <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(booking.status)}20` }]}>
                    <Text style={[styles.statusText, { color: getStatusColor(booking.status) }]}>
                      {getStatusText(booking.status)}
                    </Text>
                  </View>
                </View>
                <Text style={styles.cardDescription}>
                  {booking.snapshot?.orgName || 'СТО'}
                </Text>
                <View style={styles.cardFooter}>
                  <Text style={styles.cardPrice}>
                    {booking.snapshot?.price?.toLocaleString() || 0} €
                  </Text>
                  <Text style={styles.cardDate}>
                    {new Date(booking.createdAt).toLocaleDateString('ru-RU')}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )
        )}

        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.text,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: colors.backgroundTertiary,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: colors.primary,
  },
  tabText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textMuted,
  },
  tabTextActive: {
    color: colors.text,
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: 20,
  },
  card: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
  },
  cardDescription: {
    fontSize: 14,
    color: colors.textMuted,
    marginBottom: 12,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardStat: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardStatText: {
    fontSize: 13,
    color: colors.onPrimaryMuted,
    marginLeft: 4,
  },
  cardPrice: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.success,
  },
  cardDate: {
    fontSize: 12,
    color: colors.textMuted,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginTop: 16,
  },
  emptyText: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  createEmptyButton: {
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
  },
  createEmptyButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  authPrompt: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
  },
  authTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
    marginTop: 16,
    textAlign: 'center',
  },
  authButton: {
    marginTop: 24,
    paddingHorizontal: 48,
    paddingVertical: 14,
    backgroundColor: colors.primary,
    borderRadius: 12,
  },
  authButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});
