import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useThemeContext } from '../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../src/services/api';
import { useAuth } from '../src/context/AuthContext';
import { theme } from '../src/context/ThemeContext';
const colors = theme.colors;

export default function FavoritesScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user, setPendingIntent } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [favorites, setFavorites] = useState<any[]>([]);

  const fetchFavorites = async () => {
    try {
      const res = await api.get('/favorites/my');
      setFavorites(res.data || []);
    } catch (error) {
      console.error('Error fetching favorites:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (user) fetchFavorites();
    else setLoading(false);
  }, [user]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchFavorites();
  };

  const handleRemoveFavorite = async (orgId: string) => {
    Alert.alert('Удалить из избранного?', '', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.delete(`/favorites/${orgId}`);
            setFavorites(prev => prev.filter(f => f.organizationId !== orgId && f.organization?._id !== orgId));
          } catch {}
        },
      },
    ]);
  };

  const handleBook = (org: any) => {
    router.push(`/create-quote?orgId=${org._id || org.organizationId}`);
  };

  if (!user) {
    // Sprint Guest-1: guest sees empty state with hint, NOT a wall.
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Избранное</Text>
          <View style={{ width: 44 }} />
        </View>
        <View style={styles.empty}>
          <Ionicons name="heart-outline" size={64} color={colors.border} />
          <Text style={styles.emptyTitle}>Нет избранных СТО</Text>
          <Text style={styles.emptyText}>
            Войдите, чтобы сохранять любимые СТО и быстро их находить.
          </Text>
          <TouchableOpacity
            style={styles.emptyBtn}
            onPress={() => router.push('/(tabs)/services')}
            testID="favorites-find-cta"
          >
            <Ionicons name="search" size={18} color={colors.text} />
            <Text style={styles.emptyBtnText}>Найти СТО</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.emptyBtn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.brand, marginTop: 10 }]}
            onPress={async () => {
              await setPendingIntent('favorites');
              router.push('/login');
            }}
            testID="favorites-login-cta"
          >
            <Ionicons name="log-in-outline" size={18} color={colors.brand} />
            <Text style={[styles.emptyBtnText, { color: colors.brand }]}>Войти для синхронизации</Text>
          </TouchableOpacity>
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
        <Text style={styles.title}>Избранное</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />}
      >
        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
        ) : favorites.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="heart-outline" size={64} color={colors.border} />
            <Text style={styles.emptyTitle}>Нет избранных СТО</Text>
            <Text style={styles.emptyText}>Добавляйте понравившиеся автосервисы в избранное</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/(tabs)/services')}>
              <Ionicons name="search" size={18} color={colors.text} />
              <Text style={styles.emptyBtnText}>Найти СТО</Text>
            </TouchableOpacity>
          </View>
        ) : (
          favorites.map((fav, idx) => {
            const org = fav.organization || fav;
            return (
              <View key={fav._id || idx} style={styles.favCard}>
                <View style={styles.orgIcon}>
                  <Ionicons name="business" size={28} color={colors.brand} />
                </View>
                <View style={styles.orgInfo}>
                  <Text style={styles.orgName} numberOfLines={1}>{org.name || 'СТО'}</Text>
                  <View style={styles.ratingRow}>
                    <Ionicons name="star" size={14} color={colors.warning} />
                    <Text style={styles.ratingText}>
                      {(org.ratingAvg || org.rating || 5).toFixed(1)} ({org.reviewsCount || 0} отзывов)
                    </Text>
                  </View>
                  {org.address && <Text style={styles.address} numberOfLines={1}>{org.address}</Text>}
                </View>
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.bookBtn} onPress={() => handleBook(org)}>
                    <Text style={styles.bookBtnText}>Записаться</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleRemoveFavorite(org._id || fav.organizationId)} style={styles.removeBtn}>
                    <Ionicons name="heart-dislike" size={18} color={colors.brand} />
                  </TouchableOpacity>
                </View>
              </View>
            );
          })
        )}
        <View style={{ height: 20 }} />
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
  content: { flex: 1, paddingHorizontal: 16 },
  empty: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16 },
  emptyText: { fontSize: 14, color: colors.textMuted, marginTop: 6, textAlign: 'center', paddingHorizontal: 20 },
  emptyBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 24, paddingHorizontal: 24, paddingVertical: 14,
    backgroundColor: colors.primary, borderRadius: 12,
  },
  emptyBtnText: { fontSize: 15, fontWeight: '600', color: colors.onPrimary },
  favCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.backgroundTertiary, borderRadius: 16,
    padding: 14, marginTop: 12,
  },
  orgIcon: {
    width: 56, height: 56, borderRadius: 14,
    backgroundColor: 'rgba(59,130,246,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  orgInfo: { flex: 1, marginLeft: 12 },
  orgName: { fontSize: 16, fontWeight: '600', color: colors.text },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  ratingText: { fontSize: 13, color: colors.textMuted, marginLeft: 4 },
  address: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  actions: { alignItems: 'flex-end', gap: 8 },
  bookBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    backgroundColor: colors.primary, borderRadius: 8,
  },
  bookBtnText: { fontSize: 13, fontWeight: '600', color: colors.onPrimary },
  removeBtn: { padding: 8 },
  authPrompt: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  authTitle: { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 16, textAlign: 'center' },
  authButton: {
    marginTop: 24, paddingHorizontal: 48, paddingVertical: 14,
    backgroundColor: colors.primary, borderRadius: 12,
  },
  authButtonText: { fontSize: 16, fontWeight: '600', color: colors.onPrimary },
});
