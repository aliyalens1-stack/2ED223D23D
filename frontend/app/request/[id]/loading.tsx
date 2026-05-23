/**
 * Stage 3 — Loading screen with animated step progress.
 *
 * UX audit: instead of empty "Ищем мастеров...", show 3 progressive steps:
 *   ✔ Проверяем доступность
 *   ✔ Сравниваем цены
 *   ✔ Находим лучшие варианты
 * Effect: "smart system" feel → +conversion.
 *
 * Receives quotes JSON via param — passes through to /offers (no refetch).
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Text from '../../../src/components/ui/Text';
import { useThemeContext } from '../../../src/context/ThemeContext';

const STEPS = [
  { key: 'availability', label: 'Проверяем доступность',  delay: 0    },
  { key: 'prices',       label: 'Сравниваем цены',        delay: 600  },
  { key: 'best',         label: 'Находим лучшие варианты', delay: 1200 },
];
const TOTAL_MS = 2000;

export default function LoadingScreen() {
  const router = useRouter();
  const { id, quotes } = useLocalSearchParams<{ id: string; quotes?: string }>();
  const { colors } = useThemeContext();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [completedSteps, setCompletedSteps] = useState<Set<string>>(new Set());

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: true }).start();

    const stepTimers = STEPS.map((s) =>
      setTimeout(() => {
        setCompletedSteps((prev) => {
          const next = new Set(prev);
          next.add(s.key);
          return next;
        });
      }, s.delay)
    );
    const navTimer = setTimeout(() => {
      const qp = quotes ? `?quotes=${quotes}` : '';
      router.replace(`/request/${id}/offers${qp}` as any);
    }, TOTAL_MS);

    return () => {
      stepTimers.forEach(clearTimeout);
      clearTimeout(navTimer);
    };
  }, [id, quotes, router, fadeAnim]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]} testID="request-loading-screen">
      <Animated.View style={[styles.center, { opacity: fadeAnim }]}>
        <View style={[styles.iconWrap, { backgroundColor: colors.brandSoft }]}>
          <Ionicons name="flash" size={32} color={colors.brand} />
        </View>
        <ActivityIndicator size="large" color={colors.brand} style={{ marginTop: 24 }} />
        <Text variant="h2" style={{ marginTop: 20, textAlign: 'center' }}>
          Ищем мастеров...
        </Text>

        {/* Animated step list — UX audit Stage 3 */}
        <View style={styles.steps} testID="loading-steps">
          {STEPS.map((s) => {
            const done = completedSteps.has(s.key);
            return (
              <View key={s.key} style={styles.stepRow} testID={`loading-step-${s.key}`}>
                <Ionicons
                  name={done ? 'checkmark-circle' : 'ellipse-outline'}
                  size={20}
                  color={done ? colors.success || colors.brand : colors.textSecondary}
                />
                <Text
                  variant="body"
                  weight={done ? '700' : '500'}
                  tone={done ? undefined : 'muted'}
                  style={{ flex: 1 }}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  iconWrap: {
    width: 72, height: 72, borderRadius: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  steps: {
    marginTop: 32,
    gap: 14,
    alignSelf: 'stretch',
    paddingHorizontal: 8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
});
