/**
 * UX-4B (Customer slice) — Sanitized Process Timeline.
 *
 * Shows the customer a human-friendly chronology of how the inspection
 * unfolded ("инспекция началась", "VIN подтверждён", "5 фото кузова",
 * "тест-драйв завершён", "отчёт готов") — WITHOUT exposing internal fraud
 * heuristics (suspicion codes, sha256, geo distance, upload delay).
 *
 * Backend at `GET /api/inspections/{jobId}/timeline` already strips
 * `suspicion` and reduces `provenance` to {capturedAt, uploadedAt,
 * context, expectedContext} for customer callers. This component is the
 * presentation layer on top of that contract.
 *
 * Philosophy:
 *   • customer sees process (transparency)
 *   • customer does NOT see fraud heuristics
 *   • boost trust, do not invite manipulation
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';

type SanitizedProvenance = {
  capturedAt?: string;
  uploadedAt?: string;
  context?: string;
  expectedContext?: string;
};

type SanitizedEvent = {
  id?: string;
  jobId?: string;
  eventType: string;
  at: string;
  payload?: any;
  provenance?: SanitizedProvenance;
};

type Props = {
  jobId: string;
  colors: any;            // theme tokens
  testID?: string;
};

// ---------- Customer-facing humanization ----------------------------------

const CONTEXT_LABEL: Record<string, string> = {
  vin: 'VIN-номер',
  odometer: 'Одометр',
  exterior: 'Кузов',
  interior: 'Салон',
  engine: 'Двигатель',
  damage: 'Повреждения',
  obd: 'Диагностика OBD',
  tire: 'Шины',
  general: 'Общие',
};

type GroupedStep = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  at: string;          // ISO timestamp of first occurrence
  count?: number;
  tone: 'neutral' | 'positive' | 'amber';
};

function groupEvents(events: SanitizedEvent[]): GroupedStep[] {
  // Defensive sort by `at` ascending
  const sorted = [...events].sort((a, b) => (a.at || '').localeCompare(b.at || ''));

  const steps: GroupedStep[] = [];
  let lastMediaGroupKey: string | null = null;

  for (const ev of sorted) {
    const type = ev.eventType || '';

    if (type === 'inspection.started') {
      steps.push({
        key: `started-${ev.at}`,
        icon: 'play-circle',
        title: 'Осмотр начат',
        subtitle: 'Инспектор приступил к работе',
        at: ev.at,
        tone: 'neutral',
      });
      lastMediaGroupKey = null;
      continue;
    }

    if (type === 'report.submitted') {
      const score = ev.payload?.score;
      steps.push({
        key: `submitted-${ev.at}`,
        icon: 'document-text',
        title: 'Отчёт сформирован',
        subtitle: typeof score === 'number' ? `Итоговая оценка ${score}/10` : 'Готов к просмотру',
        at: ev.at,
        tone: 'positive',
      });
      lastMediaGroupKey = null;
      continue;
    }

    if (type.startsWith('item.flagged_critical')) {
      const sec = ev.payload?.sectionId;
      steps.push({
        key: `crit-${ev.payload?.itemId || ev.at}`,
        icon: 'alert-circle',
        title: 'Зафиксирована критическая проблема',
        subtitle: sec ? `Раздел: ${CONTEXT_LABEL[sec] || sec}` : undefined,
        at: ev.at,
        tone: 'amber',
      });
      lastMediaGroupKey = null;
      continue;
    }

    if (type.startsWith('item.flagged_warning')) {
      const sec = ev.payload?.sectionId;
      steps.push({
        key: `warn-${ev.payload?.itemId || ev.at}`,
        icon: 'warning',
        title: 'Отмечено замечание',
        subtitle: sec ? `Раздел: ${CONTEXT_LABEL[sec] || sec}` : undefined,
        at: ev.at,
        tone: 'amber',
      });
      lastMediaGroupKey = null;
      continue;
    }

    if (type.startsWith('media.uploaded')) {
      const ctx = ev.provenance?.context || 'general';
      const label = CONTEXT_LABEL[ctx] || ctx;
      const groupKey = `media-${ctx}`;
      // Group consecutive media events of the same context (last group only)
      if (lastMediaGroupKey === groupKey && steps.length > 0) {
        const tail = steps[steps.length - 1];
        tail.count = (tail.count || 1) + 1;
        tail.subtitle = `${tail.count} ${tail.count === 1 ? 'снимок' : tail.count < 5 ? 'снимка' : 'снимков'}`;
      } else {
        steps.push({
          key: `${groupKey}-${ev.at}`,
          icon: 'camera',
          title: `Фото: ${label}`,
          subtitle: '1 снимок',
          at: ev.at,
          count: 1,
          tone: 'neutral',
        });
        lastMediaGroupKey = groupKey;
      }
      continue;
    }
    // Any other event types are intentionally hidden from customer view.
  }
  return steps;
}

// ---------- Component ------------------------------------------------------

export default function CustomerProcessTimeline({ jobId, colors, testID }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<SanitizedEvent[]>([]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/inspections/${jobId}/timeline`)
      .then((r) => {
        if (!alive) return;
        setEvents(Array.isArray(r.data?.events) ? r.data.events : []);
      })
      .catch((e: any) => {
        if (!alive) return;
        // 403 / 404 — silently hide the timeline. Customer simply won't see it.
        setError(e?.response?.status === 403 ? 'hidden' : 'failed');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [jobId]);

  const steps = useMemo(() => groupEvents(events), [events]);

  if (loading) {
    return (
      <View style={[styles.loadingWrap]} testID={testID || 'cust-timeline-loading'}>
        <ActivityIndicator color={colors.primary} size="small" />
      </View>
    );
  }

  // Hide entirely if no events to show (newly-submitted jobs may not have history yet)
  if (error === 'hidden' || steps.length === 0) {
    return null;
  }

  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  return (
    <View style={styles.container} testID={testID || 'cust-process-timeline'}>
      <View style={styles.header}>
        <Ionicons name="time-outline" size={18} color={colors.text} />
        <Text style={[styles.heading, { color: colors.text }]}>Как проходил осмотр</Text>
      </View>
      <Text style={[styles.subhead, { color: colors.textSecondary || colors.text + '99' }]}>
        Прозрачная хронология работы инспектора
      </Text>

      <View style={[styles.rail, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {steps.map((s, idx) => {
          const isLast = idx === steps.length - 1;
          const dotColor =
            s.tone === 'positive' ? '#22c55e' :
            s.tone === 'amber'    ? '#f59e0b' :
            colors.primary;
          return (
            <View key={s.key} style={styles.row} testID={`cust-timeline-step-${idx}`}>
              <View style={styles.gutter}>
                <View style={[styles.dot, { backgroundColor: dotColor + '20', borderColor: dotColor }]}>
                  <Ionicons name={s.icon} size={14} color={dotColor} />
                </View>
                {!isLast && <View style={[styles.connector, { backgroundColor: colors.border }]} />}
              </View>
              <View style={styles.body}>
                <View style={styles.bodyHead}>
                  <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{s.title}</Text>
                  <Text style={[styles.time, { color: colors.text + '88' }]}>{fmtTime(s.at)}</Text>
                </View>
                {s.subtitle && (
                  <Text style={[styles.subtitle, { color: colors.text + 'AA' }]} numberOfLines={2}>
                    {s.subtitle}
                  </Text>
                )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loadingWrap: { alignItems: 'center', justifyContent: 'center', paddingVertical: 16 },
  container: { marginHorizontal: 16, marginVertical: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  heading: { fontSize: 17, fontWeight: '600', marginLeft: 8 },
  subhead: { fontSize: 13, marginTop: 2, marginLeft: 28, marginBottom: 12 },
  rail: { borderRadius: 14, borderWidth: 1, padding: 16, paddingBottom: 4 },
  row: { flexDirection: 'row', minHeight: 56 },
  gutter: { width: 28, alignItems: 'center' },
  dot: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5 },
  connector: { width: 2, flex: 1, marginTop: 2 },
  body: { flex: 1, paddingLeft: 12, paddingBottom: 14 },
  bodyHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { fontSize: 15, fontWeight: '600', flexShrink: 1, paddingRight: 8 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  subtitle: { fontSize: 13, marginTop: 2 },
});
