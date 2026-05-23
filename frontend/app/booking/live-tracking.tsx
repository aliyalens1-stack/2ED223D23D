import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Dimensions, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useThemeContext } from '../../src/context/ThemeContext';
import { liveAPI } from '../../src/services/api';
import { useCustomerRealtime } from '../../src/hooks/useWebSocket';
import { theme } from '../../src/context/ThemeContext';
import { useTranslation } from 'react-i18next';
import i18n from '../../src/i18n';
const colors = theme.colors;

const { width, height } = Dimensions.get('window');
const MAP_HEIGHT = height * 0.42;

const STATUS_KEYS: Record<string, { color: string; icon: string; emoji: string }> = {
  confirmed: { color: colors.brand, icon: 'checkmark-circle', emoji: '✅' },
  on_route: { color: colors.warning, icon: 'car', emoji: '🚗' },
  arrived: { color: colors.brand, icon: 'location', emoji: '📍' },
  in_progress: { color: colors.brand, icon: 'construct', emoji: '🔧' },
  completed: { color: colors.success, icon: 'checkmark-done-circle', emoji: '🎉' },
};

function generateLeafletHTML(providerLat: number, providerLng: number, customerLat: number, customerLng: number, status: string, eta: number, etaShort: string) {
  const statusColor = STATUS_KEYS[status]?.color || colors.brand;
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  *{margin:0;padding:0}
  html,body,#map{width:100%;height:100%;background:#1a1a2e}
  .provider-marker{background:none;border:none}
  .provider-icon{width:44px;height:44px;border-radius:22px;background:${statusColor};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px ${statusColor}88;border:3px solid white;font-size:20px;line-height:44px;text-align:center;animation:pulse 2s infinite}
  .customer-icon{width:16px;height:16px;border-radius:8px;background:#3B82F6;border:3px solid white;box-shadow:0 2px 8px rgba(59,130,246,0.5)}
  .eta-popup{background:${statusColor};color:white;border:none;border-radius:20px;padding:6px 14px;font:700 14px/1 -apple-system,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3)}
  .eta-popup .leaflet-popup-content-wrapper{background:${statusColor};color:white;border-radius:20px;box-shadow:none}
  .eta-popup .leaflet-popup-tip{border-top-color:${statusColor}}
  .eta-popup .leaflet-popup-content{margin:0;text-align:center}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.15);opacity:0.85}}
</style>
</head><body>
<div id="map"></div>
<script>
var map=L.map('map',{zoomControl:false,attributionControl:false}).setView([${providerLat},${providerLng}],14);
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{maxZoom:19}).addTo(map);

var provIcon=L.divIcon({className:'provider-marker',html:'<div class="provider-icon">🚗</div>',iconSize:[44,44],iconAnchor:[22,22]});
var custIcon=L.divIcon({className:'provider-marker',html:'<div class="customer-icon"></div>',iconSize:[16,16],iconAnchor:[8,8]});

var provMarker=L.marker([${providerLat},${providerLng}],{icon:provIcon}).addTo(map);
var custMarker=L.marker([${customerLat},${customerLng}],{icon:custIcon}).addTo(map);

var etaLabel=${JSON.stringify(etaShort)};
var etaPopup=L.popup({className:'eta-popup',closeButton:false,autoClose:false,closeOnClick:false,offset:[0,-28]})
  .setLatLng([${providerLat},${providerLng}])
  .setContent('⏱ '+etaLabel)
  .openOn(map);

var routeLine=L.polyline([[${providerLat},${providerLng}],[${customerLat},${customerLng}]],{color:'${statusColor}',weight:4,opacity:0.6,dashArray:'8,12'}).addTo(map);

var group=L.featureGroup([provMarker,custMarker]);
map.fitBounds(group.getBounds().pad(0.3));

var targetLat=${providerLat},targetLng=${providerLng},curLat=${providerLat},curLng=${providerLng};

function smoothMove(){
  var dx=targetLat-curLat,dy=targetLng-curLng;
  if(Math.abs(dx)>0.00001||Math.abs(dy)>0.00001){
    curLat+=dx*0.08;curLng+=dy*0.08;
    provMarker.setLatLng([curLat,curLng]);
    etaPopup.setLatLng([curLat,curLng]);
    routeLine.setLatLngs([[curLat,curLng],[${customerLat},${customerLng}]]);
  }
  requestAnimationFrame(smoothMove);
}
smoothMove();

