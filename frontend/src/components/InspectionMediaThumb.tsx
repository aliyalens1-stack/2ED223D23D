/**
 * UX-3 — Inspection media thumbnail.
 *
 * Lazy-loads media blob from /api/inspections/{jobId}/media/{mediaId} once,
 * caches the base64 in module-scope `cache` map (per-mount lifetime is fine —
 * thumbs are re-rendered constantly via section state, and Mongo is local).
 *
 * Renders:
 *   - loading: spinner placeholder
 *   - error:   broken-image icon
 *   - loaded:  <Image source={{ uri: 'data:<mime>;base64,...' }} />
 *
 * Props:
 *   jobId, mediaId   — required to construct the URL
 *   size             — px box size, default 50
 *   onPress          — optional callback to open a full-screen viewer
 */
import React, { useEffect, useState } from 'react';
import { Image, TouchableOpacity, View, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../services/api';

type CacheEntry = { uri: string };
const cache = new Map<string, CacheEntry>();

type Props = {
  jobId: string;
  mediaId: string;
  size?: number;
  borderColor?: string;
  bgColor?: string;
  onPress?: () => void;
  testID?: string;
};

export default function InspectionMediaThumb({ jobId, mediaId, size = 50, borderColor, bgColor, onPress, testID }: Props) {
  const cached = cache.get(mediaId);
  const [uri, setUri] = useState<string | null>(cached?.uri || null);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    (async () => {
      try {
        const r = await api.get(`/inspections/${jobId}/media/${mediaId}`);
        const md = r.data?.media;
        if (md?.base64) {
          const u = `data:${md.mime || 'image/jpeg'};base64,${md.base64}`;
          cache.set(mediaId, { uri: u });
          if (alive) setUri(u);
        } else {
          if (alive) setError(true);
        }
      } catch (e) {
        if (alive) setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [jobId, mediaId, cached]);

  const box = {
    width: size,
    height: size,
    borderRadius: 8,
    backgroundColor: bgColor || '#e5e7eb',
    borderWidth: borderColor ? 1 : 0,
    borderColor: borderColor || 'transparent',
    overflow: 'hidden' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  };

  const content = (
    <View style={box}>
      {uri ? (
        <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />
      ) : loading ? (
        <ActivityIndicator size="small" color="#9ca3af" />
      ) : error ? (
        <Ionicons name="image-outline" size={20} color="#9ca3af" />
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <TouchableOpacity onPress={onPress} testID={testID} activeOpacity={0.8}>
        {content}
      </TouchableOpacity>
    );
  }
  return <View testID={testID}>{content}</View>;
}
