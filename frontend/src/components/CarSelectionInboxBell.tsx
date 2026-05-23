/**
 * CarSelectionInboxBell — Phase 8.1 awareness badge.
 *
 * Ambient awareness for the car-selection notifications inbox. Reads
 * GET /api/car-selection/notifications/me?unread_only=true and
 * shows a small count chip if > 0. Tap routes to the inbox screen.
 *
 * Discipline (matches Phase 8.1 brief):
 *   • Count-only. NO dropdown. NO preview list. NO grouped digests.
 *   • NO realtime websocket — pure poll on mount + focus.
 *   • Count consumes existing truth (the inbox endpoint). The bell
 *     does NOT introduce new semantics.
 *   • Tap → /car-selection-inbox. Nothing else.
 *
 * Why no dropdown:
 *   A dropdown would force this component to render arbitrary inbox
 *   rows and click-through routing, duplicating the inbox screen
 *   in miniature. That creates two awareness surfaces with subtly
 *   different behaviour. We refuse that and keep the bell as a
 *   pure indicator.
 *
 * Silent fail:
 *   401 / 403 → render disabled bell (no badge, no tap). The bell
 *   exists on shared chrome that guest users may briefly see; we do
 *   not want auth errors to break the screen.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';

import { api } from '../services/api';
import { tokens } from '../theme/tokens';
import { useThemeContext } from '../context/ThemeContext';

interface Props {
  /** Override testID for screens that need to disambiguate. */
  testID?: string;
}

const C = tokens.colors;

export default function CarSelectionInboxBell({ testID = 'cs-inbox-bell' }: Props) {
  const router = useRouter();
  const { isDark, colors } = useThemeContext();
  const [unread, setUnread] = useState<number>(0);
  const [enabled, setEnabled] = useState<boolean>(true);

  const fetchUnread = useCallback(async () => {
    try {
      const { data } = await api.get<{ unread: number; total: number }>(
        '/car-selection/notifications/me?limit=1&unread_only=true'
      );
      setUnread(Number(data?.unread || 0));
      setEnabled(true);
    } catch (e: any) {
      // 401 / 403 → bell present but disabled. Other errors → keep
      // last known count (don't flicker the badge on transient net
      // failures).
      const status = e?.response?.status;
      if (status === 401 || status === 403) {
        setUnread(0);
        setEnabled(false);
      }
    }
  }, []);

  useEffect(() => { fetchUnread(); }, [fetchUnread]);

  // Refresh on tab focus — awareness is ambient, not pushed. Polling
  // is intentional: no websocket complexity (Phase 8.1 invariant).
  useFocusEffect(useCallback(() => {
    fetchUnread();
  }, [fetchUnread]));

  const onPress = useCallback(() => {
    if (!enabled) return;
    router.push('/car-selection-inbox' as any);
  }, [router, enabled]);

  const tint = isDark ? C.textDark : C.textLight;
  const showBadge = enabled && unread > 0;
  const badgeText = unread > 99 ? '99+' : String(unread);

  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      disabled={!enabled}
      style={[styles.btn, { opacity: enabled ? 1 : 0.4 }]}
      hitSlop={10}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={showBadge ? `Inbox · ${unread} unread` : 'Inbox'}
    >
      <Ionicons name={showBadge ? 'briefcase' : 'briefcase-outline'} size={22} color={tint} />
      {showBadge ? (
        <View style={[styles.badge, { backgroundColor: C.brand, borderColor: colors?.background ?? C.bgDark }]} testID={`${testID}-count`}>
          <Text style={styles.badgeText}>{badgeText}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  badgeText: {
    color: '#000',
    fontSize: 10,
    fontWeight: '800',
    lineHeight: 12,
  },
});
