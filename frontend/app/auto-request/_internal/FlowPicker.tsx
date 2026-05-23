/**
 * auto-request — Step 0: flow picker.
 *
 * Two cards: inspection (link-based) vs selection (filters-based).
 * Pure presentational — `onPick(flow)` bubbles the user choice to the
 * orchestrator which advances `step` to 1.
 */
import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import type { ColorsLike, FlowType } from './types';

interface Props {
  colors: ColorsLike;
  pricing: Record<FlowType, number>;
  onPick: (flow: FlowType) => void;
}

export function FlowPicker({ colors, pricing, onPick }: Props) {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={styles.topBar}>
          <TouchableOpacity onPress={() => router.back()} testID="create-close-btn">
            <Ionicons name="close" size={26} color={colors.text} />
          </TouchableOpacity>
        </View>
        <ScrollView contentContainerStyle={styles.scrollPad}>
          <Text style={[styles.h1, { color: colors.text }]}>{t('create.step0_title') || 'What would you like to do?'}</Text>
          <Text style={[styles.h1Sub, { color: colors.textSecondary }]}>
            {t('create.step0_sub') || 'Choose one of two flows — we will fill in the right fields next'}
          </Text>

          <TouchableOpacity
            testID="create-flow-inspection"
            activeOpacity={0.85}
            style={[styles.flowCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => onPick('inspection')}
          >
            <View style={[styles.flowIconBox, { backgroundColor: colors.primary }]}>
              <Ionicons name="shield-checkmark" size={26} color="#FFF" />
            </View>
            <View style={styles.flowContent}>
              <Text style={[styles.flowTitle, { color: colors.text }]}>{t('create.flow_inspection_title') || 'Inspect a specific car'}</Text>
              <Text style={[styles.flowSub, { color: colors.textSecondary }]}>
                {t('create.flow_inspection_sub') || 'You have a listing link. An inspector will visit, check it and send you a report.'}
              </Text>
              <View style={styles.flowMeta}>
                <Text style={[styles.flowMetaItem, { color: colors.textSecondary }]}>€{pricing.inspection} · 60 {t('create.points') || 'points'}</Text>
                <Text style={[styles.flowMetaItem, { color: colors.textSecondary }]}>· {t('create.photo_video_24h') || 'photo + video · 24h'}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>

          <TouchableOpacity
            testID="create-flow-selection"
            activeOpacity={0.85}
            style={[styles.flowCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={() => onPick('selection')}
          >
            <View style={[styles.flowIconBox, { backgroundColor: '#8B5CF6' }]}>
              <Ionicons name="search" size={22} color="#FFF" />
            </View>
            <View style={styles.flowContent}>
              <Text style={[styles.flowTitle, { color: colors.text }]}>{t('create.flow_selection_title') || 'Find a car within budget'}</Text>
              <Text style={[styles.flowSub, { color: colors.textSecondary }]}>
                {t('create.flow_selection_sub') || 'Not chosen yet. We find 3–5 candidates matching your filters and inspect them.'}
              </Text>
              <View style={styles.flowMeta}>
                <Text style={[styles.flowMetaItem, { color: colors.textSecondary }]}>€{pricing.selection}</Text>
                <Text style={[styles.flowMetaItem, { color: colors.textSecondary }]}>· {t('create.up_to_5_cars_48h') || 'up to 5 cars · 48h'}</Text>
              </View>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
