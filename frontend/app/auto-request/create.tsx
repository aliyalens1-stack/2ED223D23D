/**
 * auto-request/create — orchestrator screen (refactored 2026-02).
 *
 * Was: 1830-line monolith mixing layout, state, validation, Stripe
 * checkout, vehicle persistence, brand picker, link parsing and
 * 200+ lines of StyleSheet.
 *
 * Now: thin orchestrator (<350 LOC) that:
 *   1. Owns top-level form state.
 *   2. Loads cities + countries + pricing once on mount.
 *   3. Computes validation in a memoised selector.
 *   4. Handles submit (Stripe checkout via /payments/auto-request/checkout)
 *      and the optional "save as vehicle candidate" CTA.
 *   5. Wires presentational subcomponents from `./_internal`.
 *
 * The 14 modules under `_internal/` are split by single responsibility:
 *
 *   types.ts                 shared FlowType / City / Country contracts
 *   constants.ts             URGENCY / FUEL / TX option lists + R1_DRAFT_KEY
 *   styles.ts                main StyleSheet (shared by all subcomponents)
 *   lpStyles.ts              link-preview StyleSheet (kept separate)
 *   primitives.tsx           Label / Hint / MetaChip
 *   ChipRow.tsx              horizontal chip selector
 *   CountryRow.tsx           country dropdown row
 *   CountryPickerModal.tsx   /api/geo/countries picker
 *   CityField.tsx            city dropdown row
 *   CityPickerModal.tsx      searchable city picker (single/multi)
 *   LinkPreview.tsx          canonical envelope preview card
 *   ValuePropBlock.tsx       pre-payment trust block
 *   FlowPicker.tsx           step 0 (inspection vs selection)
 *   InspectionForm.tsx       step 1 — inspection flow
 *   SelectionForm.tsx        step 1 — selection flow
 *
 * BUGFIX: `R1_DRAFT_KEY` was referenced but never declared in the
 * monolith. Anonymous submit would throw ReferenceError. Now defined
 * in `./_internal/constants.ts`.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView,
  Text, TouchableOpacity, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useThemeContext } from '../../src/context/ThemeContext';
import { useAuth } from '../../src/context/AuthContext';
import { api } from '../../src/services/api';
import { vehiclesApi } from '../../src/services/vehicles';
import { CAR_BRANDS } from '../../src/constants/carCatalogue';

import { styles } from './_internal/styles';
import { PRICING_EUR_FALLBACK, R1_DRAFT_KEY } from './_internal/constants';
import { FlowPicker } from './_internal/FlowPicker';
import { InspectionForm } from './_internal/InspectionForm';
import { SelectionForm } from './_internal/SelectionForm';
import { ValuePropBlock } from './_internal/ValuePropBlock';
import { CityPickerModal } from './_internal/CityPickerModal';
import { CountryPickerModal } from './_internal/CountryPickerModal';
import type { City, Country, FlowType } from './_internal/types';
import i18n from '../../src/i18n';

export default function CreateRequestScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string }>();
  const { colors } = useThemeContext();
  const { t } = useTranslation();
  const { isAuthenticated, setPendingIntent } = useAuth();

  // Step 0 = pick type; step 1 = fill form; preselect if ?type= provided
  const [step, setStep] = useState<0 | 1>(params.type === 'inspection' || params.type === 'selection' ? 1 : 0);
  const [flow, setFlow] = useState<FlowType>(params.type === 'inspection' ? 'inspection' : 'selection');

  // Shared form fields
  const [cities, setCities] = useState<string[]>([]);
  const [country, setCountry] = useState<string>('DE');
  const [comment, setComment] = useState<string>('');
  const [cityModalOpen, setCityModalOpen] = useState(false);
  const [countryModalOpen, setCountryModalOpen] = useState(false);

  // Inspection flow
  const [link, setLink] = useState<string>('');
  const [urgency, setUrgency] = useState<string>('24h');

  // Selection flow
  const [brand, setBrand] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [budget, setBudget] = useState<string>('');
  const [yearFrom, setYearFrom] = useState<string>('');
  const [yearTo, setYearTo] = useState<string>('');
  const [fuel, setFuel] = useState<string>('');
  const [transmission, setTransmission] = useState<string>('');
  const [mileageMax, setMileageMax] = useState<string>('');

  // Catalogues
  const [allCities, setAllCities] = useState<City[]>([]);
  const [citiesLoading, setCitiesLoading] = useState(true);
  const [geoCountries, setGeoCountries] = useState<Country[]>([]);

  // Submission states
  const [submitting, setSubmitting] = useState(false);
  const [savingCandidate, setSavingCandidate] = useState(false);
  const [candidateSavedId, setCandidateSavedId] = useState<string | null>(null);

  // Phase 3.0c — dynamic pricing from /api/pricing (admin-controlled);
  // PRICING_EUR_FALLBACK is used only while the call is in-flight.
  const [pricing, setPricing] = useState<Record<FlowType, number>>(PRICING_EUR_FALLBACK);
  useEffect(() => {
    let alive = true;
    api.get('/pricing').then((r) => {
      if (!alive) return;
      const insp = r.data?.inspection?.packages?.find((p: any) => p.count === 1)?.price;
      const sel = r.data?.selection?.plans?.find((p: any) => p.id === 'basic')?.price
                ?? r.data?.selection?.plans?.[0]?.price;
      setPricing({
        inspection: typeof insp === 'number' ? insp : PRICING_EUR_FALLBACK.inspection,
        selection: typeof sel === 'number' ? sel : PRICING_EUR_FALLBACK.selection,
      });
    }).catch(() => { /* fallback already in state */ });
    return () => { alive = false; };
  }, []);

  // Parallel fetch — cities + canonical countries (Geo-1 sprint).
  useEffect(() => {
    let mounted = true;
    Promise.all([api.get('/cities'), api.get('/geo/countries')])
      .then(([cRes, coRes]) => {
        if (!mounted) return;
        setAllCities(Array.isArray(cRes.data) ? cRes.data : []);
        const list: Country[] = Array.isArray(coRes.data) ? coRes.data : [];
        setGeoCountries(list);
        if (list.length && !list.find((c) => c.code === country)) {
          setCountry(list[0].code);
        }
      })
      .catch(() => {})
      .finally(() => { if (mounted) setCitiesLoading(false); });
    return () => { mounted = false; };
    // `country` is intentionally NOT a dep — first-mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Phase 3.0a — input validation (Funnel Stabilization).
  const validation = useMemo(() => {
    const errors: Record<string, string> = {};
    const currentYear = new Date().getFullYear();

    if (cities.length === 0) {
      errors.cities = i18n.t('create.err_pick_city') || 'Pick at least one city';
    }

    if (flow === 'inspection') {
      const v = link.trim();
      if (!v) {
        errors.link = i18n.t('create.err_link_empty') || 'Paste a link to the listing';
      } else {
        try {
          const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
          if (!u.host || !u.host.includes('.')) errors.link = i18n.t('create.err_link_invalid') || 'Enter a valid URL';
        } catch {
          errors.link = i18n.t('create.err_link_invalid') || 'Enter a valid URL';
        }
      }
    } else {
      if (brand.trim().length === 0) errors.brand = i18n.t('create.err_brand') || 'Brand is required';
      if (model.trim().length === 0) errors.model = i18n.t('create.err_model') || 'Model is required';
      const b = Number(budget);
      if (!budget || b < 1000) errors.budget = i18n.t('create.err_budget_min') || 'Budget must be at least €1,000';

      if (yearFrom) {
        const yf = Number(yearFrom);
        if (yf < 1990) errors.yearFrom = i18n.t('create.err_year_min') || 'Minimum year — 1990';
        else if (yf > currentYear + 1) errors.yearFrom = `${t('create.err_year_max') || 'Maximum year'} — ${currentYear + 1}`;
      }
      if (yearTo) {
        const yt = Number(yearTo);
        if (yt < 1990) errors.yearTo = i18n.t('create.err_year_min') || 'Minimum year — 1990';
        else if (yt > currentYear + 1) errors.yearTo = `${t('create.err_year_max') || 'Maximum year'} — ${currentYear + 1}`;
      }
      if (yearFrom && yearTo) {
        const yf = Number(yearFrom);
        const yt = Number(yearTo);
        if (yf > yt) errors.yearTo = i18n.t('create.err_year_order') || 'Year-to must be ≥ year-from';
      }
      if (mileageMax) {
        const km = Number(mileageMax);
        if (km < 0) errors.mileageMax = i18n.t('create.err_mileage_negative') || 'Mileage cannot be negative';
        else if (km > 1_000_000) errors.mileageMax = i18n.t('create.err_mileage_max') || 'Mileage too high';
      }
    }

    return { ok: Object.keys(errors).length === 0, errors };
  }, [flow, cities, link, brand, model, budget, yearFrom, yearTo, mileageMax, t]);

  const canSubmit = validation.ok;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      // Sprint R1 — Build the canonical payload. brand id (lowercase) is
      // resolved to its display name via CAR_BRANDS so the backend receives
      // "BMW" / "Mercedes-Benz" etc.
      const requestPayload: Record<string, unknown> = {
        type: flow,
        country,
        cities,
        comment: comment || undefined,
      };
      if (flow === 'inspection') {
        requestPayload.links = [link.trim()];
        requestPayload.urgency = urgency;
      } else {
        const brandResolved = (CAR_BRANDS.find((b) => b.id === brand.trim().toLowerCase())?.name) || brand.trim();
        requestPayload.brand = brandResolved;
        requestPayload.model = model.trim();
        requestPayload.budget = Number(budget);
        if (yearFrom) requestPayload.yearFrom = Number(yearFrom);
        if (yearTo) requestPayload.yearTo = Number(yearTo);
        if (fuel) requestPayload.fuel = fuel;
        if (transmission) requestPayload.transmission = transmission;
        if (mileageMax) requestPayload.mileageMax = Number(mileageMax);
      }

      // Sprint R1.2 — Auth gate. Anonymous users get bounced through
      // login first. Draft parked in AsyncStorage; routeAfterLogin
      // brings them back here.
      if (!isAuthenticated) {
        try {
          await AsyncStorage.setItem(
            R1_DRAFT_KEY,
            JSON.stringify({ payload: requestPayload, savedAt: Date.now() }),
          );
        } catch {
          // Storage failure isn't fatal — user can re-fill on return.
        }
        await setPendingIntent('auto_request_submit', {});
        setSubmitting(false);
        router.push('/login');
        return;
      }

      // Sprint Stripe-1 — Real Stripe Checkout via /payments/auto-request/checkout.
      // Backend returns { sessionId, url }; we open via the /payment/checkout
      // bridge (expo-web-browser on native, window.location on web).
      const originUrl =
        (process.env.EXPO_PUBLIC_BACKEND_URL as string) ||
        (typeof window !== 'undefined' ? window.location.origin : '');
      const res = await api.post('/payments/auto-request/checkout', {
        originUrl,
        requestPayload,
      });
      const checkout = res.data;
      if (!checkout?.url || !checkout?.sessionId) {
        Alert.alert(i18n.t('common.error') || 'Error', 'Checkout session creation failed');
        setSubmitting(false);
        return;
      }
      // Clear the draft once we have a Stripe session.
      try { await AsyncStorage.removeItem(R1_DRAFT_KEY); } catch { /* ignore */ }
      router.replace({
        pathname: '/payment/checkout',
        params: {
          checkoutUrl: encodeURIComponent(checkout.url),
          sessionId: checkout.sessionId,
          paymentId: checkout.sessionId,
        },
      } as any);
    } catch (e: any) {
      const data = e?.response?.data;
      const msg = data?.detail?.[0]?.msg ?? data?.message ?? 'Request creation failed';
      Alert.alert(i18n.t('common.error') || 'Error', typeof msg === 'string' ? msg : 'Request error');
    } finally {
      setSubmitting(false);
    }
  }, [
    canSubmit, submitting, flow, country, cities, comment, link, urgency,
    brand, model, budget, yearFrom, yearTo, fuel, transmission, mileageMax,
    router, t, isAuthenticated, setPendingIntent,
  ]);

  // Sprint 2B — Save vehicle as candidate (Vehicle Memory MVP).
  // Selection flow only; brand+model are the only required fields.
  const canSaveCandidate = flow === 'selection'
    && brand.trim().length > 0
    && model.trim().length > 0;

  const handleSaveCandidate = useCallback(async () => {
    if (savingCandidate || !canSaveCandidate) return;
    setSavingCandidate(true);
    try {
      const brandResolved = (CAR_BRANDS.find((b) => b.id === brand.trim().toLowerCase())?.name) || brand.trim();
      const v = await vehiclesApi.create({
        brand: brandResolved,
        model: model.trim(),
        year: yearFrom ? Number(yearFrom) : (yearTo ? Number(yearTo) : null),
        mileage: mileageMax ? Number(mileageMax) : null,
        price: budget ? Number(budget) : null,
        currency: 'EUR',
        fuel: fuel || null,
        transmission: transmission || null,
        location: null,
        thumbnail: null,
        listing_url: null,
        source: 'selection',
        external_source_id: null,
        notes: comment?.trim() || null,
      });
      setCandidateSavedId(v.id);
      Alert.alert(
        i18n.t('create.candidate_saved_title') || '✓ Saved to candidates',
        i18n.t('create.candidate_saved_body', {
          brand: v.brand,
          model: v.model,
          defaultValue: `${v.brand} ${v.model} added to your list. Open the list to compare with others.`,
        }) as string,
        [
          { text: i18n.t('common.continue') || 'Continue', style: 'cancel' },
          { text: i18n.t('create.candidate_open_list') || 'Open list', onPress: () => router.push('/vehicles' as any) },
        ],
      );
    } catch (e: any) {
      if (e?.response?.status === 401) {
        Alert.alert(
          i18n.t('create.candidate_signin_title') || 'Sign in',
          i18n.t('create.candidate_signin_body') || 'To save cars, please sign in first.',
          [
            { text: i18n.t('common.cancel') || 'Cancel', style: 'cancel' },
            { text: i18n.t('common.sign_in') || 'Sign in', onPress: () => router.push('/login' as any) },
          ],
        );
      } else {
        Alert.alert(
          i18n.t('create.candidate_save_failed_title') || 'Could not save',
          i18n.t('create.candidate_save_failed_body') || 'Please try again in a moment.',
        );
      }
    } finally {
      setSavingCandidate(false);
    }
  }, [savingCandidate, canSaveCandidate, brand, model, yearFrom, yearTo, mileageMax, budget, fuel, transmission, comment, router, t]);

  // ─── Step 0: Flow picker ─────────────────────────
  if (step === 0) {
    return (
      <FlowPicker
        colors={colors as any}
        pricing={pricing}
        onPick={(f) => { setFlow(f); setStep(1); }}
      />
    );
  }

  // ─── Step 1: Form ─────────────────────────
  const selectedCitiesText = cities.length > 0 ? cities.join(', ') : (i18n.t('create.placeholder_city') || 'Pick a city');
  const supportsMulti = flow === 'selection';

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={styles.topBar}>
          <TouchableOpacity
            onPress={() => (params.type ? router.back() : setStep(0))}
            testID="create-back-btn"
          >
            <Ionicons name="chevron-back" size={26} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.topTitle, { color: colors.text }]} numberOfLines={1}>
            {flow === 'inspection' ? (t('create.title_inspection') || 'Inspect a car') : (t('create.title_selection') || 'Find a car')}
          </Text>
          <View style={{ width: 26 }} />
        </View>

        <ScrollView contentContainerStyle={styles.scrollPad} keyboardShouldPersistTaps="handled">
          {flow === 'inspection' ? (
            <InspectionForm
              colors={colors as any}
              link={link} setLink={setLink}
              urgency={urgency} setUrgency={setUrgency}
              country={country} setCountry={setCountry}
              geoCountries={geoCountries}
              openCountryModal={() => setCountryModalOpen(true)}
              cities={cities}
              selectedCitiesText={selectedCitiesText}
              openCityModal={() => setCityModalOpen(true)}
              comment={comment} setComment={setComment}
            />
          ) : (
            <SelectionForm
              colors={colors as any}
              brand={brand} setBrand={setBrand}
              model={model} setModel={setModel}
              budget={budget} setBudget={setBudget}
              yearFrom={yearFrom} setYearFrom={setYearFrom}
              yearTo={yearTo} setYearTo={setYearTo}
              fuel={fuel} setFuel={setFuel}
              transmission={transmission} setTransmission={setTransmission}
              mileageMax={mileageMax} setMileageMax={setMileageMax}
              country={country} setCountry={setCountry}
              geoCountries={geoCountries}
              openCountryModal={() => setCountryModalOpen(true)}
              cities={cities}
              selectedCitiesText={selectedCitiesText}
              openCityModal={() => setCityModalOpen(true)}
              comment={comment} setComment={setComment}
            />
          )}

          <View style={{ height: 16 }} />
          <Text style={[styles.priceNote, { color: colors.textSecondary }]}>
            {cities.length === 0
              ? (t('create.pick_city_first') || 'Pick at least one city')
              : flow === 'inspection'
                ? `${t('create.price_inspection_label') || 'Price per inspection'}: €${pricing.inspection}`
                : `${t('create.price_selection_label') || 'Price per selection'}: €${pricing.selection}`
            }
          </Text>

          {/* STEP-1 — Value proposition (pre-payment trust block) */}
          <ValuePropBlock colors={colors as any} />

          {/* Sprint 2B — Save as vehicle candidate (secondary CTA) */}
          {flow === 'selection' && (
            <View style={{ marginTop: 16 }}>
              <TouchableOpacity
                testID="create-save-candidate-btn"
                disabled={!canSaveCandidate || savingCandidate}
                activeOpacity={0.8}
                onPress={handleSaveCandidate}
                style={[
                  styles.saveCandidateBtn,
                  {
                    borderColor: candidateSavedId ? '#10B981' : (canSaveCandidate ? colors.primary : colors.border),
                    backgroundColor: candidateSavedId ? 'rgba(16,185,129,0.08)' : 'transparent',
                    opacity: !canSaveCandidate ? 0.55 : 1,
                  },
                ]}
              >
                {savingCandidate ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <>
                    <Ionicons
                      name={candidateSavedId ? 'checkmark-circle' : 'bookmark-outline'}
                      size={18}
                      color={candidateSavedId ? '#10B981' : colors.text}
                    />
                    <Text style={[styles.saveCandidateTxt, { color: candidateSavedId ? '#10B981' : colors.text }]}>
                      {candidateSavedId
                        ? (t('create.candidate_saved_chip') || 'Saved to candidates')
                        : (t('create.candidate_save_cta') || 'Save as candidate')}
                    </Text>
                  </>
                )}
              </TouchableOpacity>
              <Text style={[styles.saveCandidateHint, { color: colors.textSecondary }]}>
                {t('create.candidate_save_hint') || 'Save the car without paying — come back, compare, order inspection later'}
              </Text>
            </View>
          )}

          {/* Inline validation summary — shown when canSubmit=false */}
          {!canSubmit && Object.keys(validation.errors).length > 0 && (
            <View testID="create-validation-summary" style={[styles.errorBox, { borderColor: '#EF4444', backgroundColor: 'rgba(239,68,68,0.08)' }]}>
              <Ionicons name="alert-circle" size={16} color="#EF4444" />
              <View style={{ flex: 1 }}>
                {Object.entries(validation.errors).map(([field, msg]) => (
                  <Text key={field} testID={`create-error-${field}`} style={[styles.errorText, { color: '#EF4444' }]}>
                    · {msg}
                  </Text>
                ))}
              </View>
            </View>
          )}
        </ScrollView>

        <View style={[styles.submitBar, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
          <TouchableOpacity
            testID="create-submit-btn"
            activeOpacity={0.85}
            disabled={!canSubmit || submitting}
            style={[styles.submitBtn, { backgroundColor: canSubmit ? colors.primary : colors.border }]}
            onPress={handleSubmit}
          >
            {submitting ? (
              <ActivityIndicator color={canSubmit ? '#0F0F10' : '#FFF'} />
            ) : (
              <Text
                numberOfLines={1}
                ellipsizeMode="tail"
                style={[styles.submitBtnText, { color: canSubmit ? '#0F0F10' : '#FFF' }]}
              >
                {flow === 'inspection'
                  ? `${t('create.cta_inspection') || 'Order inspection'} · €${pricing.inspection}`
                  : `${t('create.cta_selection') || 'Order selection'} · €${pricing.selection}`}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        <CityPickerModal
          visible={cityModalOpen}
          onClose={() => setCityModalOpen(false)}
          allCities={allCities}
          loading={citiesLoading}
          selected={cities}
          onChange={(next, pickedCountry) => {
            setCities(next);
            if (pickedCountry) setCountry(pickedCountry);
            if (!supportsMulti) setCityModalOpen(false);
          }}
          multi={supportsMulti}
          countryFilter={country}
          colors={colors as any}
        />

        <CountryPickerModal
          visible={countryModalOpen}
          onClose={() => setCountryModalOpen(false)}
          countries={geoCountries}
          selected={country}
          onSelect={(code: string) => {
            if (code !== country) {
              setCountry(code);
              // Cascade: country change invalidates city selection.
              setCities([]);
            }
          }}
          colors={colors as any}
        />
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}
