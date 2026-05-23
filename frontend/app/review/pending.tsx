/**
 * Sprint 5 — Pending Reviews list.
 *
 * URL: /review/pending
 *
 * Shows all the released requests where current user hasn't reviewed yet,
 * sorted by recency. Tapping → opens /review/post-escrow?requestId=...
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { trustAPI } from '../../src/services/api';
import { useRequireAuth } from '../../src/hooks/useRequireAuth';
import { AuthRequiredModal } from '../../src/components/AuthRequiredModal';

const CATEGORY_EMOJI: Record<string, string> = {
  repair: '🔧',
  tow: '🚛',
  wash: '🚿',
  detailing: '✨',
  battery: '🔋',
  parts: '🔩',
  delivery: '🚚',
  inspection: '🛡',
  car_selection: '🎯',
};

export default function PendingReviewsScreen() {
  const router = useRouter();
  const { requireAuth, authModalVisible, closeAuthModal, authReason } = useRequireAuth();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await trustAPI.pending();
      setItems(data.items || []);
    } catch (e: any) {
      if (e?.response?.status === 401) {
        requireAuth(() => load(), {
          intent: 'review_pending',
          reason: 'Войдите, чтобы увидеть свои сделки.',
        });
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requireAuth]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <ActivityIndicator color="#FFD23F" size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} testID="pending-back-btn">
          <Ionicons name="chevron-back" size={26} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Незакрытые отзывы</Text>
        <View style={{ width: 26 }} />
      </View>

      {items.length === 0 ? (
        <View style={styles.empty} testID="pending-empty">
          <Ionicons name="checkmark-done-circle" size={64} color="#34D399" />
          <Text style={styles.emptyTitle}>Всё в порядке!</Text>
          <Text style={styles.emptyMuted}>
            У вас нет сделок, ожидающих вашей оценки.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.requestId}
          contentContainerStyle={{ padding: 16 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
              tintColor="#FFD23F"
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.item}
              testID={`pending-item-${item.requestId}`}
              onPress={() =>
                router.push({
                  pathname: '/review/post-escrow',
                  params: { requestId: item.requestId },
                })
              }
            >
              <View style={styles.row}>
                <Text style={styles.emoji}>{CATEGORY_EMOJI[item.category || ''] || '🛠'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.title}>{item.title || item.category}</Text>
                  <Text style={styles.subtitle}>
                    {item.authorRole === 'customer' ? 'Оцените исполнителя' : 'Оцените клиента'}
                    {item.amount ? ` · €${item.amount}` : ''}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#9CA3AF" />
              </View>
            </TouchableOpacity>
          )}
        />
      )}

      <AuthRequiredModal
        visible={authModalVisible}
        onClose={closeAuthModal}
        reason={authReason}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomColor: '#1f2937',
    borderBottomWidth: 1,
  },
  headerTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyTitle: { color: '#fff', fontSize: 20, fontWeight: '700', marginTop: 20 },
  emptyMuted: { color: '#9CA3AF', fontSize: 14, marginTop: 12, textAlign: 'center' },
  item: {
    backgroundColor: '#1f2937',
    padding: 14,
    borderRadius: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#374151',
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  emoji: { fontSize: 28, marginRight: 12 },
  title: { color: '#fff', fontSize: 15, fontWeight: '600' },
  subtitle: { color: '#9CA3AF', fontSize: 13, marginTop: 2 },
});
