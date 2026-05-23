/**
 * TimelineRail — Sprint 4.5 horizontal timeline component.
 *
 * Renders a chronological rail of service-request lifecycle events.
 * Each event is a pill: created → matched → paid → started → completed → released.
 *
 * Designed to sit at the TOP of /chat/service/[chatId].tsx but is fully
 * reusable — pass `events` (from /api/service-requests/{id}/timeline)
 * and the rail handles ordering, current-step highlighting and tone.
 *
 * No animation infra, no websockets — pure presentational.
 */
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

export type TimelineKind =
  | 'request_created'
  | 'provider_matched'
  | 'bid_accepted'
  | 'payment_secured'
  | 'chat_opened'
  | 'provider_en_route'
  | 'work_started'
  | 'extra_parts_requested'
  | 'work_completed'
  | 'release_confirmed'
  | 'escrow_released'
  | 'request_cancelled';

export interface TimelineEvent {
  id: string;
  requestId: string;
  kind: TimelineKind;
  label: string;
  actorRole?: string;
  actorId?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt: string;
}

interface Props {
  events: TimelineEvent[];
  loading?: boolean;
  error?: string | null;
  /** Compact mode: smaller height, used inside chat header */
  compact?: boolean;
}

// Canonical order — events not in this list still render at the end in
// chronological order.
const CANONICAL_ORDER: TimelineKind[] = [
  'request_created',
  'provider_matched',
  'bid_accepted',
  'payment_secured',
  'chat_opened',
  'provider_en_route',
  'work_started',
  'extra_parts_requested',
  'work_completed',
  'release_confirmed',
  'escrow_released',
];

// Per-kind icon + tone. Tones determine pill background.
const KIND_META: Record<
  TimelineKind,
  { icon: keyof typeof Ionicons.glyphMap; tone: 'neutral' | 'progress' | 'success' | 'danger' }
> = {
  request_created:        { icon: 'document-text-outline', tone: 'neutral' },
  provider_matched:       { icon: 'people-outline',         tone: 'neutral' },
  bid_accepted:           { icon: 'checkmark-circle-outline', tone: 'progress' },
  payment_secured:        { icon: 'lock-closed-outline',    tone: 'progress' },
  chat_opened:            { icon: 'chatbubbles-outline',    tone: 'progress' },
  provider_en_route:      { icon: 'navigate-outline',       tone: 'progress' },
  work_started:           { icon: 'construct-outline',      tone: 'progress' },
  extra_parts_requested:  { icon: 'cube-outline',           tone: 'neutral' },
  work_completed:         { icon: 'checkmark-done-outline', tone: 'success' },
  release_confirmed:      { icon: 'thumbs-up-outline',      tone: 'success' },
  escrow_released:        { icon: 'cash-outline',           tone: 'success' },
  request_cancelled:      { icon: 'close-circle-outline',   tone: 'danger' },
};

// i18n keys for canonical labels — fall back to server-provided label otherwise.
const I18N_KEYS: Partial<Record<TimelineKind, string>> = {
  request_created:        'timeline.request_created',
  provider_matched:       'timeline.provider_matched',
  bid_accepted:           'timeline.bid_accepted',
  payment_secured:        'timeline.payment_secured',
  chat_opened:            'timeline.chat_opened',
  provider_en_route:      'timeline.provider_en_route',
  work_started:           'timeline.work_started',
  extra_parts_requested:  'timeline.extra_parts_requested',
  work_completed:         'timeline.work_completed',
  release_confirmed:      'timeline.release_confirmed',
  escrow_released:        'timeline.escrow_released',
  request_cancelled:      'timeline.request_cancelled',
};

export function TimelineRail({ events, loading, error, compact = true }: Props) {
  const { t } = useTranslation();
  const sorted = useMemo(() => {
    // First by canonical order, ties by createdAt asc.
    const order = (k: TimelineKind) => {
      const i = CANONICAL_ORDER.indexOf(k);
      return i < 0 ? CANONICAL_ORDER.length : i;
    };
    return [...events].sort((a, b) => {
      const oa = order(a.kind);
      const ob = order(b.kind);
      if (oa !== ob) return oa - ob;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [events]);

  // Cancelled trumps everything visually but we still render the rail.
  const cancelled = sorted.find((e) => e.kind === 'request_cancelled');
  // Current step = the last completed (non-cancelled) event.
  const lastCompletedIdx = cancelled ? -1 : sorted.length - 1;

  if (loading && sorted.length === 0) {
    return (
      <View style={[styles.container, compact && styles.containerCompact]}>
        <ActivityIndicator size="small" color="#9aa3b2" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, compact && styles.containerCompact]}>
        <Text style={styles.errorText} testID="timeline-error">{error}</Text>
      </View>
    );
  }

  if (sorted.length === 0) {
    return null;
  }

  return (
    <View testID="timeline-rail" style={[styles.container, compact && styles.containerCompact]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {sorted.map((evt, idx) => {
          const meta = KIND_META[evt.kind] ?? { icon: 'ellipse-outline', tone: 'neutral' as const };
          const isCurrent = idx === lastCompletedIdx;
          const i18nKey = I18N_KEYS[evt.kind];
          const label = i18nKey ? t(i18nKey, { defaultValue: evt.label }) : evt.label;
          return (
            <React.Fragment key={evt.id}>
              <View
                testID={`timeline-pill-${evt.kind}`}
                style={[
                  styles.pill,
                  styles[`tone_${meta.tone}` as const],
                  isCurrent && styles.pillCurrent,
                ]}
              >
                <Ionicons
                  name={meta.icon}
                  size={compact ? 14 : 16}
                  color={isCurrent ? '#0b0d12' : toneIconColor(meta.tone)}
                />
                <Text
                  style={[
                    styles.pillText,
                    isCurrent && styles.pillTextCurrent,
                    compact && styles.pillTextCompact,
                  ]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              </View>
              {idx < sorted.length - 1 && <View style={styles.connector} />}
            </React.Fragment>
          );
        })}
      </ScrollView>
    </View>
  );
}

function toneIconColor(tone: 'neutral' | 'progress' | 'success' | 'danger'): string {
  switch (tone) {
    case 'progress': return '#7aa2ff';
    case 'success':  return '#5fd3a3';
    case 'danger':   return '#ff8a8a';
    default:         return '#9aa3b2';
  }
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 12,
    backgroundColor: '#0f1117',
    borderBottomWidth: 1,
    borderBottomColor: '#1c2030',
  },
  containerCompact: {
    paddingVertical: 8,
  },
  scroll: {
    paddingHorizontal: 12,
    alignItems: 'center',
    gap: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillCurrent: {
    backgroundColor: '#fde68a',
    borderColor: '#fde68a',
  },
  tone_neutral: {
    backgroundColor: '#1c2030',
    borderColor: '#252b3d',
  },
  tone_progress: {
    backgroundColor: '#152045',
    borderColor: '#1f2d5e',
  },
  tone_success: {
    backgroundColor: '#0d2a1f',
    borderColor: '#13422f',
  },
  tone_danger: {
    backgroundColor: '#2a0f12',
    borderColor: '#4a1620',
  },
  pillText: {
    color: '#cbd2e0',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 140,
  },
  pillTextCompact: {
    fontSize: 11,
  },
  pillTextCurrent: {
    color: '#0b0d12',
  },
  connector: {
    width: 14,
    height: 1,
    backgroundColor: '#2a3145',
  },
  errorText: {
    paddingHorizontal: 16,
    color: '#ff8a8a',
    fontSize: 12,
  },
});

export default TimelineRail;
