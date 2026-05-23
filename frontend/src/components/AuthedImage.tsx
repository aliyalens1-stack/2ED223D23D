/**
 * AuthedImage — fetches /api/media/{id} with bearer token and shows as <Image>.
 * Mobile <Image> does not support custom headers, so we fetch as blob → base64 data URL.
 */
import { useEffect, useState } from 'react';
import { Image, ImageStyle, View, ActivityIndicator, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API = (Constants.expoConfig as any)?.extra?.apiUrl
  || process.env.EXPO_PUBLIC_BACKEND_URL
  || 'http://localhost:8001';

interface Props {
  mediaUrl: string;          // server-relative e.g. /api/media/abc
  style?: ImageStyle | ImageStyle[];
  testID?: string;
}

const cache: Record<string, string> = {};

export default function AuthedImage({ mediaUrl, style, testID }: Props) {
  const [dataUrl, setDataUrl] = useState<string | null>(cache[mediaUrl] || null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cache[mediaUrl]) { setDataUrl(cache[mediaUrl]); return; }
    let cancelled = false;
    (async () => {
      try {
        const token = await AsyncStorage.getItem('auth_token');
        const res = await fetch(`${API}${mediaUrl}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          if (cancelled) return;
          const result = String(reader.result || '');
          cache[mediaUrl] = result;
          setDataUrl(result);
        };
        reader.onerror = () => { if (!cancelled) setError(true); };
        reader.readAsDataURL(blob);
      } catch (e) {
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [mediaUrl]);

  if (error) {
    return <View style={[styles.placeholder, style as any]} testID={testID} />;
  }
  if (!dataUrl) {
    return (
      <View style={[styles.placeholder, style as any]} testID={testID}>
        <ActivityIndicator color="#FFB020" size="small" />
      </View>
    );
  }
  return <Image source={{ uri: dataUrl }} style={style} testID={testID} />;
}

const styles = StyleSheet.create({
  placeholder: { backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' },
});
