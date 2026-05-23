import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Alert,
  TextInput,
  Modal,
} from 'react-native';
import { useThemeContext } from '../../src/context/ThemeContext';

import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/context/AuthContext';
import { vehiclesAPI } from '../../src/services/api';
import { theme } from '../../src/context/ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
const colors = theme.colors;

// Sprint Guest-1: гостевой гараж — vehicles живут локально в AsyncStorage.
// При логине эти машины можно мигрировать на сервер (TODO Sprint Guest-2).
const GUEST_GARAGE_KEY = 'guest.garage.vehicles';

export default function GarageScreen() {
  const { colors } = useThemeContext();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { user, isGuest } = useAuth();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newVehicle, setNewVehicle] = useState({
    brand: '',
    model: '',
    year: '',
    vin: '',
  });
  const [saving, setSaving] = useState(false);

  const fetchVehicles = async () => {
    // Гость → читаем из локального хранилища, без API-вызова.
    if (!user) {
      try {
        const raw = await AsyncStorage.getItem(GUEST_GARAGE_KEY);
        setVehicles(raw ? JSON.parse(raw) : []);
      } catch {
        setVehicles([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
      return;
    }
    try {
      const response = await vehiclesAPI.getMy();
      setVehicles(response.data || []);
    } catch (error) {
      console.error('Error fetching vehicles:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchVehicles();
  }, [user]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchVehicles();
  };

  const handleAddVehicle = async () => {
    if (!newVehicle.brand || !newVehicle.model) {
      Alert.alert('Ошибка', 'Укажите марку и модель');
      return;
    }
    setSaving(true);
    try {
      if (!user) {
        // Guest → save locally.
        const v = {
          id: `local_${Date.now()}`,
          brand: newVehicle.brand,
          model: newVehicle.model,
          year: newVehicle.year ? parseInt(newVehicle.year) : undefined,
          vin: newVehicle.vin || undefined,
          _local: true,
        };
        const next = [v, ...vehicles];
        await AsyncStorage.setItem(GUEST_GARAGE_KEY, JSON.stringify(next));
        setVehicles(next);
      } else {
        await vehiclesAPI.create({
          brand: newVehicle.brand,
          model: newVehicle.model,
          year: newVehicle.year ? parseInt(newVehicle.year) : undefined,
          vin: newVehicle.vin || undefined,
        });
        fetchVehicles();
      }
      setShowAddModal(false);
      setNewVehicle({ brand: '', model: '', year: '', vin: '' });
    } catch (error: any) {
      Alert.alert('Ошибка', error.response?.data?.message || 'Не удалось добавить авто');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteVehicle = async (id: string) => {
    Alert.alert('Удалить авто?', 'Это действие нельзя отменить', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          try {
            if (!user) {
              const next = vehicles.filter(v => v.id !== id);
              await AsyncStorage.setItem(GUEST_GARAGE_KEY, JSON.stringify(next));
              setVehicles(next);
            } else {
              await vehiclesAPI.delete(id);
              fetchVehicles();
            }
          } catch (error) {
            Alert.alert('Ошибка', 'Не удалось удалить авто');
          }
        },
      },
    ]);
  };

  // Sprint Guest-1: гость не блокируется — гараж работает локально.
  // Сверху просто показываем мягкий hint про вход для синхронизации.

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Мой гараж</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowAddModal(true)}
          testID="garage-add-btn"
        >
          <Ionicons name="add" size={24} color={colors.text} />
        </TouchableOpacity>
      </View>

      {!user && (
        <TouchableOpacity
          style={styles.guestBanner}
          onPress={() => router.push('/login')}
          testID="garage-guest-sync-banner"
        >
          <Ionicons name="cloud-upload-outline" size={18} color={colors.brand} />
          <View style={{ flex: 1, marginLeft: 10 }}>
            <Text style={styles.guestBannerTitle}>Вы как гость — авто хранятся на устройстве</Text>
            <Text style={styles.guestBannerSub}>Войдите, чтобы синхронизировать с облаком →</Text>
          </View>
        </TouchableOpacity>
      )}

      <ScrollView
        style={styles.scrollView}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
        }
      >
        {loading ? (
          <ActivityIndicator color={colors.brand} style={{ marginTop: 40 }} />
        ) : vehicles.length === 0 ? (
          <View style={styles.emptyState}>
            <Ionicons name="car-outline" size={64} color={colors.textMuted} />
            <Text style={styles.emptyTitle}>Гараж пуст</Text>
            <Text style={styles.emptyText}>Добавьте своё авто для быстрого поиска СТО</Text>
            <TouchableOpacity
              style={styles.addEmptyButton}
              onPress={() => setShowAddModal(true)}
            >
              <Ionicons name="add" size={20} color={colors.text} />
              <Text style={styles.addEmptyButtonText}>Добавить авто</Text>
            </TouchableOpacity>
          </View>
        ) : (
          vehicles.map((vehicle: any, index: number) => (
            <View key={vehicle._id || index} style={styles.vehicleCard}>
              <View style={styles.vehicleIcon}>
                <Ionicons name="car-sport" size={32} color={colors.brand} />
              </View>
              <View style={styles.vehicleInfo}>
                <Text style={styles.vehicleName}>
                  {vehicle.brand} {vehicle.model}
                </Text>
                {vehicle.year && (
                  <Text style={styles.vehicleYear}>{vehicle.year} год</Text>
                )}
                {vehicle.vin && (
                  <Text style={styles.vehicleVin}>VIN: {vehicle.vin}</Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.deleteButton}
                onPress={() => handleDeleteVehicle(vehicle._id)}
              >
                <Ionicons name="trash-outline" size={20} color={colors.brand} />
              </TouchableOpacity>
            </View>
          ))
        )}

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Add Vehicle Modal */}
      <Modal
        visible={showAddModal}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowAddModal(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Добавить авто</Text>
              <TouchableOpacity onPress={() => setShowAddModal(false)}>
                <Ionicons name="close" size={24} color={colors.textMuted} />
              </TouchableOpacity>
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Марка *</Text>
              <TextInput
                style={styles.input}
                placeholder="Например: BMW"
                placeholderTextColor={colors.textMuted}
                value={newVehicle.brand}
                onChangeText={(text) => setNewVehicle({ ...newVehicle, brand: text })}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Модель *</Text>
              <TextInput
                style={styles.input}
                placeholder="Например: X5"
                placeholderTextColor={colors.textMuted}
                value={newVehicle.model}
                onChangeText={(text) => setNewVehicle({ ...newVehicle, model: text })}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Год выпуска</Text>
              <TextInput
                style={styles.input}
                placeholder="2020"
                placeholderTextColor={colors.textMuted}
                value={newVehicle.year}
                onChangeText={(text) => setNewVehicle({ ...newVehicle, year: text })}
                keyboardType="numeric"
                maxLength={4}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>VIN</Text>
              <TextInput
                style={styles.input}
                placeholder="VIN-номер"
                placeholderTextColor={colors.textMuted}
                value={newVehicle.vin}
                onChangeText={(text) => setNewVehicle({ ...newVehicle, vin: text.toUpperCase() })}
                autoCapitalize="characters"
                maxLength={17}
              />
            </View>

            <TouchableOpacity
              style={[styles.saveButton, saving && styles.saveButtonDisabled]}
              onPress={handleAddVehicle}
              disabled={saving}
            >
              {saving ? (
                <ActivityIndicator color={colors.text} />
              ) : (
                <Text style={styles.saveButtonText}>Добавить</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
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
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: 20,
  },
  vehicleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.backgroundTertiary,
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
  },
  vehicleIcon: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  vehicleInfo: {
    flex: 1,
    marginLeft: 16,
  },
  vehicleName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.text,
  },
  vehicleYear: {
    fontSize: 14,
    color: colors.textMuted,
    marginTop: 2,
  },
  vehicleVin: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2,
  },
  deleteButton: {
    padding: 8,
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
  addEmptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 24,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
    gap: 8,
  },
  addEmptyButtonText: {
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
  guestBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.brand,
    backgroundColor: colors.surface,
  },
  guestBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.text,
  },
  guestBannerSub: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.text,
  },
  inputGroup: {
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.textMuted,
    marginBottom: 8,
  },
  input: {
    backgroundColor: colors.border,
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
  },
  saveButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  saveButtonDisabled: {
    opacity: 0.7,
  },
  saveButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});
