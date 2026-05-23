// ═══════════════════════════════════════════════════════════
// 🔥 LiveRequests — realtime card list for ProviderHome
// Sprint Realtime: новые quick-request падают сюда через
// useProviderRealtime → setLiveRequests([new, ...prev]).
// Каждая карточка: problem + echo + ETA/distance/price + countdown.
// Accept (amber) / Reject (ghost) → quickRequestAPI.
// Auto-prune после expiresAt.
// ═══════════════════════════════════════════════════════════
import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../context/ThemeContext';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export type LiveRequest = {
  requestId: string;
  problemLabel?: string;
  echoText?: string;
  priceEstimate?: number | null;
  finalPrice?: number | null;
  etaText?: string;
  distanceText?: string;
  expiresAt?: string;          // ISO
  expiresInSec?: number;
  surge?: number;
  surgeLabel?: string;
};

type Props = {
  requests: LiveRequest[];
  onAccept: (req: LiveRequest) => Promise<void> | void;
  onReject: (req: LiveRequest) => Promise<void> | void;
  onExpire?: (req: LiveRequest) => void;
};

export default function LiveRequests({ requests, onAccept, onReject, onExpire }: Props) {
  if (!requests || requests.length === 0) return null;
  return (
    <View style={styles.wrap} testID="live-requests">
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <View style={styles.livePulse} />
          <Text style={styles.title}>Новые заявки</Text>
        </View>
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{requests.length}</Text>
        </View>
      </View>
      {requests.slice(0, 3).map((r) => (
        <RequestCard
          key={r.requestId}
          request={r}
          onAccept={onAccept}
          onReject={onReject}
          onExpire={onExpire}
        />
      ))}
    </View>
  );
}

// ───────────────────────────────────────────────
function RequestCard({
  request,
  onAccept,
  onReject,
  onExpire,
}: {
  request: LiveRequest;
  onAccept: (r: LiveRequest) => Promise<void> | void;
  onReject: (r: LiveRequest) => Promise<void> | void;
  onExpire?: (r: LiveRequest) => void;
}) {
  const { colors } = useThemeContext();
  const expiresAtMs = useMemo(() => {
    if (request.expiresAt) return new Date(request.expiresAt).getTime();
    if (request.expiresInSec) return Date.now() + request.expiresInSec * 1000;
    return Date.now() + 60_000; // 60s fallback
  }, [request.expiresAt, request.expiresInSec]);

  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));

  // Auto-expire callback
  useEffect(() => {
    if (secondsLeft === 0 && onExpire) onExpire(request);
  }, [secondsLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  const price = request.finalPrice ?? request.priceEstimate;
  const urgent = secondsLeft <= 10;

  const handleAccept = async () => {
    if (busy) return;
    setBusy('accept');
    try {
      await onAccept(request);
    } finally {
      setBusy(null);
    }
  };
  const handleReject = async () => {
    if (busy) return;
    setBusy('reject');
    try {
      await onReject(request);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View
      testID={`live-request-${request.requestId}`}
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      {/* Top row: problem + countdown */}
      <View style={styles.topRow}>
        <View style={styles.problemBlock}>
          <Text style={[styles.problemLabel, { color: colors.text }]} numberOfLines={1}>
            {request.problemLabel || 'Новая заявка'}
          </Text>
          {!!request.echoText && (
            <Text style={[styles.echo, { color: colors.textSecondary }]} numberOfLines={2}>
              «{request.echoText}»
            </Text>
          )}
        </View>
        <View
          style={[
            styles.timerPill,
            {
              backgroundColor: urgent ? colors.errorBg || 'rgba(239,68,68,0.15)' : colors.brandSoft,
            },
          ]}
        >
          <Ionicons
            name="time-outline"
            size={12}
            color={urgent ? colors.error : colors.brand}
          />
          <Text style={[styles.timerText, { color: urgent ? colors.error : colors.brand }]}>
            {secondsLeft}s
          </Text>
        </View>
      </View>

      {/* Meta row: distance / eta / price */}
      <View style={styles.metaRow}>
        {!!request.distanceText && (
          <View style={styles.metaItem}>
            <Ionicons name="navigate-outline" size={13} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>{request.distanceText}</Text>
          </View>
        )}
        {!!request.etaText && (
          <View style={styles.metaItem}>
            <Ionicons name="walk-outline" size={13} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>{request.etaText}</Text>
          </View>
        )}
        {price != null && (
          <View style={styles.metaItem}>
            <Ionicons name="cash-outline" size={13} color={colors.success || colors.brand} />
            <Text style={[styles.metaPrice, { color: colors.success || colors.brand }]}>₴{price}</Text>
          </View>
        )}
        {!!request.surgeLabel && (request.surge || 0) > 1 && (
          <View style={[styles.surgePill, { backgroundColor: colors.errorBg || 'rgba(239,68,68,0.12)' }]}>
            <Ionicons name="flame" size={11} color={colors.error} />
            <Text style={[styles.surgeText, { color: colors.error }]}>{request.surgeLabel}</Text>
          </View>
        )}
      </View>

      {/* Action buttons */}
      <View style={styles.actionRow}>
        <TouchableOpacity
          testID={`reject-${request.requestId}`}
          activeOpacity={0.85}
          onPress={handleReject}
          disabled={!!busy}
          style={[styles.ghostBtn, { borderColor: colors.border }]}
        >
          {busy === 'reject' ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : (
            <Text style={[styles.ghostText, { color: colors.textSecondary }]}>Пропустить</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          testID={`accept-${request.requestId}`}
          activeOpacity={0.9}
          onPress={handleAccept}
          disabled={!!busy}
          style={[styles.acceptBtn, { backgroundColor: colors.brand }]}
        >
          {busy === 'accept' ? (
            <ActivityIndicator size="small" color={colors.onPrimary || colors.brandText} />
          ) : (
            <>
              <Ionicons name="checkmark-circle" size={18} color={colors.onPrimary || colors.brandText} />
              <Text style={[styles.acceptText, { color: colors.onPrimary || colors.brandText }]}>Принять</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 20, marginBottom: 16 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  livePulse: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand,
  },
  title: { fontSize: 16, fontWeight: '700' },
  countBadge: {
    minWidth: 22, paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: 11, backgroundColor: 'rgba(239,68,68,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  countText: { fontSize: 11, fontWeight: '700', color: colors.brand },
  card: {
    borderRadius: 14, padding: 14, marginBottom: 10,
    borderWidth: 1,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 8 },
  problemBlock: { flex: 1 },
  problemLabel: { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  echo: { fontSize: 12, fontStyle: 'italic' },
  timerPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8,
  },
  timerText: { fontSize: 11, fontWeight: '700' },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 12 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { fontSize: 12, fontWeight: '500' },
  metaPrice: { fontSize: 13, fontWeight: '700' },
  surgePill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  surgeText: { fontSize: 10, fontWeight: '700' },
  actionRow: { flexDirection: 'row', gap: 8 },
  ghostBtn: {
    flex: 1, height: 42, borderRadius: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  ghostText: { fontSize: 13, fontWeight: '600' },
  acceptBtn: {
    flex: 2, height: 42, borderRadius: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  acceptText: { fontSize: 14, fontWeight: '800' },
});
