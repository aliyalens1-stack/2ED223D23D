import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, Linking } from 'react-native';

// ═══════════════════════════════════════════════════════════
// 🌍 LOCATION CONTEXT — Централизованное управление геолокацией
// ═══════════════════════════════════════════════════════════

const LOCATION_PERMISSION_KEY = 'location_permission_asked';
const LAST_LOCATION_KEY = 'last_known_location';

// Киев — дефолтная локация
const DEFAULT_LOCATION = { lat: 50.4501, lng: 30.5234 };

// 🔧 Кроссплатформенный Storage
// На веб используем localStorage напрямую для синхронного доступа
const Storage = {
  getItem(key: string): string | null {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.localStorage.getItem(key);
    }
    return null;
  },
  setItem(key: string, value: string): void {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.localStorage.setItem(key, value);
    }
  },
  async getItemAsync(key: string): Promise<string | null> {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      return window.localStorage.getItem(key);
    }
    return AsyncStorage.getItem(key);
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      window.localStorage.setItem(key, value);
      return;
    }
    return AsyncStorage.setItem(key, value);
  }
};

// Types
export type LocationPermissionStatus = 'undetermined' | 'granted' | 'denied' | 'restricted';

export interface UserLocation {
  lat: number;
  lng: number;
  accuracy?: number;
  timestamp?: number;
}

export interface LocationContextType {
  // Состояние
  location: UserLocation | null;
  permissionStatus: LocationPermissionStatus;
  isLoading: boolean;
  isLocationEnabled: boolean;
  hasAskedPermission: boolean;
  
  // Методы
  requestPermission: () => Promise<boolean>;
  getCurrentLocation: () => Promise<UserLocation | null>;
  openSettings: () => void;
  refreshLocation: () => Promise<void>;
  dismissPermissionModal: () => void;
  
  // Модальное окно
  showPermissionModal: boolean;
  setShowPermissionModal: (show: boolean) => void;
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

// Синхронная проверка localStorage при инициализации (только на веб)
const getInitialAskedState = (): boolean => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.localStorage.getItem(LOCATION_PERMISSION_KEY) === 'true';
  }
  return false;
};

