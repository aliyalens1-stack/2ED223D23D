import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { quotesAPI } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export default function QuoteDetailsScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [quote, setQuote] = useState<any>(null);

  const fetchQuote = async () => {
    try {
      const res = await quotesAPI.getById(id as string);
      setQuote(res.data);
    } catch (error) {
      console.error('Error fetching quote:', error);
      Alert.alert('Ошибка', 'Не удалось загрузить заявку');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchQuote();
  }, [id]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchQuote();
  };

  const handleAcceptResponse = async (response: any) => {
    // Navigate to slot selection
    router.push({
      pathname: '/quote/select-slot',
      params: {
        quoteId: id as string,
        responseId: response._id,
        branchId: response.branchId,
        providerServiceId: response.providerServiceId,
        price: response.price,
        orgName: response.snapshot?.orgName || 'СТО',
        serviceName: response.snapshot?.serviceName || 'Услуга',
      },
    });
  };

  const handleCancel = async () => {
    Alert.alert(
      'Отменить заявку?',
      'Это действие нельзя отменить',
      [
        { text: 'Нет', style: 'cancel' },
        {
          text: 'Отменить',
          style: 'destructive',
          onPress: async () => {
            try {
              await quotesAPI.cancel(id as string);
              Alert.alert('Заявка отменена');
              router.back();
            } catch (error) {
              Alert.alert('Ошибка', 'Не удалось отменить заявку');
            }
          },
        },
      ]
    );
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'pending': return colors.warning;
      case 'responded': return colors.brand;
      case 'accepted': return colors.success;
      case 'cancelled': return colors.brand;
      default: return colors.textMuted;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'pending': return 'Ожидание ответов';
      case 'in_review': return 'На рассмотрении';
      case 'responded': return 'Есть ответы';
      case 'accepted': return 'Принято';
      case 'cancelled': return 'Отменено';
      default: return status;
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!quote) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <Text style={styles.errorText}>Заявка не найдена</Text>
        </View>
      </SafeAreaView>
    );
  }

  const responses = quote.responses || [];
  const canCancel = quote.status === 'pending' || quote.status === 'responded';

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} testID="quote-detail-back-btn">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Заявка #{String(quote._id).slice(-6)}</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        style={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
        }
      >
        {/* Status Card */}
        <View style={styles.statusCard}>
          <View style={[styles.statusBadge, { backgroundColor: `${getStatusColor(quote.status)}20` }]}>
            <View style={[styles.statusDot, { backgroundColor: getStatusColor(quote.status) }]} />
            <Text style={[styles.statusText, { color: getStatusColor(quote.status) }]}>
              {getStatusText(quote.status)}
            </Text>
          </View>
          <Text style={styles.dateText}>
            {new Date(quote.createdAt).toLocaleDateString('ru-RU', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })}
          </Text>
        </View>

        {/* Quote Info */}
        <View style={styles.infoCard}>
          <Text style={styles.cardTitle}>Детали заявки</Text>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Услуга:</Text>
            <Text style={styles.infoValue}>{quote.snapshot?.serviceName || 'Не указано'}</Text>
          </View>
          {quote.description && (
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Описание:</Text>
              <Text style={styles.infoValue}>{quote.description}</Text>
            </View>
          )}
        </View>

        {/* Responses */}
        <View style={styles.responsesSection}>
          <Text style={styles.sectionTitle}>
            Ответы ({responses.length})
          </Text>

          {responses.length === 0 ? (
            <View style={styles.emptyResponses}>
              <Ionicons name="time-outline" size={48} color={colors.textMuted} />
              <Text style={styles.emptyText}>Ожидаем ответы от СТО</Text>
              <Text style={styles.emptySubtext}>Обычно это занимает 1-2 часа</Text>
            </View>
          ) : (
            responses.map((resp: any, index: number) => (
              <View key={resp._id || index} style={styles.responseCard}>
                <View style={styles.responseHeader}>
                  <View style={styles.orgAvatar}>
                    <Ionicons name="business" size={24} color={colors.brand} />
                  </View>
                  <View style={styles.responseInfo}>
                    <Text style={styles.orgName}>{resp.snapshot?.orgName || 'СТО'}</Text>
                    <View style={styles.ratingRow}>
                      <Ionicons name="star" size={14} color={colors.warning} />
                      <Text style={styles.ratingText}>
                        {resp.snapshot?.rating?.toFixed(1) || '5.0'}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.priceBox}>
                    <Text style={styles.priceValue}>
                      {resp.price?.toLocaleString() || 0} ₽
                    </Text>
                  </View>
                </View>

                {resp.message && (
                  <Text style={styles.responseMessage}>{resp.message}</Text>
                )}

                {quote.status !== 'accepted' && quote.status !== 'cancelled' && (
                  <TouchableOpacity
                    style={styles.acceptButton}
                    onPress={() => handleAcceptResponse(resp)}
                    testID={`accept-response-${resp._id || index}`}
                  >
                    <Text style={styles.acceptButtonText}>Выбрать</Text>
                    <Ionicons name="arrow-forward" size={18} color={colors.text} />
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </View>

        {/* Cancel Button */}
        {canCancel && (
          <TouchableOpacity style={styles.cancelButton} onPress={handleCancel}>
            <Text style={styles.cancelButtonText}>Отменить заявку</Text>
          </TouchableOpacity>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    fontSize: 16,
    color: colors.brand,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  backButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text,
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  statusCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 20,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  dateText: {
    fontSize: 14,
    color: colors.textMuted,
  },
  infoCard: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 16,
    marginTop: 20,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 12,
  },
  infoRow: {
    marginBottom: 8,
  },
  infoLabel: {
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 15,
    color: colors.text,
  },
  responsesSection: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginBottom: 16,
  },
  emptyResponses: {
    alignItems: 'center',
    paddingVertical: 40,
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 4,
  },
  responseCard: {
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  responseHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  orgAvatar: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  responseInfo: {
    flex: 1,
    marginLeft: 12,
  },
  orgName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  ratingText: {
    fontSize: 14,
    color: colors.warning,
    marginLeft: 4,
  },
  priceBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  priceValue: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.success,
  },
  responseMessage: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 12,
    lineHeight: 20,
  },
  acceptButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: 10,
    marginTop: 16,
    gap: 8,
  },
  acceptButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 16,
    marginTop: 24,
  },
  cancelButtonText: {
    fontSize: 15,
    color: colors.brand,
  },
});
