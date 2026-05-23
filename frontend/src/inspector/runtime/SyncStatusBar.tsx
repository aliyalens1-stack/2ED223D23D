/**
 * Sprint 2 · Step 5 — SyncStatusBar.
 *
 * Persistent runtime UI surface that reflects offline-queue state.
 *
 * States rendered (per spec):
 *   • "Все синхронизировано"          → queue empty
 *   • "N pending uploads"             → has pending/running items
 *   • "Offline · changes queued"      → has work AND offline
 *   • "Retrying…"                     → at least one item is `running`
 *   • "Требуется действие"            → has items in `failed` (≥ MAX_ATTEMPTS)
 *
 * Tappable: opens a sheet listing failed items with retry/discard.
 * Always visible in runtime screens — caller drops it into a fixed slot.
 *
 * Wiring:
 *   import { SyncStatusBar, useQueueController } from '@/src/inspector/runtime/SyncStatusBar';
 *   const ctrl = useQueueController({ apiBase, getToken });
 *   <SyncStatusBar controller={ctrl} />
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView, AppState,
  AppStateStatus, ActivityIndicator,
} from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import {
  QueueItem, QueueSnapshot, replay, retryFailed, discard, getSnapshot,
  loadQueue, stopReplay, resumeReplay, subscribeQueue, summarize,
} from './queue';

// ─────────────────────────────────────────────────────────────────────
// Hook: useQueueController
// Owns:
//   - hydration on mount
//   - NetInfo listener (replay on reconnect)
//   - AppState listener (replay on foreground)
//   - logout cleanup (stopReplay)
// Returns:
//   - reactive snapshot
//   - online flag
//   - manual retryAll() + per-item retry/discard
// ─────────────────────────────────────────────────────────────────────

export interface QueueControllerOpts {
  apiBase: string;
  getToken: () => Promise<string | null>;
  /** Disable auto-replay (e.g. user logged out). Defaults to false. */
  paused?: boolean;
}

export interface QueueController {
  snapshot: QueueSnapshot;
  online: boolean;
  busy: boolean;
  triggerReplay: () => void;
  retryFailed: (id: string) => Promise<void>;
  discardItem: (id: string) => Promise<void>;
}

export function useQueueController(opts: QueueControllerOpts): QueueController {
  const [snapshot, setSnapshot] = useState<QueueSnapshot>({ items: [], rev: 0 });
  const [online, setOnline] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const pausedRef = useRef<boolean>(!!opts.paused);
  pausedRef.current = !!opts.paused;

  // Network reachability (cached)
  const isOnlineRef = useRef<boolean>(true);

  // Mounted guard so we don't setState after unmount
  const aliveRef = useRef<boolean>(true);

  const runReplay = useMemo(() => async () => {
    if (pausedRef.current) return;
    if (!isOnlineRef.current) return;
    if (!aliveRef.current) return;
    setBusy(true);
    try {
      await replay({
        apiBase: opts.apiBase,
        getToken: opts.getToken,
        isOnline: async () => isOnlineRef.current,
      });
    } catch { /* never crash UI on replay errors */ }
    finally {
      if (aliveRef.current) setBusy(false);
    }
  }, [opts.apiBase, opts.getToken]);

  // Hydrate + subscribe + listeners
  useEffect(() => {
    aliveRef.current = true;
    (async () => {
      await loadQueue();
      const snap = await getSnapshot();
      if (aliveRef.current) setSnapshot(snap);
      // Initial replay attempt (may be a no-op if offline)
      runReplay();
    })();

    const unsubQueue = subscribeQueue((s) => {
      if (aliveRef.current) setSnapshot(s);
    });

    const unsubNet = NetInfo.addEventListener((state: NetInfoState) => {
      const reachable =
        !!state.isConnected
        && (state.isInternetReachable !== false); // null/true both OK
      const wasOffline = !isOnlineRef.current;
      isOnlineRef.current = reachable;
      if (aliveRef.current) setOnline(reachable);
      if (reachable && wasOffline) runReplay();
    });

    const onAppState = (s: AppStateStatus) => {
      if (s === 'active') runReplay();
    };
    const appSub = AppState.addEventListener('change', onAppState);

    // initial NetInfo fetch (web/Expo can return stale state)
    NetInfo.fetch().then((state) => {
      const reachable = !!state.isConnected && (state.isInternetReachable !== false);
      isOnlineRef.current = reachable;
      if (aliveRef.current) setOnline(reachable);
    }).catch(() => {});

    return () => {
      aliveRef.current = false;
      unsubQueue();
      unsubNet();
      appSub.remove?.();
    };
  }, [runReplay]);

  // Toggle pause/resume when opts.paused flips
  useEffect(() => {
    if (opts.paused) stopReplay();
    else resumeReplay();
  }, [opts.paused]);

  return {
    snapshot,
    online,
    busy,
    triggerReplay: () => { runReplay(); },
    retryFailed: async (id: string) => {
      await retryFailed(id);
      runReplay();
    },
    discardItem: async (id: string) => { await discard(id); },
  };
}

