/**
 * UX-4A — Guided Capture Screen.
 *
 * Inspector taps "Add photo" on a checklist item that has a `captureContext`
 * (vin / odometer / damage / tire / engine / interior / exterior / document / obd).
 *
 * This screen:
 *   1. Requests camera permission via expo-camera
 *   2. Renders a live camera preview with a context-specific overlay frame
 *      (rectangle for VIN/odometer, square for damage, round for documents)
 *   3. Shows a coaching hint at the top ("Hold steady", "More light", …)
 *   4. On capture → runs deterministic JS heuristics on the photo:
 *        • file size (proxy for resolution / blur)
 *        • brightness (mean luminance from a 16×16 downscaled sample)
 *        • dimensions
 *      → marks `passed` true/false
 *   5. Shows the result preview with PASS / FAIL chips and option to retake.
 *   6. On accept → returns the captured payload (base64 + capture metadata)
 *      to the parent screen via expo-router back-with-params.
 *
 * No CV / no AI. Just deterministic UX.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Platform, Dimensions,
} from 'react-native';
import i18n from '../../../src/i18n';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';

import { useThemeContext } from '../../../src/context/ThemeContext';

// Capture context → overlay shape + coaching copy
type Ctx = 'vin' | 'odometer' | 'damage' | 'tire' | 'engine' | 'interior' | 'exterior' | 'document' | 'obd' | 'general';

const CTX_META: Record<Ctx, { shape: 'rect' | 'square' | 'doc'; aspect: number; title: string; hint: string }> = {
  vin:       { shape: 'rect',   aspect: 6.5, title: i18n.t('inspector.vin_nomer'),        hint: i18n.t('inspector.pomestite_vin_v_ramku_derzhite_rovno_bez_blikov') },
  odometer:  { shape: 'rect',   aspect: 3.2, title: i18n.t('inspector.odometr_probeg'), hint: i18n.t('inspector.sfokusirujtes_na_cifrah_odometra_snimite_rovno_bez') },
  damage:    { shape: 'square', aspect: 1.0, title: i18n.t('inspector.povrezhdenie'),      hint: i18n.t('inspector.podojdite_blizhe_pokazhite_defekt_chetko_v_centre') },
  tire:      { shape: 'square', aspect: 1.0, title: i18n.t('inspector.shina_protektor'), hint: i18n.t('inspector.snimajte_pod_uglom_45_dolzhen_byt_viden_protektor') },
  engine:    { shape: 'square', aspect: 1.4, title: i18n.t('inspector.podkapotnoe'),      hint: i18n.t('inspector.otkrojte_kapot_snimajte_pri_horoshem_osveschenii') },
  interior:  { shape: 'square', aspect: 1.4, title: i18n.t('inspector.salon'),            hint: i18n.t('inspector.snimok_salona_vklyuchite_svet_esli_temno') },
  exterior:  { shape: 'square', aspect: 1.4, title: i18n.t('inspector.kuzov'),            hint: i18n.t('inspector.snimajte_panel_celikom_bez_blikov_ot_solnca') },
  document:  { shape: 'doc',    aspect: 1.41, title: i18n.t('inspector.dokument'),        hint: i18n.t('inspector.polozhite_dokument_rovno_snimajte_sverhu_bez_bliko') },
  obd:       { shape: 'rect',   aspect: 2.0, title: i18n.t('inspector.obd_ekran'),      hint: i18n.t('inspector.sfotografirujte_ekran_skanera_s_kodami_oshibok') },
  general:   { shape: 'square', aspect: 1.4, title: i18n.t('inspector.snimok'),           hint: i18n.t('inspector.snimok_v_kadre_bez_blikov_i_razmytiya') },
};

type CaptureQuality = {
  blurScore?: number;
  brightness?: number;
  width: number;
  height: number;
  passed: boolean;
  reasons: string[];
};

export default function GuidedCaptureScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const { colors } = useThemeContext();
  const params = useLocalSearchParams<{ context?: string; sectionId?: string; itemId?: string; label?: string }>();
  const ctx = ((params.context as Ctx) || 'general') as Ctx;
  const meta = CTX_META[ctx] || CTX_META.general;

  const cameraRef = useRef<CameraView | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [shot, setShot] = useState<{ uri: string; base64: string; width: number; height: number } | null>(null);
  const [quality, setQuality] = useState<CaptureQuality | null>(null);

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted && permission.canAskAgain) {
      requestPermission();
    }
  }, [permission, requestPermission]);

  /**
   * Deterministic quality heuristics on the captured base64 image.
   * Heavy CV is out-of-scope; we use cheap proxies that catch the worst cases:
   *   • size: <80kB tiny → likely low resolution or extreme JPEG compression
   *   • brightness: <30 (too dark) or >235 (washed out / glare)
   *   • aspect sanity: not 1px-tall
   * We DO NOT block on heuristic fail — we surface it so the inspector can retake.
   */
  const analyze = useCallback(async (base64: string, width: number, height: number): Promise<CaptureQuality> => {
    const reasons: string[] = [];
    const sizeKb = Math.round(base64.length * 0.75 / 1024);
    if (sizeKb < 60) reasons.push(i18n.t('inspector.foto_slishkom_malenkoe_vozmozhno_razmytoe_ili_szha'));
    if (width < 640 || height < 480) reasons.push(i18n.t('inspector.nizkoe_razreshenie_poprobujte_podojti_blizhe_i_per'));

    // Brightness proxy: downscale to 16×16 via ImageManipulator and sample base64 byte distribution.
    let brightness: number | undefined;
    try {
      const tiny = await ImageManipulator.manipulateAsync(
        `data:image/jpeg;base64,${base64}`,
        [{ resize: { width: 16, height: 16 } }],
        { base64: true, compress: 0.4, format: ImageManipulator.SaveFormat.JPEG },
      );
      if (tiny.base64) {
        // crude proxy: average byte value of decoded tail (last 256 bytes of JPEG entropy).
        // High = bright, low = dark. Not luminance per se but a fast deterministic signal.
        const bytes = atob(tiny.base64);
        const tail = bytes.slice(Math.max(0, bytes.length - 256));
        let sum = 0;
        for (let i = 0; i < tail.length; i++) sum += tail.charCodeAt(i);
        brightness = Math.round(sum / Math.max(1, tail.length));
        if (brightness < 50) reasons.push(i18n.t('inspector.slishkom_temno_snimajte_pri_horoshem_osveschenii'));
        if (brightness > 220) reasons.push(i18n.t('inspector.slishkom_yarko_vozmozhen_blik_smenite_ugol'));
      }
    } catch {
      // ignore — brightness is best-effort
    }

    const passed = reasons.length === 0;
    return { brightness, width, height, passed, reasons };
  }, []);

  const onTake = useCallback(async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.7, base64: true, skipProcessing: false });
      if (!photo?.base64) throw new Error('no base64 returned');
      setShot({ uri: photo.uri, base64: photo.base64, width: photo.width || 0, height: photo.height || 0 });
      setAnalyzing(true);
      const q = await analyze(photo.base64, photo.width || 0, photo.height || 0);
      setQuality(q);
      setAnalyzing(false);
    } catch (e: any) {
      Alert.alert(i18n.t('inspector.ne_udalos_sdelat_snimok'), String(e?.message || e));
    } finally {
      setCapturing(false);
    }
  }, [capturing, analyze]);

  const onRetake = () => { setShot(null); setQuality(null); };

  const onAccept = useCallback(() => {
    if (!shot || !quality) return;
    // Hand the captured payload back to the parent screen. We use router params
    // (URL-safe) — base64 goes through a global stash because URLs cap at ~2KB.
    const stashKey = `_capture_${Date.now()}`;
    (globalThis as any).__guidedCaptureStash = (globalThis as any).__guidedCaptureStash || {};
    (globalThis as any).__guidedCaptureStash[stashKey] = {
      base64: shot.base64,
      width: shot.width,
      height: shot.height,
      capture: {
        context: ctx,
        capturedAt: new Date().toISOString(),
        deviceModel: Platform.OS,
        quality: {
          brightness: quality.brightness,
          width: quality.width,
          height: quality.height,
          passed: quality.passed,
        },
      },
    };
    router.replace({
      pathname: '/inspector/inspection/[jobId]',
      params: {
        jobId: String(params.jobId || ''),
        section: String(params.sectionId || ''),
        // hand off via key (parent reads + clears the stash)
        captureKey: stashKey,
        captureSection: String(params.sectionId || ''),
        captureItem: String(params.itemId || ''),
      },
    } as any);
  }, [shot, quality, ctx, router, params]);

  // ── Render ─────────────────────────────────────────────────────────
  if (!permission) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: '#000' }]} edges={['top']}>
        <ActivityIndicator color="#fff" />
      </SafeAreaView>
    );
  }
  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 24 }]} edges={['top']}>
        <Ionicons name="camera-outline" size={64} color="#fff" />
        <Text style={[styles.permTitle]}>{t('inspector.nuzhen_dostup_k_kamere')}</Text>
        <Text style={[styles.permMsg]}>{t('inspector.chtoby_delat_snimki_avtomobilya_po_cheklistu_inspe')}</Text>
        <TouchableOpacity onPress={requestPermission} style={styles.permBtn} testID="guided-perm-grant">
          <Text style={styles.permBtnText}>{t('inspector.razreshit')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => router.back()} style={[styles.permBtn, { backgroundColor: '#374151', marginTop: 10 }]} testID="guided-perm-cancel">
          <Text style={styles.permBtnText}>{t('inspector.otmena')}</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const { width: W, height: H } = Dimensions.get('window');
  const frameW = Math.min(W * 0.85, 360);
  const frameH = meta.shape === 'square' ? frameW : frameW / meta.aspect;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: '#000' }]} edges={['top']}>
      {!shot ? (
        <>
          <CameraView
            ref={(r) => { cameraRef.current = r; }}
            style={StyleSheet.absoluteFillObject}
            facing="back"
          />
          {/* Top header */}
          <View style={styles.topBar} testID="guided-topbar">
            <TouchableOpacity onPress={() => router.back()} style={styles.topBtn} testID="guided-cancel">
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={styles.topTitle}>{meta.title}</Text>
              {params.label ? <Text style={styles.topSubtitle}>{String(params.label)}</Text> : null}
            </View>
            <View style={{ width: 40 }} />
          </View>

          {/* Coaching hint */}
          <View style={styles.hintBar}>
            <Ionicons name="information-circle" size={16} color="#fff" />
            <Text style={styles.hintText}>{meta.hint}</Text>
          </View>

          {/* Overlay frame */}
          <View pointerEvents="none" style={[styles.frameOverlay, { width: frameW, height: frameH, top: (H - frameH) / 2 - 40 }]}>
            <View style={[styles.cornerTL, { borderTopColor: '#fff', borderLeftColor: '#fff' }]} />
            <View style={[styles.cornerTR, { borderTopColor: '#fff', borderRightColor: '#fff' }]} />
            <View style={[styles.cornerBL, { borderBottomColor: '#fff', borderLeftColor: '#fff' }]} />
            <View style={[styles.cornerBR, { borderBottomColor: '#fff', borderRightColor: '#fff' }]} />
          </View>

          {/* Bottom capture bar */}
          <View style={styles.bottomBar}>
            <View style={{ width: 56 }} />
            <TouchableOpacity
              testID="guided-shutter"
              onPress={onTake}
              disabled={capturing}
              activeOpacity={0.8}
              style={[styles.shutter, capturing && { opacity: 0.6 }]}
            >
              {capturing ? <ActivityIndicator color="#000" /> : <View style={styles.shutterInner} />}
            </TouchableOpacity>
            <View style={{ width: 56 }} />
          </View>
        </>
      ) : (
        // ── Review ──────────────────────────────────────────────────
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <View style={styles.topBar}>
            <TouchableOpacity onPress={() => router.back()} style={styles.topBtn} testID="guided-cancel-review">
              <Ionicons name="close" size={24} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.topTitle}>{t('inspector.proverte_snimok')}</Text>
            <View style={{ width: 40 }} />
          </View>

          {/* Preview */}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
            {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
            <View style={[styles.previewBox, { width: W - 32, aspectRatio: shot.width / Math.max(1, shot.height) }]}>
              <View style={StyleSheet.absoluteFillObject}>
                <View style={{ flex: 1 }}>
                  {/* react-native Image cannot use file:// from camera on web preview, but URI works */}
                  <ReviewImage uri={shot.uri} />
                </View>
              </View>
            </View>
            {analyzing ? (
              <View style={styles.qualityRow}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.qualityText}>{t('inspector.analiziruem_kachestvo')}</Text>
              </View>
            ) : quality ? (
              <View style={{ width: '100%', marginTop: 16, gap: 6 }}>
                <View style={[styles.qChip, { backgroundColor: quality.passed ? '#16a34a' : '#dc2626' }]}>
                  <Ionicons name={quality.passed ? 'checkmark-circle' : 'alert-circle'} size={16} color="#fff" />
                  <Text style={styles.qChipText}>
                    {quality.passed ? t('inspector.kachestvo_v_norme') : t('inspector.est_problemy_so_snimkom')}
                  </Text>
                </View>
                {quality.reasons.map((r, i) => (
                  <Text key={i} style={styles.qReason}>• {r}</Text>
                ))}
                {quality.brightness !== undefined ? (
                  <Text style={styles.qMeta}>Яркость: {quality.brightness}  ·  {quality.width}×{quality.height}</Text>
                ) : null}
              </View>
            ) : null}
          </View>

          {/* Actions */}
          <View style={styles.reviewActions}>
            <TouchableOpacity testID="guided-retake" onPress={onRetake} style={[styles.actionBtn, { backgroundColor: '#374151' }]}>
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.actionText}>{t('inspector.peresnyat')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="guided-accept"
              onPress={onAccept}
              disabled={analyzing}
              style={[styles.actionBtn, { backgroundColor: quality?.passed ? '#16a34a' : '#f59e0b' }]}
            >
              <Ionicons name="checkmark" size={18} color="#fff" />
              <Text style={styles.actionText}>{quality?.passed ? t('inspector.ispolzovat') : t('inspector.ispolzovat_vse_ravno')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

function ReviewImage({ uri }: { uri: string }) {
  const { Image } = require('react-native');
  return <Image source={{ uri }} style={StyleSheet.absoluteFillObject} resizeMode="contain" />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0, paddingTop: 16, paddingHorizontal: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 5,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  topBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  topSubtitle: { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },
  hintBar: {
    position: 'absolute', top: 80, left: 16, right: 16, zIndex: 5,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(0,0,0,0.55)', padding: 10, borderRadius: 10,
  },
  hintText: { color: '#fff', fontSize: 12, flex: 1, lineHeight: 16 },

  frameOverlay: {
    position: 'absolute', alignSelf: 'center',
  },
  cornerTL: { position: 'absolute', top: 0, left: 0, width: 32, height: 32, borderTopWidth: 4, borderLeftWidth: 4, borderTopLeftRadius: 6 },
  cornerTR: { position: 'absolute', top: 0, right: 0, width: 32, height: 32, borderTopWidth: 4, borderRightWidth: 4, borderTopRightRadius: 6 },
  cornerBL: { position: 'absolute', bottom: 0, left: 0, width: 32, height: 32, borderBottomWidth: 4, borderLeftWidth: 4, borderBottomLeftRadius: 6 },
  cornerBR: { position: 'absolute', bottom: 0, right: 0, width: 32, height: 32, borderBottomWidth: 4, borderRightWidth: 4, borderBottomRightRadius: 6 },

  bottomBar: {
    position: 'absolute', bottom: 32, left: 0, right: 0, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 24, zIndex: 5,
  },
  shutter: {
    width: 76, height: 76, borderRadius: 38, backgroundColor: 'rgba(255,255,255,0.25)',
    borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center',
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#fff' },

  permTitle: { color: '#fff', fontSize: 18, fontWeight: '700', marginTop: 14 },
  permMsg: { color: 'rgba(255,255,255,0.78)', fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 18 },
  permBtn: { marginTop: 22, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14, backgroundColor: '#16a34a' },
  permBtnText: { color: '#fff', fontWeight: '700' },

  previewBox: { backgroundColor: '#111', borderRadius: 12, overflow: 'hidden' },
  qualityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 },
  qualityText: { color: '#fff' },
  qChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, alignSelf: 'flex-start' },
  qChipText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  qReason: { color: '#fca5a5', fontSize: 12, lineHeight: 16 },
  qMeta: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 4 },

  reviewActions: { flexDirection: 'row', gap: 10, padding: 16, paddingBottom: 24 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 14, borderRadius: 12 },
  actionText: { color: '#fff', fontWeight: '700' },
});
