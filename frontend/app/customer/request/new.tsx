/**
 * Customer Request Creation — guided intake V1 (mobile parity).
 *
 * Path: /customer/request/new
 *
 * Doctrine — identical to web RequestIntakePage.tsx. Mobile is a renderer
 * of restrained read models, NOT a local inference layer:
 *   • Single calm scroll. No step counters, no progress bars, no FAB.
 *   • Pure form primitives — TextInput + plain toggle rows. No
 *     gamification, no animated transitions, no haptic urgency.
 *   • Listing link OR brand+model — both paths converge on the same
 *     backend contract.
 *   • Honest incompleteness — only the vehicle reference and the
 *     location are needed to begin.
 *   • Forbidden lexicon (AI / algorithm / confidence / score / urgent /
 *     submit / required / error / failed / risk / analysis / progress)
 *     is structurally absent.
 *   • On success → navigate to /customer/request/[id]/establishment
 *     (continuity bridge). NEVER directly to the operational request
 *     detail page.
 */
import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/services/api';
import { tokens } from '../../../src/theme/tokens';
import { useThemeContext } from '../../../src/context/ThemeContext';

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;
const T = tokens.typography;

const DEFAULT_CITIES = [
  'Berlin', 'München', 'Hamburg', 'Frankfurt', 'Köln',
  'Stuttgart', 'Düsseldorf',
];

type SchedulingWindow = 'soon' | 'this_week' | 'flexible';

const SCHEDULING_OPTIONS: { value: SchedulingWindow; label: string; note: string }[] = [
  { value: 'soon',      label: 'Soon',       note: 'Within the next couple of days.' },
  { value: 'this_week', label: 'This week',  note: 'Within the working week.' },
  { value: 'flexible',  label: 'Flexible',   note: 'No fixed window.' },
];

