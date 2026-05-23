// Phase 2 — Request Detail (customer view).
// Shows status / type / country / city / links / inspection jobs / reports.
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
  Platform,
  Share,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import { useThemeContext } from '../../src/context/ThemeContext';
import { api } from '../../src/services/api';
import PricingBreakdown, { type PricingProjection } from '../../src/components/PricingBreakdown';
import {
  previewRequestQuote,
  getRequestQuote,
  confirmRequestQuote,
  type RequestQuote,
} from '../../src/services/pricingProjection';
import { createSnapshotCheckout } from '../../src/services/snapshotPayments';
import i18n from '../../src/i18n';

// Status / job-state / urgency / fuel / transmission strings live in
// `auto_request.*` namespace; consumers look up by enum key.
const STATUS_KEYS = ['open', 'matching', 'in_progress', 'report_ready', 'completed', 'cancelled'] as const;
const STATUS_COLOR: Record<string, string> = {
  open: '#F59E0B',
  matching: '#F59E0B',
  in_progress: '#3B82F6',
  report_ready: '#10B981',
  completed: '#6B7280',
  cancelled: '#9CA3AF',
};

// Sprint A3a side-quest — inline component for matching exposure stats.
// Previously referenced as <MatchStat> with no definition, which threw at
// render time when a request had `matching.exposures` populated. Inline
// rather than a new module: it has exactly one caller, four lines of
// content, and adding an abstraction would violate "no abstraction pass".
function MatchStat({
  colors,
  color,
  label,
  n,
}: {
  colors: any;
  color: string;
  label: string;
  n: number;
}) {
  return (
    <View style={styles.matchStat}>
      <View style={[styles.matchStatDot, { backgroundColor: color }]} />
      <Text style={[styles.matchStatN, { color: colors.text }]}>{n}</Text>
      <Text style={[styles.matchStatLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

// Granular inspector lifecycle (when an inspector is on the job).
// Maps inspection_job.status → customer-facing label via `auto_request.job_state.<key>.label`.
const JOB_LIFECYCLE_META: Record<string, { color: string; step: number }> = {
  claimed:    { color: '#3B82F6', step: 1 },
  on_route:   { color: '#3B82F6', step: 2 },
  arrived:    { color: '#3B82F6', step: 3 },
  inspecting: { color: '#F59E0B', step: 4 },
  done:       { color: '#10B981', step: 5 },
};

const LIFECYCLE_STEPS = ['claimed', 'on_route', 'arrived', 'inspecting', 'done'] as const;

// Enum keys only — labels are resolved via `t('auto_request.urgency.<key>')` etc.
const URGENCY_KEYS = ['asap', '24h', 'week'] as const;
const FUEL_KEYS = ['petrol', 'diesel', 'hybrid', 'electric'] as const;
const TRANSMISSION_KEYS = ['manual', 'auto'] as const;

type JobsPayload = {
  request: any;
  jobs: Array<{
    id: string;
    city: string;
    inspectorId: string | null;
    status: string;
  }>;
};

type Report = {
  id: string;
  requestId?: string;
  score?: number;
  riskLevel?: string;
  verdict?: string;
  createdAt?: string;
};

export default function RequestDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useThemeContext();
  const { t } = useTranslation();

  const [data, setData] = useState<JobsPayload | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [matching, setMatching] = useState<any | null>(null);
  const [quote, setQuote] = useState<RequestQuote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [jobsRes, reportsRes, matchingRes] = await Promise.allSettled([
        api.get(`/customer/requests/${id}/jobs`),
        api.get(`/customer/requests/${id}/reports`),
        api.get(`/customer/requests/${id}/matching`),
      ]);
      if (jobsRes.status === 'fulfilled') {
        setData(jobsRes.value.data);
        setError(null);
      } else {
        setError(i18n.t('auto_request.load_error'));
      }
      if (reportsRes.status === 'fulfilled') {
        const list = reportsRes.value.data?.items ?? reportsRes.value.data ?? [];
        setReports(Array.isArray(list) ? list : []);
      }
      if (matchingRes.status === 'fulfilled') {
        setMatching(matchingRes.value.data);
      }
      // Pricing-3: load existing quote (pending or confirmed). Silent
      // best-effort — the screen pre-dates pricing and many legacy
      // requests will have no quote yet. We show "Get quote" CTA then.
      try {
        const q = await getRequestQuote(String(id));
        setQuote(q);
      } catch {
        setQuote(null);
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Pricing-3 — preview / fetch the request-level quote on demand. Was
  // referenced from JSX but never defined; ResponsivelyResolving here so
  // the "Показать стоимость инспекции" CTA actually works.
  const handleQuote = useCallback(async () => {
    if (!id || quoteBusy) return;
    setQuoteBusy(true);
    try {
      const q = await previewRequestQuote(String(id));
      setQuote(q);
    } catch {
      // Silent — the surface for errors is the empty state, not a toast.
      // Pricing-1/2/3 surfaces own their own retry UX downstream.
    } finally {
      setQuoteBusy(false);
    }
  }, [id, quoteBusy]);

  // Pricing-3 — customer confirms the quote → backend writes
  // `car_requests.pricing.confirmedAt` (the snapshot Payments-1 reads).
  const handleConfirmQuote = useCallback(async () => {
    if (!id || quoteBusy) return;
    setQuoteBusy(true);
    try {
      const q = await confirmRequestQuote(String(id));
      setQuote(q);
    } catch {
      // Same rationale as handleQuote — leave error surface to the card.
    } finally {
      setQuoteBusy(false);
    }
  }, [id, quoteBusy]);

  // Payments-2A — Mobile pay-button.
  // Strict contract:
  //   • Frontend NEVER posts an `amount`. Backend reads it from the
  //     confirmed pricing snapshot (`car_requests.pricing.customerTotal`).
  //   • On success the backend returns a Stripe Checkout URL (or a mock
  //     URL when STRIPE_API_KEY is absent + method='mock'). We open it
  //     and Stripe will redirect to /payment-success?session_id=...
  //   • No webhook, no refund, no admin UI. Those are Payments-2B/C/D.
  const handlePay = useCallback(async () => {
    if (!id || payBusy) return;
    if (!quote || quote.status !== 'confirmed') return;
    setPayBusy(true);
    setPayError(null);
    try {
      // Origin URL — Stripe needs absolute https. On web we have one
      // directly; on native (Expo) we use the public preview origin
      // baked into EXPO_PUBLIC_BACKEND_URL (same one used by `api`).
      let originUrl = '';
      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        originUrl = window.location.origin;
      } else {
        originUrl =
          (process.env.EXPO_PUBLIC_BACKEND_URL as string | undefined) || '';
      }
      if (!originUrl) {
        setPayError(i18n.t('auto_request.pay_error_origin'));
        return;
      }

      // method defaults to 'stripe'; backend falls back to 503 if
      // STRIPE_API_KEY is missing — caller surfaces that as an error.
      const session = await createSnapshotCheckout(String(id), originUrl, 'stripe');
      if (!session?.url) {
        setPayError(i18n.t('auto_request.pay_error_link'));
        return;
      }

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        // On web — full-page redirect so Stripe Checkout owns the tab.
        window.location.href = session.url;
        return;
      }

      // Native — open in in-app browser. Stripe will redirect back to
      // `${originUrl}/payment-success?session_id=...` once the user pays
      // or cancels, and the deep link surface there handles the rest.
      await WebBrowser.openBrowserAsync(session.url);
    } catch (e: any) {
      const code = e?.response?.data?.detail?.code || e?.response?.data?.code;
      const msg = e?.response?.data?.detail?.message || e?.response?.data?.message;
      if (code === 'PRICING_SNAPSHOT_MISSING' || code === 'PRICING_SNAPSHOT_UNCONFIRMED') {
        setPayError(i18n.t('auto_request.pay_error_unconfirmed'));
      } else if (code === 'STRIPE_NOT_CONFIGURED') {
        setPayError(i18n.t('auto_request.pay_error_temporary'));
      } else {
        setPayError(msg || i18n.t('auto_request.pay_error_generic'));
      }
    } finally {
      setPayBusy(false);
    }
  }, [id, payBusy, quote]);

  const req = data?.request;
  const jobs = data?.jobs ?? [];
  // Translate status to render-ready meta. Unknown status keys fall through
  // to a sensible neutral block.
  const meta = req
    ? (STATUS_KEYS as readonly string[]).includes(req.status)
      ? {
          label: i18n.t(`auto_request.status.${req.status}.label`),
          color: STATUS_COLOR[req.status] ?? colors.textSecondary,
          hint:  i18n.t(`auto_request.status.${req.status}.hint`),
        }
      : { label: req.status, color: colors.textSecondary, hint: '' }
    : null;

  const openLink = (url: string) => {
    Linking.canOpenURL(url).then((ok) => {
      if (ok) Linking.openURL(url);
    });
  };

  const shareRequest = async () => {
    if (!req) return;
    const title = [req.brand, req.model].filter(Boolean).join(' ') || i18n.t('auto_request.fallback_request_title');
    try {
      await Share.share({
        message: i18n.t('auto_request.share_message', { title, cities: req.cities?.join(', ') ?? '' }),
      });
    } catch {}
  };

  return (
    <View style={[styles.safe, { backgroundColor: colors.background }]}>
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => router.back()} testID="req-back-btn">
            <Ionicons name="chevron-back" size={24} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: colors.text }]}>{t('auto_request.header_title')}</Text>
          <TouchableOpacity onPress={shareRequest} testID="req-share-btn">
            <Ionicons name="share-outline" size={22} color={colors.text} />
          </TouchableOpacity>
        </View>

        {loading && !data ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={colors.primary} />
        ) : error || !req ? (
          <Text style={[styles.errorText, { color: '#EF4444' }]}>{error ?? t('auto_request.not_found')}</Text>
        ) : (
          <ScrollView contentContainerStyle={styles.body}>
            {/* Status banner */}
            {meta && (
              <View style={[styles.statusBanner, { backgroundColor: `${meta.color}15` }]} testID={`req-status-${req.status}`}>
                <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.statusLabel, { color: meta.color }]}>{meta.label}</Text>
                  {meta.hint ? <Text style={[styles.statusHint, { color: colors.textSecondary }]}>{meta.hint}</Text> : null}
                </View>
              </View>
            )}

            {/* Pricing-3: customer-facing quote card.
                Three states:
                  • no quote yet  → "Get quote" CTA
                  • pending quote → breakdown + "Confirm price" CTA
                  • confirmed     → breakdown with lock badge, immutable */}
            {quote ? (
              <View style={{ marginTop: 16 }}>
                <Text style={[styles.sectionTitle, { color: colors.text }]} testID="req-quote-title">
                  {t('pricing.section_title')}
                </Text>
                {quote.jobs.map((line) => (
                  <View key={line.jobId} style={{ marginTop: 8 }}>
                    <Text style={[styles.quoteCity, { color: colors.textSecondary }]}>{line.city}</Text>
                    <PricingBreakdown projection={line.projection as PricingProjection} showManualReviewBanner={true} />
                  </View>
                ))}
                {/* Aggregate total */}
                <View style={[styles.quoteAggregate, { backgroundColor: colors.card, borderColor: colors.border }]} testID="req-quote-aggregate">
                  <Text style={[styles.quoteAggregateLabel, { color: colors.text }]}>
                    {t('pricing.total_label')}
                  </Text>
                  <Text style={[styles.quoteAggregateValue, { color: colors.primary }]} testID="req-quote-total">
                    €{Math.round(quote.customerTotal)}
                  </Text>
                </View>
                {quote.status !== 'confirmed' ? (
                  <TouchableOpacity
                    testID="req-quote-confirm-btn"
                    style={[styles.confirmCta, { backgroundColor: colors.primary, opacity: quoteBusy ? 0.6 : 1 }]}
                    onPress={handleConfirmQuote}
                    disabled={quoteBusy}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="lock-closed" size={16} color={(colors as any).onPrimary || '#000'} />
                    <Text style={[styles.confirmCtaText, { color: (colors as any).onPrimary || '#000' }]}>
                      {t('pricing.confirm_cta')}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  // Payments-2A — Pay-button. Visible only on a confirmed
                  // quote AND while the request hasn't progressed past
                  // "open" / "matching" (work started → no charge again).
                  ['open', 'matching', undefined, null].includes(req?.status as any) ? (
                    <View testID="req-pay-block">
                      <TouchableOpacity
                        testID="req-pay-btn"
                        style={[styles.payCta, { backgroundColor: '#10B981', opacity: payBusy ? 0.6 : 1 }]}
                        onPress={handlePay}
                        disabled={payBusy}
                        activeOpacity={0.85}
                      >
                        {payBusy ? (
                          <ActivityIndicator color="#FFF" />
                        ) : (
                          <>
                            <Ionicons name="card" size={18} color="#FFF" />
                            <Text style={styles.payCtaText} testID="req-pay-btn-label">
                              {t('pricing.pay_cta')} €{Math.round(quote.customerTotal)}
                            </Text>
                          </>
                        )}
                      </TouchableOpacity>
                      {payError ? (
                        <Text style={[styles.payErrorText, { color: '#EF4444' }]} testID="req-pay-error">
                          {payError}
                        </Text>
                      ) : (
                        <Text style={[styles.payHintText, { color: colors.textSecondary }]}>
                          {t('pricing.pay_hint')}
                        </Text>
                      )}
                    </View>
                  ) : null
                )}
              </View>
            ) : (
              <TouchableOpacity
                testID="req-quote-fetch-btn"
                style={[styles.quotePromptCta, { backgroundColor: colors.card, borderColor: colors.border, opacity: quoteBusy ? 0.6 : 1 }]}
                onPress={handleQuote}
                disabled={quoteBusy}
                activeOpacity={0.8}
              >
                <Ionicons name="pricetag" size={18} color={colors.primary} />
                <Text style={[styles.quotePromptText, { color: colors.text }]}>
                  {t('pricing.preview_cta')}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
              </TouchableOpacity>
            )}

            {/* P0 — Live inspector lifecycle. Active while an assigned job
                is moving through claimed → on_route → arrived → inspecting → done. */}
            {(() => {
              const activeJob = jobs.find((j) => LIFECYCLE_STEPS.includes(j.status as any));
              if (!activeJob) return null;
              const meta = JOB_LIFECYCLE_META[activeJob.status];
              if (!meta) return null;
              const lc = {
                color: meta.color,
                step: meta.step,
                label: i18n.t(`auto_request.job_state.${activeJob.status}.label`),
                hint:  i18n.t(`auto_request.job_state.${activeJob.status}.hint`),
              };
              const currentIdx = LIFECYCLE_STEPS.indexOf(activeJob.status as any);
              return (
                <View
                  testID="req-live-lifecycle"
                  style={[styles.lifecycleCard, { backgroundColor: colors.card, borderColor: lc.color }]}
                >
                  <View style={styles.lifecycleHead}>
                    <View style={[styles.lifecycleIconBox, { backgroundColor: `${lc.color}20` }]}>
                      <Ionicons
                        name={
                          activeJob.status === 'on_route' ? 'navigate'
                            : activeJob.status === 'arrived' ? 'location'
                            : activeJob.status === 'inspecting' ? 'construct'
                            : activeJob.status === 'done' ? 'checkmark-done-circle'
                            : 'briefcase'
                        }
                        size={22}
                        color={lc.color}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.lifecycleLabel, { color: lc.color }]}>{lc.label}</Text>
                      <Text style={[styles.lifecycleHint, { color: colors.textSecondary }]}>{lc.hint}</Text>
                    </View>
                  </View>
                  <View style={styles.lifecycleStepsRow}>
                    {LIFECYCLE_STEPS.map((s, idx) => {
                      const isDone = idx < currentIdx || activeJob.status === 'done';
                      const isCurrent = idx === currentIdx;
                      const dotColor = isDone ? '#10B981' : isCurrent ? lc.color : colors.border;
                      return (
                        <View key={s} style={styles.lifecycleStepCol}>
                          <View style={[styles.lifecycleDot, { backgroundColor: dotColor }]} />
                          {idx < LIFECYCLE_STEPS.length - 1 && (
                            <View style={[styles.lifecycleLine, { backgroundColor: idx < currentIdx ? '#10B981' : colors.border }]} />
                          )}
                        </View>
                      );
                    })}
                  </View>
                  <View style={styles.lifecycleStepsLabels}>
                    {(['accepted','on_route','arrived','inspecting','report'] as const).map((stepKey, idx) => (
                      <Text
                        key={stepKey}
                        style={[
                          styles.lifecycleStepLabel,
                          { color: idx <= currentIdx ? colors.text : colors.textSecondary },
                          idx === currentIdx && { fontWeight: '700' },
                        ]}
                        numberOfLines={1}
                      >
                        {t(`auto_request.progress_steps.${stepKey}`)}
                      </Text>
                    ))}
                  </View>
                </View>
              );
            })()}

            {/* Phase 3.0b STEP-1 — ETA pane. After payment the user lands here and sees
                a clear "we're working on it" timeline so they don't think their €149 vanished. */}
            {(req.status === 'open' || req.status === 'matching') && (
              <View
                testID="req-eta-pane"
                style={[styles.etaCard, { backgroundColor: colors.card, borderColor: colors.border }]}
              >
                <View style={styles.etaHeaderRow}>
                  <View style={[styles.etaIconBox, { backgroundColor: 'rgba(245,184,0,0.15)' }]}>
                    <Ionicons name="time" size={20} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.etaTitle, { color: colors.text }]}>{t('eta.title')}</Text>
                    <Text style={[styles.etaSub, { color: colors.textSecondary }]}>{t('eta.subtitle')}</Text>
                  </View>
                </View>

                {/* 4-step timeline */}
                <View style={styles.etaTimeline}>
                  <EtaStep colors={colors} active={true}  done={true}  label={t('eta.step_paid')}   />
                  <EtaStep colors={colors} active={true}  done={false} label={t('eta.step_match')}  />
                  <EtaStep colors={colors} active={false} done={false} label={t('eta.step_visit')}  />
                  <EtaStep colors={colors} active={false} done={false} label={t('eta.step_report')} />
                </View>
              </View>
            )}

            {/* Matching progress — Phase 3 marketplace transparency */}
            {matching && matching.exposures && matching.exposures.total > 0 && (
              <View
                style={[styles.matchingCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                testID="matching-card"
              >
                <View style={styles.matchingHeaderRow}>
                  <Ionicons name="people-outline" size={18} color={colors.primary} />
                  <Text style={[styles.matchingTitle, { color: colors.text }]}>{t('auto_request.matching_title')}</Text>
                </View>
                <Text style={[styles.matchingLabel, { color: colors.textSecondary }]}>{matching.label}</Text>

                <View style={styles.matchingBarWrap}>
                  {['visible', 'accepted', 'expired', 'rejected'].map((key) => {
                    const val = matching.exposures[key] ?? 0;
                    if (val === 0) return null;
                    const pct = (val / matching.exposures.total) * 100;
                    const color =
                      key === 'accepted' ? '#10B981' :
                      key === 'visible' ? '#3B82F6' :
                      key === 'rejected' ? '#EF4444' : '#9CA3AF';
                    return (
                      <View
                        key={key}
                        testID={`matching-bar-${key}`}
                        style={{ height: 6, flexBasis: `${pct}%`, backgroundColor: color }}
                      />
                    );
                  })}
                </View>

                <View style={styles.matchingStatsRow}>
                  <MatchStat colors={colors} color="#3B82F6"           label={t('auto_request.matching_visible')}  n={matching.exposures.visible} />
                  <MatchStat colors={colors} color="#10B981"           label={t('auto_request.matching_accepted')} n={matching.exposures.accepted} />
                  <MatchStat colors={colors} color="#9CA3AF"           label={t('auto_request.matching_expired')}  n={matching.exposures.expired} />
                  <MatchStat colors={colors} color={colors.textSecondary} label={t('auto_request.matching_total')} n={matching.exposures.total} />
                </View>
              </View>
            )}

            {/* Kicker + title */}
            <Text style={[styles.kicker, { color: colors.primary }]}>
              {req.type === 'inspection' ? t('auto_request.type_inspection') : t('auto_request.type_selection')}
            </Text>
            <Text style={[styles.title, { color: colors.text }]}>
              {[req.brand, req.model].filter(Boolean).join(' ') || t('auto_request.fallback_request_title')}
            </Text>

            {/* Key facts */}
            <View style={styles.factRow}>
              {req.budget > 0 && (
                <Fact colors={colors} icon="cash-outline" label={t('auto_request.fact.budget')}
                  value={t('auto_request.fact.budget_value', { amount: Number(req.budget).toLocaleString('de-DE') })} />
              )}
              {(req.yearFrom || req.yearTo) && (
                <Fact colors={colors} icon="calendar-outline" label={t('auto_request.fact.years')}
                  value={`${req.yearFrom ?? '—'} – ${req.yearTo ?? '—'}`} />
              )}
              {req.fuel && (
                <Fact colors={colors} icon="water-outline" label={t('auto_request.fact.fuel')}
                  value={(FUEL_KEYS as readonly string[]).includes(req.fuel) ? t(`auto_request.fuel.${req.fuel}`) : req.fuel} />
              )}
              {req.transmission && (
                <Fact colors={colors} icon="settings-outline" label={t('auto_request.fact.transmission')}
                  value={(TRANSMISSION_KEYS as readonly string[]).includes(req.transmission) ? t(`auto_request.transmission.${req.transmission}`) : req.transmission} />
              )}
              {req.mileageMax && (
                <Fact colors={colors} icon="speedometer-outline" label={t('auto_request.fact.mileage')}
                  value={t('auto_request.fact.mileage_value', { amount: Number(req.mileageMax).toLocaleString('de-DE'), km: t('common.km') })} />
              )}
              {req.urgency && (
                <Fact colors={colors} icon="time-outline" label={t('auto_request.fact.urgency')}
                  value={(URGENCY_KEYS as readonly string[]).includes(req.urgency) ? t(`auto_request.urgency.${req.urgency}`) : req.urgency} />
              )}
            </View>

            <Fact
              colors={colors}
              icon="location-outline"
              label={t('auto_request.fact.location')}
              value={[req.country, (req.cities ?? []).join(' · ')].filter(Boolean).join(' · ') || '—'}
              full
            />

            {req.comment ? (
              <View style={[styles.commentBox, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Text style={[styles.commentLabel, { color: colors.textSecondary }]}>{t('auto_request.section_comment_label')}</Text>
                <Text style={[styles.commentText, { color: colors.text }]}>{req.comment}</Text>
              </View>
            ) : null}

            {/* Links */}
            {Array.isArray(req.links) && req.links.length > 0 && (
              <>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('auto_request.section_links_title')}</Text>
                {req.links.map((url: string, i: number) => (
                  <TouchableOpacity
                    key={`${url}-${i}`}
                    testID={`req-link-${i}`}
                    onPress={() => openLink(url)}
                    style={[styles.linkRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                  >
                    <Ionicons name="link-outline" size={16} color={colors.primary} />
                    <Text style={[styles.linkText, { color: colors.primary }]} numberOfLines={1}>
                      {url.replace(/^https?:\/\//, '')}
                    </Text>
                    <Ionicons name="open-outline" size={14} color={colors.textSecondary} />
                  </TouchableOpacity>
                ))}
              </>
            )}

            {/* Jobs progress */}
            <View style={styles.statsRow}>
              <Stat colors={colors} label={t('auto_request.jobs_total')}   value={req.jobsTotal} />
              <Stat colors={colors} label={t('auto_request.jobs_claimed')} value={req.jobsClaimed} accent />
              <Stat colors={colors} label={t('auto_request.jobs_done')}    value={req.jobsDone} />
            </View>

            {/* Jobs */}
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('auto_request.section_jobs_title')}</Text>
            {jobs.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>{t('auto_request.jobs_empty')}</Text>
            ) : (
              jobs.map((j) => {
                const jobMeta = (STATUS_KEYS as readonly string[]).includes(j.status)
                  ? { label: i18n.t(`auto_request.status.${j.status}.label`), color: STATUS_COLOR[j.status] ?? colors.textSecondary, hint: i18n.t(`auto_request.status.${j.status}.hint`) }
                  : { label: j.status, color: colors.textSecondary, hint: '' };
                const inspectorLine = j.inspectorId
                  ? i18n.t('auto_request.job_inspector_label', { shortId: j.inspectorId.substring(0, 8) })
                  : i18n.t('auto_request.job_inspector_waiting');
                return (
                  <View key={j.id} style={[styles.jobRow, { backgroundColor: colors.card, borderColor: colors.border }]} testID={`job-${j.id}`}>
                    <View style={styles.jobLeft}>
                      <View style={[styles.jobIcon, { backgroundColor: `${jobMeta.color}25` }]}>
                        <Ionicons name="location" size={16} color={jobMeta.color} />
                      </View>
                      <View>
                        <Text style={[styles.jobCity, { color: colors.text }]}>{j.city}</Text>
                        <Text style={[styles.jobSub, { color: colors.textSecondary }]}>{inspectorLine}</Text>
                      </View>
                    </View>
                    <View style={[styles.pill, { backgroundColor: `${jobMeta.color}20`, borderColor: jobMeta.color }]}>
                      <Text style={[styles.pillText, { color: jobMeta.color }]}>{jobMeta.label}</Text>
                    </View>
                  </View>
                );
              })
            )}

            {/* Reports */}
            <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('auto_request.section_reports_title')}</Text>
            {reports.length === 0 ? (
              <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                {t('auto_request.reports_empty')}
              </Text>
            ) : (
              reports.map((rep) => (
                <TouchableOpacity
                  key={rep.id}
                  testID={`req-report-${rep.id}`}
                  activeOpacity={0.85}
                  style={[styles.reportRow, { backgroundColor: colors.card, borderColor: colors.border }]}
                  onPress={() =>
                    router.push({ pathname: '/dashboard/reports/[id]', params: { id: rep.id } } as any)
                  }
                >
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.reportTitle, { color: colors.text }]}>
                      {t('auto_request.report_label', { verdict: rep.verdict ?? t('auto_request.report_default_verdict') })}
                    </Text>
                    {rep.createdAt && (
                      <Text style={[styles.reportDate, { color: colors.textSecondary }]}>
                        {new Date(rep.createdAt).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' })}
                      </Text>
                    )}
                  </View>
                  {rep.score !== undefined && (
                    <View style={[styles.scoreBadge, { borderColor: rep.score >= 7 ? '#10B981' : rep.score >= 5 ? '#F59E0B' : '#EF4444' }]}>
                      <Text style={[styles.scoreText, { color: rep.score >= 7 ? '#10B981' : rep.score >= 5 ? '#F59E0B' : '#EF4444' }]}>
                        {rep.score.toFixed(1)}
                      </Text>
                    </View>
                  )}
                  <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
                </TouchableOpacity>
              ))
            )}

            <View style={{ height: 32 }} />
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}

function EtaStep({ colors, active, done, label }: { colors: any; active: boolean; done: boolean; label: string }) {
  const baseColor = done ? '#10B981' : active ? colors.primary : colors.border;
  return (
    <View style={styles.etaStep}>
      <View style={[styles.etaStepDot, { backgroundColor: baseColor, borderColor: baseColor }]}>
        {done ? (
          <Ionicons name="checkmark" size={11} color="#FFF" />
        ) : active ? (
          <ActivityIndicator size="small" color="#FFF" />
        ) : null}
      </View>
      <Text
        style={[
          styles.etaStepLabel,
          { color: active || done ? colors.text : colors.textSecondary, fontWeight: active || done ? '700' : '500' },
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

function Fact({ colors, icon, label, value, full }: any) {
  return (
    <View style={[styles.factBox, full && { flex: undefined, width: '100%' }, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={styles.factHead}>
        <Ionicons name={icon} size={14} color={colors.textSecondary} />
        <Text style={[styles.factLabel, { color: colors.textSecondary }]}>{label}</Text>
      </View>
      <Text style={[styles.factValue, { color: colors.text }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Stat({ colors, label, value, accent }: any) {
  return (
    <View
      style={[
        styles.statBox,
        {
          backgroundColor: accent ? `${colors.primary}15` : colors.card,
          borderColor: accent ? colors.primary : colors.border,
        },
      ]}
    >
      <Text style={[styles.statValue, { color: colors.text }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14, borderBottomWidth: 1 },
  headerTitle: { fontSize: 17, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 60 },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    marginBottom: 20,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusLabel: { fontSize: 15, fontWeight: '700' },
  statusHint: { fontSize: 12, marginTop: 2 },

  // Live lifecycle card (P0)
  lifecycleCard: { borderWidth: 1.5, borderRadius: 16, padding: 14, marginBottom: 20 },
  lifecycleHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  lifecycleIconBox: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  lifecycleLabel: { fontSize: 15, fontWeight: '800' },
  lifecycleHint: { fontSize: 12, marginTop: 2 },
  lifecycleStepsRow: { flexDirection: 'row', alignItems: 'center', height: 14, paddingHorizontal: 4 },
  lifecycleStepCol: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  lifecycleDot: { width: 12, height: 12, borderRadius: 6 },
  lifecycleLine: { flex: 1, height: 2 },
  lifecycleStepsLabels: { flexDirection: 'row', marginTop: 8, paddingHorizontal: 0 },
  lifecycleStepLabel: { flex: 1, fontSize: 10, textAlign: 'left' },

  kicker: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  title: { fontSize: 24, fontWeight: '800', marginTop: 6 },

  // Sprint A3a side-quest — matching exposure stats (referenced as <MatchStat>).
  matchingStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginTop: 10,
  },
  matchStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  matchStatDot: { width: 8, height: 8, borderRadius: 4 },
  matchStatN: { fontSize: 13, fontWeight: '800' },
  matchStatLabel: { fontSize: 12, fontWeight: '600' },

  factRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  factBox: {
    flexBasis: '48%',
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    flexGrow: 1,
    marginTop: 0,
  },
  factHead: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 4 },
  factLabel: { fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  factValue: { fontSize: 14, fontWeight: '700' },
  commentBox: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14 },
  commentLabel: { fontSize: 11, fontWeight: '600', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  commentText: { fontSize: 14, lineHeight: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginTop: 24, marginBottom: 10 },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderWidth: 1,
    borderRadius: 10,
    marginBottom: 6,
  },
  linkText: { flex: 1, fontSize: 13, fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 8, marginTop: 18 },
  statBox: { flex: 1, borderWidth: 1, borderRadius: 12, padding: 12, alignItems: 'center' },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: 2 },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  jobLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  jobIcon: { height: 36, width: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  jobCity: { fontSize: 15, fontWeight: '700' },
  jobSub: { fontSize: 12, marginTop: 2 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: '700' },
  reportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  reportTitle: { fontSize: 14, fontWeight: '700' },
  reportDate: { fontSize: 12, marginTop: 2 },
  scoreBadge: {
    borderWidth: 2,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  scoreText: { fontSize: 14, fontWeight: '800' },
  emptyText: { fontSize: 13, fontStyle: 'italic', padding: 14 },
  errorText: { marginTop: 40, textAlign: 'center', fontWeight: '700' },
  // STEP-1 ETA pane
  etaCard: {
    marginVertical: 8,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  etaHeaderRow: { flexDirection: 'row', alignItems: 'flex-start' },
  etaIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  etaTitle: { fontSize: 15, fontWeight: '800', marginBottom: 2 },
  etaSub: { fontSize: 12, lineHeight: 17 },
  etaTimeline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 16,
    paddingHorizontal: 4,
  },
  etaStep: { flex: 1, alignItems: 'center' },
  etaStepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  etaStepLabel: { fontSize: 10, textAlign: 'center', lineHeight: 13 },

  // Pricing-3 quote card
  quoteCity: { fontSize: 11.5, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginLeft: 4 },
  quoteAggregate: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 12, padding: 14, borderRadius: 12, borderWidth: 1,
  },
  quoteAggregateLabel: { fontSize: 14, fontWeight: '700' },
  quoteAggregateValue: { fontSize: 20, fontWeight: '800', letterSpacing: 0.2 },
  confirmCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    marginTop: 12, paddingVertical: 14, borderRadius: 12,
  },
  confirmCtaText: { fontSize: 15, fontWeight: '800' },
  // Payments-2A — pay button styles. Distinct from confirmCta so the
  // visual hierarchy is clear: confirm = lock the price, pay = move money.
  payCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    marginTop: 14, paddingVertical: 16, borderRadius: 14,
  },
  payCtaText: { fontSize: 16, fontWeight: '800', color: '#FFF', letterSpacing: 0.2 },
  payHintText: { fontSize: 12, marginTop: 8, textAlign: 'center', fontWeight: '600' },
  payErrorText: { fontSize: 13, marginTop: 8, textAlign: 'center', fontWeight: '700' },
  quotePromptCta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: 16, paddingVertical: 14, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: 1,
  },
  quotePromptText: { flex: 1, fontSize: 14, fontWeight: '700' },
});
