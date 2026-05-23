import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export default function SelectSlotScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const params = useLocalSearchParams();
  const { quoteId, responseId, branchId, providerServiceId, price, orgName, serviceName } = params;

  const [loading, setLoading] = useState(false);
  const [slots, setSlots] = useState<any[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedSlot, setSelectedSlot] = useState<any>(null);
  const [reserving, setReserving] = useState(false);

  // Generate next 7 days
  const dates = Array.from({ length: 7 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() + i + 1); // Start from tomorrow
    return {
      date: date.toISOString().split('T')[0],
      day: date.toLocaleDateString('ru-RU', { weekday: 'short' }),
      dayNum: date.getDate(),
      month: date.toLocaleDateString('ru-RU', { month: 'short' }),
    };
  });

  useEffect(() => {
    if (dates.length > 0 && !selectedDate) {
      setSelectedDate(dates[0].date);
    }
  }, []);

  useEffect(() => {
    if (selectedDate && branchId && providerServiceId) {
      fetchSlots(selectedDate);
    }
  }, [selectedDate]);

  const fetchSlots = async (date: string) => {
    setLoading(true);
    setSelectedSlot(null);
    try {
      const res = await api.get(`/branches/${branchId}/slots`, {
        params: { date, serviceId: providerServiceId },
      });
      setSlots(res.data.slots || []);
    } catch (error: any) {
      console.error('Error fetching slots:', error);
      setSlots([]);
      // If not a working day, show empty state
    } finally {
      setLoading(false);
    }
  };

  const handleReserveSlot = async () => {
    if (!selectedSlot) {
      Alert.alert('Ошибка', 'Выберите время');
      return;
    }

    setReserving(true);
    try {
      // Reserve the slot
      const reserveRes = await api.post('/slots/reserve', {
        branchId,
        providerServiceId,
        date: selectedDate,
        startTime: selectedSlot.startTime,
      });

      const slotId = reserveRes.data._id;

      // Navigate to booking confirmation
      router.push({
        pathname: '/booking/confirm',
        params: {
          slotId,
          quoteId: quoteId as string,
          responseId: responseId as string,
          branchId: branchId as string,
          providerServiceId: providerServiceId as string,
          price: price as string,
          orgName: orgName as string,
          serviceName: serviceName as string,
          date: selectedDate,
          startTime: selectedSlot.startTime,
          endTime: selectedSlot.endTime,
        },
      });
    } catch (error: any) {
      const message = error.response?.data?.message || 'Не удалось забронировать время';
      Alert.alert('Ошибка', Array.isArray(message) ? message[0] : message);
    } finally {
      setReserving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton} testID="select-slot-back-btn">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Выбор времени</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Service Info */}
      <View style={styles.serviceInfo}>
        <View style={styles.serviceIcon}>
          <Ionicons name="business" size={24} color={colors.brand} />
        </View>
        <View style={styles.serviceDetails}>
          <Text style={styles.serviceName}>{serviceName}</Text>
          <Text style={styles.orgNameText}>{orgName}</Text>
        </View>
        <View style={styles.priceBox}>
          <Text style={styles.priceValue}>{Number(price).toLocaleString()} ₽</Text>
        </View>
      </View>

      {/* Date Selector */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.dateScroll}
        contentContainerStyle={styles.dateScrollContent}
      >
        {dates.map((d) => (
          <TouchableOpacity
            key={d.date}
            style={[
              styles.dateCard,
              selectedDate === d.date && styles.dateCardActive,
            ]}
            onPress={() => setSelectedDate(d.date)}
          >
            <Text style={[
              styles.dateDay,
              selectedDate === d.date && styles.dateDayActive,
            ]}>{d.day}</Text>
            <Text style={[
              styles.dateNum,
              selectedDate === d.date && styles.dateNumActive,
            ]}>{d.dayNum}</Text>
            <Text style={[
              styles.dateMonth,
              selectedDate === d.date && styles.dateMonthActive,
            ]}>{d.month}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Time Slots */}
      <ScrollView style={styles.content}>
        <Text style={styles.sectionTitle}>Доступное время</Text>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.brand} />
          </View>
        ) : slots.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="calendar-outline" size={48} color={colors.textMuted} />
            <Text style={styles.emptyText}>Нет доступного времени</Text>
            <Text style={styles.emptySubtext}>Попробуйте выбрать другую дату</Text>
          </View>
        ) : (
          <View style={styles.slotsGrid}>
            {slots.map((slot, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.slotCard,
                  selectedSlot?.startTime === slot.startTime && styles.slotCardActive,
                ]}
                onPress={() => setSelectedSlot(slot)}
              >
                <Text style={[
                  styles.slotTime,
                  selectedSlot?.startTime === slot.startTime && styles.slotTimeActive,
                ]}>
                  {slot.startTime}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* Bottom CTA */}
      {selectedSlot && (
        <View style={styles.bottomCTA}>
          <View style={styles.selectedInfo}>
            <Text style={styles.selectedLabel}>Выбрано:</Text>
            <Text style={styles.selectedValue}>
              {selectedDate} в {selectedSlot.startTime}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.confirmButton, reserving && styles.confirmButtonDisabled]}
            onPress={handleReserveSlot}
            disabled={reserving}
            testID="reserve-slot-btn"
          >
            {reserving ? (
              <ActivityIndicator color={colors.text} />
            ) : (
              <>
                <Text style={styles.confirmButtonText}>Продолжить</Text>
                <Ionicons name="arrow-forward" size={20} color={colors.text} />
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
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
  serviceInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  serviceIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  serviceDetails: {
    flex: 1,
    marginLeft: 12,
  },
  serviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  orgNameText: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 2,
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
  dateScroll: {
    maxHeight: 100,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dateScrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  dateCard: {
    width: 64,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: colors.backgroundTertiary,
    alignItems: 'center',
    marginRight: 8,
  },
  dateCardActive: {
    backgroundColor: colors.primary,
  },
  dateDay: {
    fontSize: 12,
    color: colors.textMuted,
    textTransform: 'uppercase',
  },
  dateDayActive: {
    color: 'rgba(255, 255, 255, 0.8)',
  },
  dateNum: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
    marginVertical: 4,
  },
  dateNumActive: {
    color: colors.text,
  },
  dateMonth: {
    fontSize: 12,
    color: colors.textMuted,
  },
  dateMonthActive: {
    color: 'rgba(255, 255, 255, 0.8)',
  },
  content: {
    flex: 1,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text,
    marginTop: 20,
    marginBottom: 16,
  },
  loadingContainer: {
    paddingVertical: 40,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingVertical: 40,
    alignItems: 'center',
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
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  slotCard: {
    width: '30%',
    paddingVertical: 14,
    borderRadius: 12,
    backgroundColor: colors.backgroundTertiary,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  slotCardActive: {
    borderColor: colors.brand,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
  },
  slotTime: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.text,
  },
  slotTimeActive: {
    color: colors.brand,
  },
  bottomCTA: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.background,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingBottom: 32,
  },
  selectedInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  selectedLabel: {
    fontSize: 14,
    color: colors.textMuted,
  },
  selectedValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.text,
  },
  confirmButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 8,
  },
  confirmButtonDisabled: {
    opacity: 0.7,
  },
  confirmButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});
