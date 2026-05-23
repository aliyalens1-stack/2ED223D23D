/**
 * Interactive map location picker.
 *
 * Lets the user pick a precise lat/lng by clicking / dragging on a Leaflet
 * light-map. On web — renders an <iframe srcDoc> with a postMessage bridge.
 * On native — WebView with `injectedJavaScript` + `onMessage`.
 *
 * Self-contained, reusable: just pass `{value, onChange, height?}`.
 */
import React, { useMemo, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
const WebView: any = Platform.OS === 'web' ? null : require('react-native-webview').WebView;

export interface LatLng { lat: number; lng: number; }

interface Props {
  value: LatLng;
  onChange: (next: LatLng) => void;
  height?: number;
  testID?: string;
}

function buildPickerHtml(initial: LatLng): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>html,body,#m{margin:0;height:100%;width:100%;background:#f5f7fb}</style>
</head><body><div id="m"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var map = L.map('m').setView([${initial.lat}, ${initial.lng}], 13);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png', { attribution:'© OSM, © CARTO', maxZoom: 19 }).addTo(map);
  var pinIcon = L.divIcon({ html:'<div style="background:#ef4444;color:#fff;width:32px;height:32px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;border:2px solid #fff"><span style="transform:rotate(45deg);font-size:14px">📍</span></div>', className:'', iconSize:[32,32], iconAnchor:[16,32] });
  var marker = L.marker([${initial.lat}, ${initial.lng}], { draggable: true, icon: pinIcon }).addTo(map);
  function emit(latlng){
    var payload = JSON.stringify({ type:'location', lat: latlng.lat, lng: latlng.lng });
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(payload);
    if (window.parent) window.parent.postMessage(payload, '*');
  }
  marker.on('dragend', function(e){ emit(e.target.getLatLng()); });
  map.on('click', function(e){ marker.setLatLng(e.latlng); emit(e.latlng); });
</script></body></html>`;
}

export default function MapLocationPicker({ value, onChange, height = 320, testID }: Props) {
  const html = useMemo(() => buildPickerHtml(value), [value.lat, value.lng]);
  const lastEmit = useRef<string>('');

  // Single message handler reused by both platforms.
  const handleMessage = (raw: string) => {
    try {
      if (raw === lastEmit.current) return;
      lastEmit.current = raw;
      const data = JSON.parse(raw);
      if (data?.type === 'location' && Number.isFinite(data.lat) && Number.isFinite(data.lng)) {
        onChange({ lat: data.lat, lng: data.lng });
      }
    } catch { /* swallow malformed */ }
  };

  if (Platform.OS === 'web') {
    // Listen to iframe postMessage on web.
    React.useEffect(() => {
      const listener = (e: MessageEvent) => {
        if (typeof e.data === 'string') handleMessage(e.data);
      };
      window.addEventListener('message', listener);
      return () => window.removeEventListener('message', listener);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const iframe = React.createElement('iframe', {
      srcDoc: html,
      title: 'location-picker',
      style: { width: '100%', height: '100%', border: 0 },
      sandbox: 'allow-scripts allow-same-origin',
      'data-testid': testID || 'map-location-picker-iframe',
    });
    return <View style={[styles.box, { height }]}>{iframe}</View>;
  }

  return (
    <View style={[styles.box, { height }]}>
      <WebView
        testID={testID || 'map-location-picker-webview'}
        source={{ html }}
        style={{ flex: 1 }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={(e: any) => handleMessage(String(e?.nativeEvent?.data || ''))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: '100%', borderRadius: 12, overflow: 'hidden', backgroundColor: '#f5f7fb' },
});