window.updateProvider=function(lat,lng,etaText,status){
  targetLat=lat;targetLng=lng;
  if(etaText)etaPopup.setContent('⏱ '+etaText);
};
</script></body></html>`;
}

export default function LiveTrackingScreen() {
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const styles = makeStyles(colors);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [liveData, setLiveData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const webViewRef = useRef<any>(null);

  const loadLiveData = useCallback(async () => {
    if (!id) return;
    try {
      const res = await liveAPI.getCustomerLiveView(id);
      setLiveData(res.data);
      setError(null);
    } catch (e: any) {
      if (e?.response?.status === 404) setError(i18n.t('tracking.not_found'));
      else console.log('Live tracking error:', e);
    } finally { setLoading(false); }
  }, [id, t]);

  useEffect(() => {
    loadLiveData();
    const iv = setInterval(loadLiveData, 3000);
    return () => clearInterval(iv);
  }, [loadLiveData]);

  // WebSocket realtime updates
  useCustomerRealtime(id, {
    onStatusChanged: (data) => {
      if (data.status) {
        setLiveData((prev: any) => prev ? { ...prev, status: data.status, eta: data.eta || prev.eta } : prev);
      }
    },
    onProviderLocation: (data) => {
      setLiveData((prev: any) => prev ? { ...prev, providerLocation: { lat: data.lat, lng: data.lng }, eta: data.etaMinutes || prev.eta } : prev);
      // Smooth update map marker via injected JS
      if (webViewRef.current && data.lat && data.lng) {
        webViewRef.current.injectJavaScript(`window.updateProvider(${data.lat},${data.lng},${data.etaMinutes || 0},'${data.status || ''}');true;`);
      }
    },
  });

  // Update map when liveData changes
  useEffect(() => {
    if (webViewRef.current && liveData?.providerLocation) {
      const { lat, lng } = liveData.providerLocation;
      webViewRef.current.injectJavaScript(`window.updateProvider(${lat},${lng},${liveData.eta || 0},'${liveData.status || ''}');true;`);
    }
  }, [liveData?.providerLocation?.lat, liveData?.providerLocation?.lng]);

  const statusConfig = STATUS_KEYS[liveData?.status] || STATUS_KEYS.confirmed;
  const statusLabel = i18n.t(`tracking.status.${liveData?.status || 'confirmed'}`);
  const etaShort = i18n.t('tracking.eta_short', { n: liveData?.eta ?? 10 });

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>{t('tracking.loading_map')}</Text>
      </View>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} testID="tracking-back-btn">
            <Ionicons name="arrow-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('tracking.title')}</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle-outline" size={64} color={colors.error} />
          <Text style={[styles.errorText, { color: colors.text }]}>{error}</Text>
        </View>
      </SafeAreaView>
    );
  }

  const provLat = liveData?.providerLocation?.lat || 50.4501;
  const provLng = liveData?.providerLocation?.lng || 30.5234;
  const custLat = 50.4520;
  const custLng = 30.5210;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} testID="live-tracking-screen">
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} testID="tracking-back-btn">
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('tracking.title')}</Text>
          <View style={[styles.liveIndicatorSmall, { backgroundColor: statusConfig.color + '20' }]}>
            <View style={[styles.liveDotSmall, { backgroundColor: statusConfig.color }]} />
            <Text style={[styles.liveTextSmall, { color: statusConfig.color }]}>Live</Text>
          </View>
        </View>
        <TouchableOpacity onPress={loadLiveData} testID="tracking-refresh-btn">
          <Ionicons name="refresh" size={22} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Status Banner */}
      <View style={[styles.statusBanner, { backgroundColor: statusConfig.color + '15' }]} testID="status-banner">
        <Text style={styles.statusEmoji}>{statusConfig.emoji}</Text>
        <View>
          <Text style={[styles.statusLabel, { color: statusConfig.color }]}>{statusLabel}</Text>
          {liveData?.eta != null && liveData.status === 'on_route' && (
            <Text style={[styles.etaSmall, { color: statusConfig.color }]}>{t('tracking.eta_minutes', { n: liveData.eta })}</Text>
          )}
        </View>
        {liveData?.eta != null && (
          <View style={[styles.etaBadge, { backgroundColor: statusConfig.color }]}>
            <Text style={styles.etaBadgeText}>{t('tracking.eta_short', { n: liveData.eta })}</Text>
          </View>
        )}
      </View>

      {/* Map */}
      <View style={styles.mapContainer} testID="tracking-map">
        <WebView
          ref={webViewRef}
          source={{ html: generateLeafletHTML(provLat, provLng, custLat, custLng, liveData?.status || 'confirmed', liveData?.eta || 10, etaShort) }}
          style={styles.map}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          scrollEnabled={false}
          bounces={false}
          originWhitelist={['*']}
        />
      </View>

      {/* Bottom Sheet */}
      <View style={[styles.bottomSheet, { backgroundColor: colors.card }]}>
        {/* Provider Info */}
        {liveData?.providerName && (
          <View style={styles.providerRow} testID="provider-info">
            <View style={[styles.providerAvatar, { backgroundColor: statusConfig.color + '15' }]}>
              <Ionicons name="car-sport" size={24} color={statusConfig.color} />
            </View>
            <View style={styles.providerInfo}>
              <Text style={[styles.providerName, { color: colors.text }]}>{liveData.providerName}</Text>
              <Text style={[styles.providerService, { color: colors.textSecondary }]}>{liveData.serviceName || t('tracking.service_default')}</Text>
            </View>
            <TouchableOpacity testID="call-provider-btn" style={[styles.callBtn, { backgroundColor: '#22C55E15' }]}>
              <Ionicons name="call" size={18} color={colors.success} />
            </TouchableOpacity>
          </View>
        )}

        {/* Timeline */}
        <View style={styles.miniTimeline}>
          {Object.entries(STATUS_KEYS).map(([key, config], i) => {
            const statusKeys = Object.keys(STATUS_KEYS);
            const currentIdx = statusKeys.indexOf(liveData?.status || 'confirmed');
            const stepIdx = statusKeys.indexOf(key);
            const isDone = stepIdx < currentIdx;
            const isActive = stepIdx === currentIdx;
            return (
              <View key={key} style={styles.miniTimelineStep}>
                <View style={[styles.miniDot, { backgroundColor: isDone ? colors.success : isActive ? config.color : colors.border }]}>
                  {isDone && <Ionicons name="checkmark" size={8} color="#FFF" />}
                </View>
                {i < statusKeys.length - 1 && (
                  <View style={[styles.miniLine, { backgroundColor: isDone ? colors.success : colors.border }]} />
                )}
              </View>
            );
          })}
        </View>

        {liveData?.status === 'completed' && (
          <TouchableOpacity
            style={[styles.reviewBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.push(`/review/create?bookingId=${id}`)}
            testID="leave-review-btn"
          >
            <Ionicons name="star" size={18} color="#FFF" />
            <Text style={styles.reviewBtnText}>{t('tracking.leave_review')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (colors: any) => StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1 },
  headerCenter: { flex: 1, flexDirection: 'row', alignItems: 'center', marginLeft: 12, gap: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700' },
  liveIndicatorSmall: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, gap: 4 },
  liveDotSmall: { width: 6, height: 6, borderRadius: 3 },
  liveTextSmall: { fontSize: 10, fontWeight: '700' },
  errorContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  errorText: { fontSize: 16, fontWeight: '600' },
  statusBanner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 14, gap: 10 },
  statusEmoji: { fontSize: 28 },
  statusLabel: { fontSize: 16, fontWeight: '700' },
  etaSmall: { fontSize: 12, marginTop: 1 },
  etaBadge: { marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  etaBadgeText: { color: '#FFF', fontSize: 14, fontWeight: '800' },
  mapContainer: { flex: 1, margin: 12, borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.border },
  map: { flex: 1, backgroundColor: colors.card },
  bottomSheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 16, paddingTop: 16, paddingBottom: Platform.OS === 'ios' ? 34 : 16, shadowColor: '#000', shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.1, shadowRadius: 12, elevation: 8 },
  providerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  providerAvatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  providerInfo: { flex: 1 },
  providerName: { fontSize: 16, fontWeight: '700' },
  providerService: { fontSize: 13, marginTop: 2 },
  callBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  miniTimeline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 0, paddingVertical: 4 },
  miniTimelineStep: { flexDirection: 'row', alignItems: 'center' },
  miniDot: { width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  miniLine: { width: 32, height: 2, marginHorizontal: 2 },
  reviewBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 14, borderRadius: 14, gap: 8, marginTop: 12 },
  reviewBtnText: { color: '#FFF', fontSize: 15, fontWeight: '700' },
});
