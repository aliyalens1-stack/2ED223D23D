import React, { useState, useEffect } from 'react';
import {View, Text, StyleSheet, TouchableOpacity, Animated, Platform} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useThemeContext } from '../../context/ThemeContext';
import { demandAPI } from '../../services/api';
import { theme } from '../../src/context/ThemeContext';
const colors = theme.colors;

export function SurgeIndicator() {
  const { colors } = useThemeContext();
  const [surgeData, setSurgeData] = useState<any>(null);
  const [visible, setVisible] = useState(false);
  const pulseAnim = React.useRef(new Animated.Value(1)).current;

  useEffect(() => {
    loadSurge();
    const iv = setInterval(loadSurge, 60000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (surgeData?.isSurgeActive) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.1, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: Platform.OS !== 'web' }),
        ])
      ).start();
    }
  }, [surgeData?.isSurgeActive]);

  const loadSurge = async () => {
    try {
      const res = await demandAPI.getSurge();
      setSurgeData(res.data);
      setVisible(res.data?.isSurgeActive || false);
    } catch { setVisible(false); }
  };

  if (!visible || !surgeData) return null;

  const multiplier = surgeData.surgeMultiplier || 1;
  const isHigh = multiplier >= 1.5;

  return (
    <Animated.View testID="surge-indicator" style={[styles.container, {
      backgroundColor: isHigh ? colors.error + '15' : colors.warning + '15',
      borderColor: isHigh ? colors.error + '30' : colors.warning + '30',
      transform: [{ scale: pulseAnim }],
    }]}>
      <View style={[styles.iconWrap, { backgroundColor: isHigh ? colors.error + '20' : colors.warning + '20' }]}>
        <Ionicons name="trending-up" size={18} color={isHigh ? colors.error : colors.warning} />
      </View>
      <View style={styles.textWrap}>
        <Text style={[styles.title, { color: isHigh ? colors.error : colors.warning }]}>
          {isHigh ? 'Высокий спрос' : 'Повышенный спрос'}
        </Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Цена x{multiplier.toFixed(1)} • {surgeData.marketState || 'surge'}
        </Text>
      </View>
      <TouchableOpacity onPress={() => setVisible(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Ionicons name="close-circle" size={20} color={colors.textMuted} />
      </TouchableOpacity>
    </Animated.View>
  );
}

export function ZoneDemandBanner() {
  const { colors } = useThemeContext();
  const [hotAreas, setHotAreas] = useState<any[]>([]);

  useEffect(() => {
    loadHotAreas();
    const iv = setInterval(loadHotAreas, 120000);
    return () => clearInterval(iv);
  }, []);

  const loadHotAreas = async () => {
    try {
      const res = await demandAPI.getHotAreas();
      setHotAreas(Array.isArray(res.data) ? res.data.slice(0, 3) : []);
    } catch { /* silently fail */ }
  };

  if (hotAreas.length === 0) return null;

  return (
    <View testID="zone-demand-banner" style={[styles.zoneBanner, { backgroundColor: colors.info + '10', borderColor: colors.info + '20' }]}>
      <View style={styles.zoneBannerHeader}>
        <Ionicons name="location" size={16} color={colors.info} />
        <Text style={[styles.zoneBannerTitle, { color: colors.info }]}>В вашем районе высокий спрос</Text>
      </View>
      {hotAreas.map((area, i) => (
        <View key={i} style={styles.zoneItem}>
          <View style={[styles.zoneDot, { backgroundColor: area.ratio > 3 ? colors.error : colors.warning }]} />
          <Text style={[styles.zoneName, { color: colors.text }]}>{area.name || area.zoneName || `Зона ${i + 1}`}</Text>
          <Text style={[styles.zoneRatio, { color: colors.textSecondary }]}>x{(area.ratio || 1).toFixed(1)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 14, borderWidth: 1, gap: 10,
  },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  textWrap: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 1 },
  zoneBanner: { padding: 12, borderRadius: 14, borderWidth: 1, gap: 8 },
  zoneBannerHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  zoneBannerTitle: { fontSize: 13, fontWeight: '600' },
  zoneItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 22 },
  zoneDot: { width: 6, height: 6, borderRadius: 3 },
  zoneName: { flex: 1, fontSize: 13 },
  zoneRatio: { fontSize: 12, fontWeight: '600' },
});