// ─────────────────────────────────────────────────────────────────────
// SyncStatusBar
// ─────────────────────────────────────────────────────────────────────

export function SyncStatusBar({ controller }: { controller: QueueController }) {
  const [open, setOpen] = useState(false);
  const { snapshot, online, busy, triggerReplay, retryFailed, discardItem } = controller;
  const s = useMemo(() => summarize(snapshot.items.filter((i) => i.status !== 'done')), [snapshot]);

  // Default: hidden when nothing to show AND we are online.
  // When offline, ALWAYS show (per spec — "must always be visible in runtime screens").
  if (!online === false && !s.hasWork && s.total === 0) {
    // fallthrough to render `All synced` chip
  }

  const label = bannerLabel({ online, busy, summary: s });
  const tone = bannerTone({ online, summary: s });

  return (
    <>
      <TouchableOpacity
        style={[styles.bar, tone.bg, tone.border]}
        onPress={() => setOpen(true)}
        activeOpacity={0.85}
        testID="sync-status-bar"
      >
        <View style={[styles.dot, { backgroundColor: tone.dot }]} />
        <Text style={[styles.label, { color: tone.fg }]} numberOfLines={1}>
          {label}
        </Text>
        {busy && <ActivityIndicator size="small" color={tone.fg} style={{ marginLeft: 6 }} />}
        {s.total > 0 && (
          <Text style={[styles.count, { color: tone.fg }]}>{s.pending + s.running + s.failed}</Text>
        )}
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet} testID="sync-status-sheet">
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Очередь синхронизации</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.sheetClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.sheetMetaRow}>
              <SheetMeta label="Pending" value={s.pending} />
              <SheetMeta label="Running" value={s.running} />
              <SheetMeta label="Failed"  value={s.failed} dim={s.failed === 0} />
              <SheetMeta label="Online"  value={online ? 'yes' : 'no'} />
            </View>

            <TouchableOpacity
              style={[styles.replayBtn, (busy || !online) && { opacity: 0.5 }]}
              onPress={triggerReplay}
              disabled={busy || !online}
              testID="sync-trigger-replay"
            >
              <Text style={styles.replayBtnText}>
                {busy ? 'Идёт синхронизация…' : 'Повторить сейчас'}
              </Text>
            </TouchableOpacity>

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 12 }}>
              {snapshot.items.filter((i) => i.status !== 'done').length === 0 && (
                <Text style={styles.empty}>Очередь пуста — всё ушло на сервер.</Text>
              )}
              {snapshot.items.filter((i) => i.status !== 'done').map((it) => (
                <ItemRow
                  key={it.id}
                  item={it}
                  onRetry={() => retryFailed(it.id)}
                  onDiscard={() => discardItem(it.id)}
                />
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

function SheetMeta({ label, value, dim }: { label: string; value: number | string; dim?: boolean }) {
  return (
    <View style={[styles.sheetMetaCell, dim && { opacity: 0.5 }]}>
      <Text style={styles.sheetMetaLabel}>{label}</Text>
      <Text style={styles.sheetMetaValue}>{value}</Text>
    </View>
  );
}

function ItemRow({ item, onRetry, onDiscard }: {
  item: QueueItem;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const kindLabel: Record<string, string> = {
    media_upload: '📷 Медиа',
    draft_generate: '🤖 Черновик',
    report_submit: '📋 Отчёт',
  };
  const statusLabel: Record<string, string> = {
    pending: 'ждёт',
    running: 'идёт',
    failed: 'не отправлено',
    done: 'готово',
  };
  return (
    <View style={styles.row} testID={`sync-item-${item.id}`}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>
          {kindLabel[item.kind] || item.kind} · <Text style={styles.rowMuted}>{statusLabel[item.status]}</Text>
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          job {item.jobId.substring(0, 8)} · attempts {item.attempts}/{5}
          {item.lastLatencyMs ? ` · ${item.lastLatencyMs}ms` : ''}
        </Text>
        {item.lastError ? (
          <Text style={styles.rowError} numberOfLines={2}>{item.lastError}</Text>
        ) : null}
      </View>
      {(item.status === 'failed' || item.status === 'pending') && (
        <View style={styles.rowActions}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.actionBtnPrimary]}
            onPress={onRetry}
            testID={`sync-item-retry-${item.id}`}
          >
            <Text style={styles.actionBtnTextPrimary}>Повторить</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={onDiscard}
            testID={`sync-item-discard-${item.id}`}
          >
            <Text style={styles.actionBtnText}>Удалить</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Banner copy / palette
// ─────────────────────────────────────────────────────────────────────

function bannerLabel(args: {
  online: boolean;
  busy: boolean;
  summary: ReturnType<typeof summarize>;
}): string {
  const { online, busy, summary } = args;
  if (summary.failed > 0) return `Требуется действие · ${summary.failed} не отправлено`;
  if (!online && summary.hasWork) return `Офлайн · ${summary.pending + summary.running} в очереди`;
  if (busy || summary.running > 0) return summary.pending + summary.running > 1
    ? `Отправляется ${summary.pending + summary.running}…`
    : 'Отправка…';
  if (summary.pending > 0) return `${summary.pending} в ожидании отправки`;
  if (!online) return 'Офлайн · готово к работе';
  return 'Все синхронизировано';
}

interface Tone {
  bg: { backgroundColor: string };
  border: { borderColor: string };
  fg: string;
  dot: string;
}

function bannerTone(args: {
  online: boolean;
  summary: ReturnType<typeof summarize>;
}): Tone {
  const { online, summary } = args;
  if (summary.failed > 0) {
    return { bg: { backgroundColor: '#2a1010' }, border: { borderColor: '#7f1d1d' }, fg: '#fecaca', dot: '#ef4444' };
  }
  if (!online) {
    return { bg: { backgroundColor: '#181818' }, border: { borderColor: '#404040' }, fg: '#d4d4d8', dot: '#a3a3a3' };
  }
  if (summary.running > 0 || summary.pending > 0) {
    return { bg: { backgroundColor: '#1f1908' }, border: { borderColor: '#a16207' }, fg: '#fde68a', dot: '#FFB020' };
  }
  return { bg: { backgroundColor: '#0a1a0c' }, border: { borderColor: '#14532d' }, fg: '#bbf7d0', dot: '#22c55e' };
}

// ─────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 8,
    borderTopWidth: 1, borderBottomWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  label: { fontSize: 12, fontWeight: '700', flex: 1, letterSpacing: 0.3 },
  count: { fontSize: 12, fontWeight: '900', marginLeft: 6 },

  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#0a0a0a',
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    maxHeight: '85%', minHeight: '50%',
    borderTopWidth: 1, borderColor: '#2E2E2E',
  },
  sheetHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#2E2E2E',
  },
  sheetTitle: { fontSize: 15, fontWeight: '900', color: '#FFF', letterSpacing: 0.5 },
  sheetClose: { fontSize: 18, color: '#A1A1AA', fontWeight: '700' },

  sheetMetaRow: { flexDirection: 'row', paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  sheetMetaCell: {
    flex: 1, padding: 10, borderRadius: 10,
    backgroundColor: '#161616', borderWidth: 1, borderColor: '#2a2a2a',
  },
  sheetMetaLabel: { fontSize: 10, color: '#A1A1AA', letterSpacing: 1.2, fontWeight: '700' },
  sheetMetaValue: { fontSize: 16, color: '#FFF', fontWeight: '900', marginTop: 2 },

  replayBtn: {
    marginHorizontal: 12, marginBottom: 8, paddingVertical: 12, borderRadius: 10,
    backgroundColor: '#FFB020', alignItems: 'center',
  },
  replayBtnText: { fontSize: 13, fontWeight: '900', color: '#000', letterSpacing: 0.5 },

  empty: { color: '#71717A', fontSize: 13, padding: 24, textAlign: 'center' },

  row: {
    flexDirection: 'row',
    padding: 12, borderRadius: 10, marginBottom: 8,
    backgroundColor: '#141414', borderWidth: 1, borderColor: '#2a2a2a',
    gap: 12, alignItems: 'flex-start',
  },
  rowTitle: { fontSize: 13, fontWeight: '800', color: '#FFF' },
  rowMuted: { fontWeight: '600', color: '#A1A1AA' },
  rowMeta: { fontSize: 11, color: '#A1A1AA', marginTop: 4 },
  rowError: { fontSize: 11, color: '#fda4af', marginTop: 6, lineHeight: 16 },

  rowActions: { gap: 6, alignItems: 'flex-end' },
  actionBtn: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 6, borderWidth: 1, borderColor: '#3f3f46',
    backgroundColor: 'transparent',
  },
  actionBtnPrimary: { backgroundColor: '#FFB020', borderColor: '#FFB020' },
  actionBtnText: { fontSize: 11, fontWeight: '800', color: '#D4D4D8' },
  actionBtnTextPrimary: { fontSize: 11, fontWeight: '900', color: '#000' },
});
