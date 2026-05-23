/**
 * Stage 2 — Geo + Search.
 * CityContext: persist user-chosen city in AsyncStorage.
 * Provides:
 *   - cities          : all available cities (loaded from backend)
 *   - selectedCity    : currently active city (or null on first launch)
 *   - selectCity(code): change current city
 *   - loading         : initial fetch state
 */
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { citiesAPI, CityDTO } from '../services/api';

const STORAGE_KEY = 'selected_city_code';

interface CityContextValue {
  cities: CityDTO[];
  selectedCity: CityDTO | null;
  selectCity: (code: string) => Promise<void>;
  refresh: () => Promise<void>;
  loading: boolean;
  hasSelected: boolean;
}

const CityContext = createContext<CityContextValue | undefined>(undefined);

export const CityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [cities, setCities] = useState<CityDTO[]>([]);
  const [selectedCity, setSelectedCity] = useState<CityDTO | null>(null);
  const [hasSelected, setHasSelected] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await citiesAPI.list();
      const list = res.data || [];
      setCities(list);

      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        const found = list.find((c) => c.code === saved);
        if (found) {
          setSelectedCity(found);
          setHasSelected(true);
        }
      }
      // If nothing saved — selectedCity stays null → onboarding gate kicks in
    } catch (e) {
      console.warn('[CityContext] failed to load cities', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const selectCity = useCallback(
    async (code: string) => {
      const found = cities.find((c) => c.code === code);
      if (!found) return;
      setSelectedCity(found);
      setHasSelected(true);
      await AsyncStorage.setItem(STORAGE_KEY, code);
    },
    [cities]
  );

  return (
    <CityContext.Provider value={{ cities, selectedCity, selectCity, refresh, loading, hasSelected }}>
      {children}
    </CityContext.Provider>
  );
};

export const useCity = (): CityContextValue => {
  const ctx = useContext(CityContext);
  if (!ctx) throw new Error('useCity must be used within CityProvider');
  return ctx;
};