export function LocationProvider({ children }: { children: ReactNode }) {
  const [location, setLocation] = useState<UserLocation | null>(DEFAULT_LOCATION);
  const [permissionStatus, setPermissionStatus] = useState<LocationPermissionStatus>('undetermined');
  const [isLoading, setIsLoading] = useState(true);
  const [isLocationEnabled, setIsLocationEnabled] = useState(false);
  // Инициализируем синхронно чтобы избежать мигания модалки
  const [hasAskedPermission, setHasAskedPermission] = useState(getInitialAskedState);
  const [showPermissionModal, setShowPermissionModal] = useState(false);

  // 🔥 Инициализация при старте
  useEffect(() => {
    initializeLocation();
  }, []);

  // Инициализация
  const initializeLocation = async () => {
    console.log('[LocationContext] Initializing...');
    setIsLoading(true);
    
    try {
      // Проверяем, спрашивали ли мы уже разрешение - синхронно для веб
      const asked = Storage.getItem(LOCATION_PERMISSION_KEY);
      const alreadyAsked = asked === 'true';
      setHasAskedPermission(alreadyAsked);
      console.log('[LocationContext] Already asked:', alreadyAsked);
      
      // Загружаем последнюю известную локацию - синхронно для веб
      const lastLocation = Storage.getItem(LAST_LOCATION_KEY);
      if (lastLocation) {
        try {
          const parsed = JSON.parse(lastLocation);
          setLocation(parsed);
          console.log('[LocationContext] Restored last location:', parsed);
        } catch {
          setLocation(DEFAULT_LOCATION);
        }
      } else {
        // Устанавливаем дефолтную локацию сразу
        setLocation(DEFAULT_LOCATION);
      }
      
      // Проверяем текущий статус разрешений
      const { status } = await Location.getForegroundPermissionsAsync();
      console.log('[LocationContext] Permission status:', status);
      
      if (status === 'granted') {
        setPermissionStatus('granted');
        setIsLocationEnabled(true);
        
        // Получаем актуальную локацию
        await fetchCurrentLocation();
      } else {
        // Если не granted - устанавливаем соответствующий статус
        if (status === 'denied') {
          setPermissionStatus('denied');
        } else {
          setPermissionStatus('undetermined');
        }
        setIsLocationEnabled(false);
        
        // НЕ показываем модалку автоматически - только на экране карты
      }
      
    } catch (error) {
      console.error('[LocationContext] Init error:', error);
      setLocation(DEFAULT_LOCATION);
    } finally {
      setIsLoading(false);
    }
  };

  // 🔥 Получение текущей локации
  const fetchCurrentLocation = async (): Promise<UserLocation | null> => {
    try {
      console.log('[LocationContext] Fetching current position...');
      
      // Для веб используем browser Geolocation API
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.geolocation) {
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            (position) => {
              const newLocation: UserLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: position.timestamp,
              };
              
              setLocation(newLocation);
              setIsLocationEnabled(true);
              setPermissionStatus('granted');
              Storage.setItem(LAST_LOCATION_KEY, JSON.stringify(newLocation));
              
              console.log('[LocationContext] Web location updated:', newLocation);
              resolve(newLocation);
            },
            (error) => {
              console.log('[LocationContext] Web geolocation error:', error.message);
              // Используем дефолтную или сохраненную локацию
              resolve(location || DEFAULT_LOCATION);
            },
            {
              enableHighAccuracy: false,
              timeout: 10000,
              maximumAge: 60000,
            }
          );
        });
      }
      
      // Для нативных платформ используем expo-location
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      
      const newLocation: UserLocation = {
        lat: loc.coords.latitude,
        lng: loc.coords.longitude,
        accuracy: loc.coords.accuracy ?? undefined,
        timestamp: loc.timestamp,
      };
      
      setLocation(newLocation);
      setIsLocationEnabled(true);
      
      // Сохраняем в storage (синхронно для веб)
      Storage.setItem(LAST_LOCATION_KEY, JSON.stringify(newLocation));
      
      console.log('[LocationContext] Location updated:', newLocation);
      return newLocation;
      
    } catch (error) {
      console.error('[LocationContext] Get position error:', error);
      return location;
    }
  };

  // 🔥 Запрос разрешения
  const requestPermission = useCallback(async (): Promise<boolean> => {
    console.log('[LocationContext] Requesting permission...');
    
    try {
      // Отмечаем, что спросили (синхронно для веб)
      Storage.setItem(LOCATION_PERMISSION_KEY, 'true');
      setHasAskedPermission(true);
      setShowPermissionModal(false);
      
      // Для веб используем browser Geolocation API
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.geolocation) {
        return new Promise((resolve) => {
          navigator.geolocation.getCurrentPosition(
            async (position) => {
              const newLocation: UserLocation = {
                lat: position.coords.latitude,
                lng: position.coords.longitude,
                accuracy: position.coords.accuracy,
                timestamp: position.timestamp,
              };
              
              setLocation(newLocation);
              setPermissionStatus('granted');
              setIsLocationEnabled(true);
              Storage.setItem(LAST_LOCATION_KEY, JSON.stringify(newLocation));
              
              console.log('[LocationContext] Web permission granted, location:', newLocation);
              resolve(true);
            },
            (error) => {
              console.log('[LocationContext] Web permission denied:', error.message);
              setPermissionStatus('denied');
              setIsLocationEnabled(false);
              resolve(false);
            },
            {
              enableHighAccuracy: false,
              timeout: 15000,
              maximumAge: 0,
            }
          );
        });
      }
      
      // Для нативных платформ
      const { status } = await Location.requestForegroundPermissionsAsync();
      console.log('[LocationContext] Permission response:', status);
      
      if (status === 'granted') {
        setPermissionStatus('granted');
        setIsLocationEnabled(true);
        
        // Получаем локацию
        await fetchCurrentLocation();
        return true;
      } else {
        setPermissionStatus('denied');
        setIsLocationEnabled(false);
        return false;
      }
      
    } catch (error) {
      console.error('[LocationContext] Request permission error:', error);
      setPermissionStatus('denied');
      return false;
    }
  }, []);

  // 🔥 Получить текущую локацию (для компонентов)
  const getCurrentLocation = useCallback(async (): Promise<UserLocation | null> => {
    if (permissionStatus === 'granted') {
      return fetchCurrentLocation();
    }
    
    // Если нет разрешения — возвращаем последнюю известную или дефолт
    return location || DEFAULT_LOCATION;
  }, [permissionStatus, location]);

  // 🔥 Открыть настройки устройства
  const openSettings = useCallback(() => {
    console.log('[LocationContext] Opening settings...');
    
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    } else {
      Linking.openSettings();
    }
  }, []);

  // 🔥 Обновить локацию
  const refreshLocation = useCallback(async () => {
    if (permissionStatus === 'granted') {
      setIsLoading(true);
      await fetchCurrentLocation();
      setIsLoading(false);
    } else {
      // Если нет разрешения — показываем модалку
      setShowPermissionModal(true);
    }
  }, [permissionStatus]);

  // 🔥 Закрыть модалку и сохранить отказ
  const dismissPermissionModal = useCallback(() => {
    console.log('[LocationContext] Dismissing permission modal...');
    setShowPermissionModal(false);
    // Сохраняем синхронно чтобы не было гонки
    Storage.setItem(LOCATION_PERMISSION_KEY, 'true');
    setHasAskedPermission(true);
    
    // Устанавливаем дефолтную локацию если нет текущей
    if (!location) {
      setLocation(DEFAULT_LOCATION);
    }
  }, [location]);

  const value: LocationContextType = {
    location,
    permissionStatus,
    isLoading,
    isLocationEnabled,
    hasAskedPermission,
    requestPermission,
    getCurrentLocation,
    openSettings,
    refreshLocation,
    dismissPermissionModal,
    showPermissionModal,
    setShowPermissionModal,
  };

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error('useLocation must be used within a LocationProvider');
  }
  return context;
}

// Дефолтная локация для экспорта
export const DEFAULT_COORDS = DEFAULT_LOCATION;