export default function CustomerRequestIntakeScreen() {
  // Theme-aware styling — see makeStyles(isDark) below.
  const { isDark } = useThemeContext();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const router = useRouter();

  const [link, setLink] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [city, setCity] = useState('');
  const [uncertainty, setUncertainty] = useState('');
  const [schedulingWindow, setSchedulingWindow] = useState<SchedulingWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const hasVehicleSubstrate = link.trim().length > 0 || brand.trim().length > 0;
  const hasLocation = city.trim().length > 0;
  const canEstablish = hasVehicleSubstrate && hasLocation && !loading;

  async function establish() {
    setNote(null);
    if (!hasVehicleSubstrate) {
      setNote('A vehicle reference is needed to establish inspection context.');
      return;
    }
    if (!hasLocation) {
      setNote('A location is needed to establish inspection context.');
      return;
    }
    setLoading(true);
    try {
      const usingLink = link.trim().length > 0;
      const payload: Record<string, unknown> = {
        cities: [city.trim()],
        uncertainty: uncertainty.trim() || undefined,
        schedulingWindow: schedulingWindow || undefined,
      };
      if (usingLink) {
        payload.type = 'inspection';
        payload.links = [link.trim()];
      } else {
        payload.type = 'selection';
        payload.brand = brand.trim();
        payload.model = model.trim() || '—';
        // Structural minimum required by backend schema; never rendered.
        payload.budget = 1;
      }
      const res = await api.post('/customer/requests', payload);
      const id = res.data?.id;
      if (!id) {
        setNote('Inspection context could not be established yet. Please review the references and try again.');
        setLoading(false);
        return;
      }
      // Continuity bridge — NEVER to operational MyRequestDetail.
      router.replace(`/customer/request/${id}/establishment` as any);
    } catch {
      setNote('Inspection context could not be established yet. Please review the references and try again.');
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          testID="request-intake-page"
        >
          {/* Header */}
          <View style={styles.headerRow}>
            <TouchableOpacity
              onPress={() => router.back()}
              hitSlop={12}
              activeOpacity={0.7}
              style={styles.backBtn}
              testID="intake-back-link"
            >
              <Ionicons name="chevron-back" size={22} color={(isDark ? C.textDark : C.textLight)} />
              <Text style={styles.backText}>Back to requests</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.kicker} testID="intake-eyebrow">NEW INSPECTION CONTEXT</Text>
          <Text style={styles.title} testID="intake-title">Establish inspection context</Text>
          <Text style={styles.subtitle} testID="intake-subtitle">
            We are recording what the inspection is about. Information may still be added later — only the vehicle reference and the location are needed to establish context.
          </Text>

          <View style={styles.separator} />

          {/* ─ Section 1 — Vehicle reference ─ */}
          <Section
            eyebrow="Vehicle reference"
            hint="A listing link is the most precise reference. If a link is not at hand, a brand (and model, when known) is enough to begin."
            testID="intake-section-vehicle"
          >
            <Field label="Listing link" testID="intake-link-field">
              <TextInput
                value={link}
                onChangeText={setLink}
                placeholder="https://…"
                placeholderTextColor={(isDark ? C.subtextDark : C.subtextLight)}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
                testID="intake-link-input"
              />
            </Field>

            <Text style={styles.linkOr} testID="intake-link-or">— or —</Text>

            <Field label="Brand" testID="intake-brand-field">
              <TextInput
                value={brand}
                onChangeText={setBrand}
                placeholder="BMW"
                placeholderTextColor={(isDark ? C.subtextDark : C.subtextLight)}
                style={styles.input}
                testID="intake-brand-input"
              />
            </Field>
            <Field label="Model · optional" testID="intake-model-field">
              <TextInput
                value={model}
                onChangeText={setModel}
                placeholder="320d"
                placeholderTextColor={(isDark ? C.subtextDark : C.subtextLight)}
                style={styles.input}
                testID="intake-model-input"
              />
            </Field>
          </Section>

          <View style={styles.separator} />

          {/* ─ Section 2 — Location ─ */}
          <Section
            eyebrow="Location"
            hint="The city where the vehicle can be reached for inspection."
            testID="intake-section-location"
          >
            <Field label="City" testID="intake-city-field">
              <TextInput
                value={city}
                onChangeText={setCity}
                placeholder="Berlin"
                placeholderTextColor={(isDark ? C.subtextDark : C.subtextLight)}
                style={styles.input}
                testID="intake-city-input"
              />
            </Field>
            <View style={styles.suggestionsRow} testID="intake-city-suggestions">
              {DEFAULT_CITIES.filter((c) => c.toLowerCase() !== city.trim().toLowerCase()).map((c) => (
                <TouchableOpacity
                  key={c}
                  onPress={() => setCity(c)}
                  activeOpacity={0.7}
                  style={styles.suggestionBtn}
                  testID={`intake-city-suggestion-${c}`}
                >
                  <Text style={styles.suggestionText}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </Section>

          <View style={styles.separator} />

          {/* ─ Section 3 — Uncertainty / context ─ */}
          <Section
            eyebrow="What is making you uncertain"
            hint="Optional. Anything an inspector might find useful — prior knowledge of the vehicle, doubts about the listing, specific concerns."
            testID="intake-section-uncertainty"
          >
            <Field label="Context · optional" testID="intake-uncertainty-field">
              <TextInput
                value={uncertainty}
                onChangeText={setUncertainty}
                placeholder="Anything you would mention to a friend who knows cars."
                placeholderTextColor={(isDark ? C.subtextDark : C.subtextLight)}
                multiline
                numberOfLines={4}
                maxLength={2000}
                textAlignVertical="top"
                style={[styles.input, styles.textarea]}
                testID="intake-uncertainty-input"
              />
            </Field>
          </Section>

          <View style={styles.separator} />

          {/* ─ Section 4 — Scheduling window ─ */}
          <Section
            eyebrow="Scheduling window"
            hint="Optional. A non-binding indication — helps reach you at a useful moment."
            testID="intake-section-scheduling"
          >
            <View testID="intake-scheduling-options">
              {SCHEDULING_OPTIONS.map((opt) => {
                const selected = schedulingWindow === opt.value;
                return (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => setSchedulingWindow(selected ? null : opt.value)}
                    activeOpacity={0.7}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    style={[styles.schedulingOpt, selected && styles.schedulingOptSelected]}
                    testID={`intake-scheduling-${opt.value}`}
                  >
                    <Text style={styles.schedulingLabel}>{opt.label}</Text>
                    <Text style={styles.schedulingNote}>{opt.note}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </Section>

          <View style={styles.separator} />

          {/* ─ Confirmation ─ */}
          <View testID="intake-confirmation">
            <Text style={styles.incompletenessNote} testID="intake-incompleteness-note">
              Information may still be added later. Establishing context begins the inspection continuity — nothing is finalised yet.
            </Text>

            {note && (
              <Text style={styles.substrateNote} testID="intake-substrate-note">
                {note}
              </Text>
            )}

            <TouchableOpacity
              onPress={establish}
              disabled={!canEstablish}
              activeOpacity={0.85}
              style={[
                styles.establishBtn,
                !canEstablish && styles.establishBtnDisabled,
              ]}
              testID="intake-establish-btn"
            >
              <Text
                style={[
                  styles.establishBtnText,
                  !canEstablish && styles.establishBtnTextDisabled,
                ]}
              >
                {loading ? 'Establishing context…' : 'Establish inspection context'}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── primitives ──────────────────────────────────────────────────────

function Section(props: {
  eyebrow: string;
  hint: string;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section} testID={props.testID}>
      <Text style={styles.eyebrow} testID={`${props.testID}-eyebrow`}>
        {props.eyebrow}
      </Text>
      <Text style={styles.hint} testID={`${props.testID}-hint`}>
        {props.hint}
      </Text>
      {props.children}
    </View>
  );
}

function Field(props: {
  label: string;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field} testID={props.testID}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      {props.children}
    </View>
  );
}

function makeStyles(isDark: boolean) {
  // ── Theme-aware token swap (Day 5 audit, 2026-05-15).
  //   *Light → *Dark when isDark; semantic colours (brand/success/
  //   warning/error) are intentionally theme-invariant.
  const bg        = isDark ? C.bgDark        : C.bgLight;
  const card      = isDark ? C.cardDark      : C.cardLight;
  const text      = isDark ? C.textDark      : C.textLight;
  const subtext   = isDark ? C.subtextDark   : C.subtextLight;
  const border    = isDark ? C.borderDark    : C.borderLight;
  const brandSoft = isDark ? C.brandSoftDark : C.brandSoftLight;
  return StyleSheet.create({
  safe: { flex: 1, backgroundColor: bg },
  scroll: { padding: S.md + 4, paddingBottom: S.xxl + 16 },

  headerRow: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: S.xs,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    paddingHorizontal: 4,
    marginLeft: -4,
    gap: 2,
  },
  backText: { fontSize: 15, fontWeight: '500', color: text },

  kicker: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    letterSpacing: 2.5,
    color: subtext,
    marginTop: S.sm,
    marginBottom: 4,
  },
  title: {
    fontSize: T.h1 - 4,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: text,
  },
  subtitle: {
    fontSize: T.body,
    lineHeight: 22,
    color: subtext,
    marginTop: S.sm,
  },

  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: border,
    marginVertical: S.lg,
  },

  section: { gap: S.xs },
  eyebrow: {
    fontSize: T.micro - 1,
    fontWeight: '800',
    letterSpacing: 2,
    color: subtext,
    textTransform: 'uppercase',
  },
  hint: {
    fontSize: T.caption,
    lineHeight: 19,
    color: subtext,
    marginTop: 4,
    marginBottom: S.sm,
  },

  field: { marginBottom: S.sm + 2 },
  fieldLabel: {
    fontSize: T.micro,
    fontWeight: '700',
    letterSpacing: 0.6,
    color: subtext,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: R.sm + 2,
    backgroundColor: card,
    paddingHorizontal: 14,
    paddingVertical: 11,
    fontSize: T.body,
    color: text,
  },
  textarea: { minHeight: 96, paddingTop: 11 },

  linkOr: {
    fontSize: T.caption,
    color: subtext,
    marginVertical: S.xs + 2,
  },

  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: S.sm,
    gap: S.sm,
  },
  suggestionBtn: { paddingVertical: 4, paddingHorizontal: 2 },
  suggestionText: {
    fontSize: T.caption,
    color: subtext,
    textDecorationLine: 'underline',
    textDecorationColor: border,
  },

  schedulingOpt: {
    borderWidth: 1,
    borderColor: border,
    borderRadius: R.sm + 2,
    padding: S.sm + 2,
    marginBottom: S.sm,
    backgroundColor: card,
  },
  schedulingOptSelected: {
    borderColor: text,
    backgroundColor: '#FAFBFC',
  },
  schedulingLabel: {
    fontSize: T.body,
    fontWeight: '700',
    color: text,
  },
  schedulingNote: {
    fontSize: T.caption,
    color: subtext,
    marginTop: 2,
  },

  incompletenessNote: {
    fontSize: T.caption,
    color: subtext,
    lineHeight: 19,
    marginBottom: S.md,
  },
  substrateNote: {
    fontSize: T.caption,
    color: text,
    lineHeight: 19,
    marginBottom: S.md,
  },
  establishBtn: {
    backgroundColor: text,
    borderRadius: R.sm + 2,
    paddingVertical: 14,
    alignItems: 'center',
  },
  establishBtnDisabled: { backgroundColor: '#E2E5EB' },
  establishBtnText: {
    fontSize: T.body,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  establishBtnTextDisabled: { color: subtext },
});
}
// ── Module-level fallback styles for sub-components (light-mode only).
// Main component uses the themed `useMemo(() => makeStyles(isDark), ...)`
// override which shadows this fallback. Theme parity for the
// module-level sub-components (Section / Field / etc.) is a follow-up
// task — see /app/memory/theme_audit_2026_05_15.md.
const styles = makeStyles(false);

