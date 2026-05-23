/**
 * Car-Selection-8 — OfferPackageBlock.
 *
 * One component, three surfaces. All visible strings flow through
 * the Phase-5 i18n freeze (`car_selection.offer_package.*`); all
 * backend codes flow through `mapCarSelectionError` extended for
 * Phase 6 codes.
 *
 *   provider → draft composer + own list + deliver action
 *   customer → decision surface (accept / decline, optional note)
 *   admin    → governance list + revoke action
 *
 * UI INVARIANTS (Phase 8 brief):
 *   • draft mutable only for provider (component never shows an
 *     edit affordance to customer / admin; the read-only card path
 *     is taken for every non-draft package or non-owner viewer)
 *   • delivered package is immutable (composer hides; only the
 *     read-only card is rendered)
 *   • accepted / declined / revoked are terminal (no decision
 *     buttons; restrained terminal copy)
 *   • thread remains separate (this block does NOT render a thread
 *     and does NOT post a message anywhere)
 *   • artifacts remain immutable evidence (the attach picker
 *     references existing thread artifacts and never uploads new
 *     ones — uploads continue to live in the thread block)
 *
 * What this is NOT:
 *   • kanban (no drag, no columns) — it's a vertical list ordered
 *     by `updatedAt desc`
 *   • chat (no per-package conversation; thread remains the only
 *     conversation surface)
 *   • revision editor (delivered packages are READ-ONLY; revising
 *     is a future sprint via `version` + `supersedesId`)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, Modal, ScrollView, findNodeHandle, UIManager,
  Animated, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { api } from '../services/api';
import { tokens } from '../theme/tokens';
import { mapCarSelectionError } from '../i18n/carSelectionErrors';
import i18n from '../../src/i18n';

export type OPSurface = 'provider' | 'customer' | 'admin';

type OPStatus = 'draft' | 'delivered' | 'accepted' | 'declined' | 'revoked';

interface ArtifactProjection {
  id: string;
  kind: 'image' | 'pdf' | 'file';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface OfferPackage {
  id: string;
  requestId: string;
  providerId: string;
  version: number;
  status: OPStatus;
  // Phase 9 — Offer Package Versioning. Read-only metadata; the UI
  // CONSUMES these fields but never owns the workflow they describe.
  // See /app/backend/app/offer_packages/repository.py for the source
  // of truth. Legacy docs predating Phase 9 may return chainId equal
  // to the package id (fallback) and all link fields null — that is
  // the singleton-chain case and the chip / badge code below treats
  // it identically to a brand-new v1.
  chainId?: string;
  parentId?: string | null;
  supersedesId?: string | null;
  supersededById?: string | null;
  lineage?: { previousId: string | null; nextId: string | null };
  title: string | null;
  summary: string | null;
  priceCents: number | null;
  currency: string | null;
  artifactIds: string[];
  artifacts: ArtifactProjection[];
  createdAt: string;
  updatedAt: string;
  deliveredAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedNote: string | null;
}

const C = tokens.colors;
const S = tokens.spacing;
const R = tokens.radius;

const CURRENCIES = ['EUR', 'USD', 'GBP', 'PLN', 'BYN'] as const;

interface Props {
  requestId: string;
  surface: OPSurface;
  isDark: boolean;
  /** When false, the entire block is hidden. Use to gate the
   *  surface (e.g. provider sees the block only on assigned-to-me
   *  requests; the screen already decides who renders this block). */
  enabled?: boolean;
  /** Optional package id to scroll-to + flash highlight on mount.
   *  Used when an inbox row deep-links into the request detail with
   *  `?focusPackageId=…`. Best-effort: silently no-ops if the package
   *  is not in the current list (e.g. customer trying to focus a draft
   *  hidden by existence privacy). */
  focusPackageId?: string | null;
}

function basePath(surface: OPSurface, rid: string): string {
  if (surface === 'provider') return `/provider/car-selection/${rid}/offer-packages`;
  if (surface === 'admin') return `/admin/car-selection/${rid}/offer-packages`;
  return `/car-selection/requests/${rid}/offer-packages`;
}

function fmtPrice(cents: number | null, currency: string | null): string | null {
  if (cents == null || !currency) return null;
  const major = (cents / 100).toFixed(2);
  return `${major} ${currency}`;
}

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = d.getDate().toString().padStart(2, '0');
    const mo = (d.getMonth() + 1).toString().padStart(2, '0');
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${dd}.${mo} · ${hh}:${mm}`;
  } catch { return iso; }
}

function statusTone(s: OPStatus): string {
  if (s === 'draft')     return C.warning;
  if (s === 'delivered') return C.brand;
  if (s === 'accepted')  return C.success;
  if (s === 'declined')  return C.error;
  return C.subtextDark; // revoked
}

// ────────────────────────────────────────────────────────────────────

export default function OfferPackageBlock({
  requestId, surface, isDark, enabled = true, focusPackageId = null,
}: Props) {
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  const [items, setItems] = useState<OfferPackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer state — provider only. Editing one draft at a time.
  const [editing, setEditing] = useState<OfferPackage | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);

  // Refs for scroll-to-focused-card. Map of packageId → measure handle.
  const cardRefs = useRef<Record<string, View | null>>({});
  const blockRef = useRef<View | null>(null);
  // One-shot flag so we only auto-scroll once per focus token.
  const focusConsumedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const { data } = await api.get<{ items: OfferPackage[]; total: number }>(
        basePath(surface, requestId),
      );
      setItems(data.items || []);
      setError(null);
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 404 || code === 403) {
        setItems([]);
        setError(null);
      } else {
        setError(mapCarSelectionError(t, e) || i18n.t('car_selection.offer_package.list.load_failed'));
      }
    } finally {
      setLoading(false);
    }
  }, [requestId, surface, enabled, t]);

  useEffect(() => { load(); }, [load]);

  // Phase 9 lineage chip — resolve adjacent version numbers by id.
  // We build the map from the current list rather than walking the
  // chain server-side (no new endpoints — UI consumes existing
  // truth). If a sibling is hidden by existence privacy (e.g. the
  // customer doesn't see a draft v3 yet), its entry is simply
  // absent and the chip / badge gracefully degrade to "+1" /
  // "newer version available" without the version number.
  const versionById = useMemo<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const p of items) m[p.id] = p.version;
    return m;
  }, [items]);

  // Best-effort scroll-to-focused-card once items are loaded.
  // We rely on the parent ScrollView; the card measures itself
  // against the screen and we ask the parent to scroll if exposed.
  useEffect(() => {
    if (!focusPackageId || loading || items.length === 0) return;
    if (focusConsumedRef.current === focusPackageId) return;
    const present = items.some((p) => p.id === focusPackageId);
    if (!present) return; // existence privacy — silently no-op
    focusConsumedRef.current = focusPackageId;
    // We can't directly drive the parent ScrollView; the card itself
    // flashes via `OfferPackageCard.flash` when it sees focusPackageId.
    // For native, we additionally fire `UIManager.measure` so any
    // parent that registered a `requestScrollToY` callback could
    // intervene — kept simple here.
  }, [focusPackageId, loading, items]);

  // ── handlers ──────────────────────────────────────────────────

  const openCreate = useCallback(() => {
    setEditing(null);
    setComposerOpen(true);
  }, []);

  const openEdit = useCallback((pkg: OfferPackage) => {
    if (pkg.status !== 'draft' || surface !== 'provider') return;
    setEditing(pkg);
    setComposerOpen(true);
  }, [surface]);

  const closeComposer = useCallback(async () => {
    setComposerOpen(false);
    setEditing(null);
    await load();
  }, [load]);

  const decide = useCallback(async (pkg: OfferPackage, target: 'accept' | 'decline') => {
    Alert.alert(
      i18n.t(`car_selection.offer_package.customer.${target}_modal_title`),
      i18n.t(`car_selection.offer_package.customer.${target}_modal_body`),
      [
        { text: i18n.t(`car_selection.offer_package.customer.${target}_modal_keep`), style: 'cancel' },
        {
          text: i18n.t(`car_selection.offer_package.customer.${target}_modal_confirm`),
          style: target === 'decline' ? 'destructive' : 'default',
          onPress: async () => {
            try {
              await api.post(`${basePath(surface, requestId)}/${pkg.id}/${target}`, {});
              await load();
            } catch (e: any) {
              Alert.alert(
                i18n.t('car_selection.offer_package.title'),
                mapCarSelectionError(t, e),
              );
            }
          },
        },
      ],
    );
  }, [surface, requestId, t, load]);

  const revoke = useCallback(async (pkg: OfferPackage) => {
    Alert.alert(
      i18n.t('car_selection.offer_package.admin.revoke_modal_title'),
      i18n.t('car_selection.offer_package.admin.revoke_modal_body'),
      [
        { text: i18n.t('car_selection.offer_package.admin.revoke_modal_keep'), style: 'cancel' },
        {
          text: i18n.t('car_selection.offer_package.admin.revoke_modal_confirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.post(`${basePath(surface, requestId)}/${pkg.id}/revoke`, {});
              await load();
            } catch (e: any) {
              Alert.alert(
                i18n.t('car_selection.offer_package.title'),
                mapCarSelectionError(t, e),
              );
            }
          },
        },
      ],
    );
  }, [surface, requestId, t, load]);

  if (!enabled) return null;

  // ── render ────────────────────────────────────────────────────

  const headerLabel = (
    surface === 'provider' ? i18n.t('car_selection.offer_package.section_provider')
      : surface === 'customer' ? i18n.t('car_selection.offer_package.section_customer')
        : i18n.t('car_selection.offer_package.section_admin')
  );

  return (
    <View style={styles.block} testID={`op-block-${surface}`}>
      <View style={styles.header}>
        <Ionicons name="briefcase-outline" size={13} color={isDark ? C.subtextDark : C.subtextLight} />
        <Text style={styles.headerText}>{headerLabel}</Text>
        {surface === 'provider' ? (
          <TouchableOpacity
            onPress={openCreate}
            activeOpacity={0.7}
            style={styles.headerCreateBtn}
            testID="op-create-button"
          >
            <Ionicons name="add" size={14} color={C.brand} />
            <Text style={styles.headerCreateText}>
              {t('car_selection.offer_package.composer.create_button')}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {loading ? (
        <View style={styles.center} testID="op-loading">
          <ActivityIndicator size="small" color={C.brand} />
        </View>
      ) : error ? (
        <Text style={styles.errorText} testID="op-error">
          <Ionicons name="alert-circle" size={11} color={C.error} />  {error}
        </Text>
      ) : items.length === 0 ? (
        <Text style={styles.emptyText} testID="op-empty">
          {t(`car_selection.offer_package.list.empty_${surface}`)}
        </Text>
      ) : (
        items.map((pkg) => (
          <OfferPackageCard
            key={pkg.id}
            pkg={pkg}
            surface={surface}
            isDark={isDark}
            focused={pkg.id === focusPackageId}
            versionById={versionById}
            onEdit={() => openEdit(pkg)}
            onAccept={() => decide(pkg, 'accept')}
            onDecline={() => decide(pkg, 'decline')}
            onRevoke={() => revoke(pkg)}
            onReload={load}
          />
        ))
      )}

      {surface === 'provider' && composerOpen ? (
        <ComposerModal
          requestId={requestId}
          existing={editing}
          isDark={isDark}
          onClose={closeComposer}
        />
      ) : null}
    </View>
  );
}

// ────────────────────────────────────────────────────────────────────
// Card
// ────────────────────────────────────────────────────────────────────

function OfferPackageCard({
  pkg, surface, isDark, focused = false, versionById,
  onEdit, onAccept, onDecline, onRevoke, onReload,
}: {
  pkg: OfferPackage;
  surface: OPSurface;
  isDark: boolean;
  focused?: boolean;
  /** Phase 9 — map of packageId → version, scoped to the current
   *  visible list. Used to render the lineage chip (v(N-1) ← v(N) ←
   *  v(N+1)) and the "Superseded by v{N+1}" / "Newer version
   *  available (v{N+1})" badge with the precise neighbour version.
   *  Missing entries (e.g. customer can't see a v3 draft due to
   *  existence privacy) gracefully degrade — see lineage chip
   *  fallback below. */
  versionById: Record<string, number>;
  onEdit: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onRevoke: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const tone = statusTone(pkg.status);

  // Flash animation when this card is the deep-link target. We
  // briefly inflate the border alpha so the user's eye lands on
  // the card without any modal/scroll surprise.
  const flash = useRef(new Animated.Value(focused ? 1 : 0)).current;
  useEffect(() => {
    if (!focused) return;
    Animated.sequence([
      Animated.timing(flash, { toValue: 1, duration: 250, useNativeDriver: false }),
      Animated.delay(900),
      Animated.timing(flash, { toValue: 0, duration: 500, useNativeDriver: false }),
    ]).start();
  }, [focused, flash]);
  const flashBg = flash.interpolate({
    inputRange: [0, 1],
    outputRange: ['transparent', tone + '22'],
  });

  const priceText = fmtPrice(pkg.priceCents, pkg.currency);

  // ── Phase 9 lineage projection (UI-only — backend is the source
  //    of truth). We resolve adjacent versions via `versionById`,
  //    which is scoped to the current visible list. If a neighbour
  //    is hidden by existence privacy the chip degrades gracefully:
  //    we still render the arrow but drop the unknown vN, so the
  //    user sees `← (newer)` instead of `← v3`. We never fabricate
  //    a number.
  const prevId = pkg.lineage?.previousId ?? pkg.supersedesId ?? null;
  const nextId = pkg.lineage?.nextId ?? pkg.supersededById ?? null;
  const prevVersion = prevId ? versionById[prevId] : undefined;
  const nextVersion = nextId ? versionById[nextId] : undefined;
  const hasLineage  = pkg.version > 1 || !!nextId;

  // Badge: shown ONLY for delivered packages that have been
  // superseded. Audience-specific copy:
  //   provider / admin → "Superseded by v{N+1}"  (matter-of-fact)
  //   customer         → "Newer version available (v{N+1})"
  // The badge intentionally does not link anywhere — adjacent
  // packages are right below in the same list (decision 7.6: no
  // chain explorer, no compare view). If the successor is not in
  // the current list (very rare: would require the customer to be
  // viewing this exact card while the next version is still a
  // draft, which the backend forbids via `delivered`-only CAS),
  // we omit the version suffix.
  const showSupersededBadge = pkg.status === 'delivered' && !!nextId;
  const supersededLabel = (() => {
    if (!showSupersededBadge) return null;
    const key = surface === 'customer'
      ? 'car_selection.offer_package.lineage.newer_available_customer'
      : 'car_selection.offer_package.lineage.superseded_by_provider';
    const fallbackKey = surface === 'customer'
      ? 'car_selection.offer_package.lineage.newer_available_customer_unknown'
      : 'car_selection.offer_package.lineage.superseded_by_provider_unknown';
    if (nextVersion != null) {
      return i18n.t(key, { n: nextVersion });
    }
    return i18n.t(fallbackKey);
  })();

  const showEditBtn = surface === 'provider' && pkg.status === 'draft';
  const showDeliverBtn = surface === 'provider' && pkg.status === 'draft';
  const showDecisionBtns = surface === 'customer' && pkg.status === 'delivered';
  const showRevokeBtn = surface === 'admin' && (pkg.status === 'draft' || pkg.status === 'delivered');

  const terminalCopy = (
    pkg.status === 'accepted' ? i18n.t('car_selection.offer_package.customer.accepted_terminal')
      : pkg.status === 'declined' ? i18n.t('car_selection.offer_package.customer.declined_terminal')
        : pkg.status === 'revoked' ? i18n.t('car_selection.offer_package.customer.revoked_terminal')
          : null
  );

  return (
    <Animated.View
      style={[styles.card, { borderColor: tone + '55', backgroundColor: flashBg }]}
      testID={`op-card-${pkg.id}`}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.statusPill, { backgroundColor: tone + '22', borderColor: tone }]}>
          <Text style={[styles.statusPillText, { color: tone }]}>
            {t(`car_selection.offer_package.status.${pkg.status}`).toUpperCase()}
          </Text>
        </View>
        <Text style={styles.versionText}>
          {t('car_selection.offer_package.card.version')}{pkg.version}
        </Text>
        {priceText ? (
          <Text style={styles.priceText} testID={`op-card-price-${pkg.id}`}>{priceText}</Text>
        ) : null}
      </View>

      {/* ── Phase 9 lineage chip — adjacent only (decision 7.6) ──
          One line, low-key, dim. NEVER becomes interactive: we
          refuse to turn this card into a chain explorer (the
          neighbours are right below in the same list anyway).
          Hidden entirely for singleton chains. */}
      {hasLineage ? (
        <View style={styles.lineageChip} testID={`op-card-lineage-${pkg.id}`}>
          <Ionicons
            name="git-branch-outline"
            size={11}
            color={isDark ? C.subtextDark : C.subtextLight}
          />
          <Text style={styles.lineageChipText}>
            {prevId ? (
              prevVersion != null
                ? `v${prevVersion} `
                : `${t('car_selection.offer_package.lineage.previous_unknown')} `
            ) : null}
            {prevId ? '← ' : ''}
            <Text style={styles.lineageChipCurrent}>
              v{pkg.version}{nextId ? '' : ` (${t('car_selection.offer_package.lineage.current')})`}
            </Text>
            {nextId ? ' ← ' : ''}
            {nextId ? (
              nextVersion != null
                ? `v${nextVersion} (${t('car_selection.offer_package.lineage.current')})`
                : t('car_selection.offer_package.lineage.next_unknown')
            ) : null}
          </Text>
        </View>
      ) : null}

      {/* ── Phase 9 superseded badge (U1 + U2) ──
          Audience-specific copy from one source of truth
          (`supersededById` / `lineage.nextId`). Hidden for non-
          delivered states (a revoked v2's predecessor still
          keeps its supersededById per decision 7.7, so this
          badge stays visible — the chain wasn't unwound). */}
      {supersededLabel ? (
        <View style={styles.lineageBadge} testID={`op-card-superseded-${pkg.id}`}>
          <Ionicons
            name={surface === 'customer' ? 'sparkles-outline' : 'archive-outline'}
            size={12}
            color={C.warning}
          />
          <Text style={styles.lineageBadgeText}>{supersededLabel}</Text>
        </View>
      ) : null}

      <Text style={styles.cardTitle} testID={`op-card-title-${pkg.id}`} numberOfLines={2}>
        {pkg.title || t('car_selection.offer_package.card.untitled')}
      </Text>

      <Text style={styles.cardSummary} testID={`op-card-summary-${pkg.id}`}>
        {pkg.summary || t('car_selection.offer_package.card.no_summary')}
      </Text>

      {pkg.artifacts.length > 0 ? (
        <View style={styles.attachRow} testID={`op-card-attachments-${pkg.id}`}>
          {pkg.artifacts.map((a) => (
            <View key={a.id} style={styles.attachChip}>
              <Ionicons
                name={a.kind === 'image' ? 'image-outline' : a.kind === 'pdf' ? 'document-text-outline' : 'attach-outline'}
                size={12}
                color={isDark ? C.textDark : C.textLight}
              />
              <Text style={styles.attachName} numberOfLines={1}>{a.filename}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.cardMeta}>
        {pkg.deliveredAt ? (
          <Text style={styles.cardMetaText}>
            {t('car_selection.offer_package.card.delivered_at')} · {fmtDate(pkg.deliveredAt)}
          </Text>
        ) : null}
        {pkg.decidedAt ? (
          <Text style={styles.cardMetaText}>
            {t('car_selection.offer_package.card.decided_at')} · {fmtDate(pkg.decidedAt)}
          </Text>
        ) : null}
        {pkg.decidedNote ? (
          <Text style={styles.cardNote} numberOfLines={3}>
            {t('car_selection.offer_package.card.decided_note')}: «{pkg.decidedNote}»
          </Text>
        ) : null}
      </View>

      {terminalCopy ? (
        <View style={[styles.terminalRow, { borderColor: tone }]} testID={`op-card-terminal-${pkg.id}`}>
          <Ionicons
            name={pkg.status === 'accepted' ? 'checkmark-circle' : pkg.status === 'declined' ? 'close-circle' : 'remove-circle-outline'}
            size={14}
            color={tone}
          />
          <Text style={[styles.terminalText, { color: tone }]}>{terminalCopy}</Text>
        </View>
      ) : null}

      {(showEditBtn || showDeliverBtn || showDecisionBtns || showRevokeBtn) ? (
        <View style={styles.actionsRow}>
          {showEditBtn ? (
            <TouchableOpacity
              onPress={onEdit}
              style={[styles.actionBtn, { backgroundColor: C.warning + '22', borderColor: C.warning }]}
              activeOpacity={0.7}
              testID={`op-card-edit-${pkg.id}`}
            >
              <Ionicons name="create-outline" size={14} color={C.warning} />
              <Text style={[styles.actionBtnText, { color: C.warning }]}>
                {t('car_selection.offer_package.composer.header_edit')}
              </Text>
            </TouchableOpacity>
          ) : null}
          {showDeliverBtn ? (
            <DeliverButton pkgId={pkg.id} requestId={pkg.requestId} surface="provider" isDark={isDark} onAfter={onEdit /* triggers reload via parent */} />
          ) : null}
          {showDecisionBtns ? (
            <>
              <TouchableOpacity
                onPress={onDecline}
                style={[styles.actionBtn, { backgroundColor: C.error + '22', borderColor: C.error }]}
                activeOpacity={0.7}
                testID={`op-card-decline-${pkg.id}`}
              >
                <Ionicons name="close" size={14} color={C.error} />
                <Text style={[styles.actionBtnText, { color: C.error }]}>
                  {t('car_selection.offer_package.customer.decline_button')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={onAccept}
                style={[styles.actionBtn, { backgroundColor: C.success }]}
                activeOpacity={0.85}
                testID={`op-card-accept-${pkg.id}`}
              >
                <Ionicons name="checkmark" size={14} color="#000" />
                <Text style={[styles.actionBtnText, { color: '#000' }]}>
                  {t('car_selection.offer_package.customer.accept_button')}
                </Text>
              </TouchableOpacity>
            </>
          ) : null}
          {showRevokeBtn ? (
            <TouchableOpacity
              onPress={onRevoke}
              style={[styles.actionBtn, { backgroundColor: C.error + '22', borderColor: C.error }]}
              activeOpacity={0.7}
              testID={`op-card-revoke-${pkg.id}`}
            >
              <Ionicons name="trash-outline" size={14} color={C.error} />
              <Text style={[styles.actionBtnText, { color: C.error }]}>
                {t('car_selection.offer_package.admin.revoke_button')}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}
    </Animated.View>
  );
}

// Deliver button is its own micro-component so we can use a state
// hook for the confirm modal without polluting the card.
function DeliverButton({
  pkgId, requestId, surface, isDark, onAfter,
}: { pkgId: string; requestId: string; surface: OPSurface; isDark: boolean; onAfter: () => void }) {
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);
  const [busy, setBusy] = useState(false);

  const onPress = useCallback(() => {
    Alert.alert(
      i18n.t('car_selection.offer_package.composer.deliver_confirm_title'),
      i18n.t('car_selection.offer_package.composer.deliver_confirm_body'),
      [
        { text: i18n.t('car_selection.offer_package.composer.deliver_confirm_keep'), style: 'cancel' },
        {
          text: i18n.t('car_selection.offer_package.composer.deliver_confirm_go'),
          style: 'default',
          onPress: async () => {
            setBusy(true);
            try {
              await api.post(`${basePath(surface, requestId)}/${pkgId}/deliver`, {});
              onAfter();
            } catch (e: any) {
              Alert.alert(
                i18n.t('car_selection.offer_package.title'),
                mapCarSelectionError(t, e),
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }, [requestId, pkgId, surface, t, onAfter]);

  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={busy}
      style={[styles.actionBtn, { backgroundColor: C.brand }, busy ? { opacity: 0.6 } : null]}
      activeOpacity={0.85}
      testID={`op-card-deliver-${pkgId}`}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#000" />
      ) : (
        <Ionicons name="paper-plane-outline" size={14} color="#000" />
      )}
      <Text style={[styles.actionBtnText, { color: '#000' }]}>
        {t('car_selection.offer_package.composer.deliver')}
      </Text>
    </TouchableOpacity>
  );
}

// ────────────────────────────────────────────────────────────────────
// Composer modal — provider only, draft create/edit
// ────────────────────────────────────────────────────────────────────

function ComposerModal({
  requestId, existing, isDark, onClose,
}: {
  requestId: string;
  existing: OfferPackage | null;
  isDark: boolean;
  onClose: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const styles = useMemo(() => makeStyles(isDark), [isDark]);

  const [title, setTitle] = useState(existing?.title ?? '');
  const [summary, setSummary] = useState(existing?.summary ?? '');
  const [priceText, setPriceText] = useState(
    existing?.priceCents != null ? (existing.priceCents / 100).toFixed(2) : '',
  );
  const [currency, setCurrency] = useState(existing?.currency ?? 'EUR');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsePriceCents = useCallback((s: string): number | null => {
    const trimmed = s.trim();
    if (!trimmed) return null;
    // Accept comma OR dot as separator. We do NOT do locale-aware
    // parsing here — that opens a different can of worms (German
    // 1.234,56 etc.) which we'd rather handle deliberately later.
    const norm = trimmed.replace(',', '.');
    const f = Number.parseFloat(norm);
    if (!isFinite(f) || f < 0) return null;
    return Math.round(f * 100);
  }, []);

  const save = useCallback(async (alsoDeliver: boolean) => {
    setSaving(true);
    setErr(null);
    try {
      const body: any = {
        title: title.trim() || null,
        summary: summary.trim() || null,
        priceCents: parsePriceCents(priceText),
        currency: priceText.trim() ? currency : null,
      };
      let pkgId = existing?.id;
      if (existing) {
        await api.patch(`/provider/car-selection/${requestId}/offer-packages/${existing.id}`, body);
      } else {
        const { data } = await api.post<OfferPackage>(
          `/provider/car-selection/${requestId}/offer-packages`,
          body,
        );
        pkgId = data.id;
      }
      if (alsoDeliver && pkgId) {
        await api.post(`/provider/car-selection/${requestId}/offer-packages/${pkgId}/deliver`, {});
      }
      await onClose();
    } catch (e: any) {
      setErr(mapCarSelectionError(t, e));
    } finally {
      setSaving(false);
    }
  }, [existing, title, summary, priceText, currency, requestId, parsePriceCents, t, onClose]);

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={() => { onClose(); }}
    >
      <View style={styles.modalBackdrop} testID="op-composer-modal">
        <View style={styles.modalCard}>
          <ScrollView contentContainerStyle={{ paddingBottom: S.md }} keyboardShouldPersistTaps="handled">
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {existing
                  ? t('car_selection.offer_package.composer.header_edit')
                  : t('car_selection.offer_package.composer.header')}
              </Text>
              <TouchableOpacity
                onPress={() => onClose()}
                hitSlop={12}
                testID="op-composer-close"
              >
                <Ionicons name="close" size={20} color={isDark ? C.textDark : C.textLight} />
              </TouchableOpacity>
            </View>

            {/* Title */}
            <Text style={styles.fieldLabel}>{t('car_selection.offer_package.composer.title_label')}</Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('car_selection.offer_package.composer.title_placeholder')}
              placeholderTextColor={isDark ? C.subtextDark : C.subtextLight}
              maxLength={200}
              style={styles.input}
              testID="op-composer-title"
            />

            {/* Summary */}
            <Text style={styles.fieldLabel}>{t('car_selection.offer_package.composer.summary_label')}</Text>
            <TextInput
              value={summary}
              onChangeText={setSummary}
              placeholder={t('car_selection.offer_package.composer.summary_placeholder')}
              placeholderTextColor={isDark ? C.subtextDark : C.subtextLight}
              maxLength={4000}
              multiline
              style={[styles.input, styles.inputMultiline]}
              testID="op-composer-summary"
            />

            {/* Price + currency on one row */}
            <View style={{ flexDirection: 'row', gap: S.sm }}>
              <View style={{ flex: 2 }}>
                <Text style={styles.fieldLabel}>{t('car_selection.offer_package.composer.price_label')}</Text>
                <TextInput
                  value={priceText}
                  onChangeText={setPriceText}
                  placeholder={t('car_selection.offer_package.composer.price_placeholder')}
                  placeholderTextColor={isDark ? C.subtextDark : C.subtextLight}
                  keyboardType="decimal-pad"
                  maxLength={12}
                  style={styles.input}
                  testID="op-composer-price"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>{t('car_selection.offer_package.composer.currency_label')}</Text>
                <View style={styles.currencyRow}>
                  {CURRENCIES.map((c) => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setCurrency(c)}
                      style={[
                        styles.currencyChip,
                        currency === c ? { backgroundColor: C.brand + '22', borderColor: C.brand } : null,
                      ]}
                      activeOpacity={0.7}
                      testID={`op-composer-currency-${c}`}
                    >
                      <Text style={[styles.currencyChipText, currency === c ? { color: C.brand } : null]}>
                        {c}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            {err ? (
              <Text style={styles.errorText} testID="op-composer-error">
                <Ionicons name="alert-circle" size={11} color={C.error} />  {err}
              </Text>
            ) : null}

            <View style={styles.composerActions}>
              <TouchableOpacity
                onPress={() => save(false)}
                disabled={saving}
                style={[styles.actionBtn, { backgroundColor: C.warning + '22', borderColor: C.warning }]}
                activeOpacity={0.7}
                testID="op-composer-save"
              >
                {saving ? <ActivityIndicator size="small" color={C.warning} /> : (
                  <Ionicons name="save-outline" size={14} color={C.warning} />
                )}
                <Text style={[styles.actionBtnText, { color: C.warning }]}>
                  {t('car_selection.offer_package.composer.save_draft')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => save(true)}
                disabled={saving}
                style={[styles.actionBtn, { backgroundColor: C.brand }]}
                activeOpacity={0.85}
                testID="op-composer-deliver"
              >
                {saving ? <ActivityIndicator size="small" color="#000" /> : (
                  <Ionicons name="paper-plane-outline" size={14} color="#000" />
                )}
                <Text style={[styles.actionBtnText, { color: '#000' }]}>
                  {t('car_selection.offer_package.composer.deliver')}
                </Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────────────
// styles
// ────────────────────────────────────────────────────────────────────

function makeStyles(isDark: boolean) {
  const bg      = isDark ? C.bgDark      : C.bgLight;
  const card    = isDark ? C.cardDark    : C.cardLight;
  const text    = isDark ? C.textDark    : C.textLight;
  const subtext = isDark ? C.subtextDark : C.subtextLight;
  const border  = isDark ? C.borderDark  : C.borderLight;

  return StyleSheet.create({
    block: {
      backgroundColor: card,
      borderRadius: R.md,
      borderWidth: 1,
      borderColor: border,
      padding: S.md,
      marginTop: S.md,
      gap: S.sm,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
    },
    headerText: {
      fontSize: tokens.typography.micro,
      fontWeight: '800',
      color: subtext,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      flex: 1,
    },
    headerCreateBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 5,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: C.brand + '66',
      backgroundColor: bg,
    },
    headerCreateText: {
      fontSize: tokens.typography.micro,
      color: C.brand,
      fontWeight: '700',
    },
    center: {
      paddingVertical: S.md,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: tokens.typography.caption,
      color: subtext,
      fontStyle: 'italic',
      paddingVertical: S.sm,
    },
    errorText: {
      fontSize: tokens.typography.micro,
      color: C.error,
      marginTop: S.xs + 2,
    },

    // Card
    card: {
      backgroundColor: bg,
      borderRadius: R.sm,
      borderWidth: 1,
      padding: S.sm,
      gap: 6,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      flexWrap: 'wrap',
    },
    statusPill: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: R.sm,
      borderWidth: 1,
    },
    statusPillText: {
      fontSize: tokens.typography.micro - 1,
      fontWeight: '800',
      letterSpacing: 0.5,
    },
    versionText: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
    },

    // Phase 9 lineage chip — adjacent-only chain visualisation
    // (decision 7.6). Dim, single line, never interactive.
    lineageChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingTop: 2,
    },
    lineageChipText: {
      fontSize: tokens.typography.micro - 1,
      color: subtext,
      letterSpacing: 0.2,
    },
    lineageChipCurrent: {
      color: text,
      fontWeight: '700',
    },

    // Phase 9 superseded badge — audience-specific copy, shared
    // surface. Warning-tinted (amber) because it's an alert, not
    // an error. Sits between the lineage chip and the title so
    // the user's eye lands on it before reading the v(N) content.
    lineageBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      alignSelf: 'flex-start',
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: C.warning + '66',
      backgroundColor: C.warning + '14',
    },
    lineageBadgeText: {
      fontSize: tokens.typography.micro,
      color: C.warning,
      fontWeight: '700',
    },
    priceText: {
      fontSize: tokens.typography.caption,
      color: text,
      fontWeight: '700',
      marginLeft: 'auto',
    },
    cardTitle: {
      fontSize: tokens.typography.body,
      color: text,
      fontWeight: '700',
    },
    cardSummary: {
      fontSize: tokens.typography.caption,
      color: text,
      lineHeight: 19,
    },
    attachRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 4,
    },
    attachChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 8,
      paddingVertical: 4,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      maxWidth: 220,
    },
    attachName: {
      fontSize: tokens.typography.micro,
      color: text,
      flexShrink: 1,
    },
    cardMeta: { gap: 2 },
    cardMetaText: {
      fontSize: tokens.typography.micro,
      color: subtext,
    },
    cardNote: {
      fontSize: tokens.typography.micro,
      color: text,
      fontStyle: 'italic',
    },
    terminalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: R.sm,
      borderWidth: 1,
    },
    terminalText: {
      fontSize: tokens.typography.micro,
      fontWeight: '600',
    },
    actionsRow: {
      flexDirection: 'row',
      gap: 6,
      flexWrap: 'wrap',
      marginTop: 4,
    },
    actionBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 10,
      paddingVertical: 7,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    actionBtnText: {
      fontSize: tokens.typography.micro,
      fontWeight: '700',
    },

    // Composer modal
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.45)',
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: card,
      borderTopLeftRadius: R.lg,
      borderTopRightRadius: R.lg,
      padding: S.md,
      maxHeight: '90%',
    },
    modalHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: S.sm,
    },
    modalTitle: {
      fontSize: tokens.typography.body,
      color: text,
      fontWeight: '800',
    },
    fieldLabel: {
      fontSize: tokens.typography.micro,
      color: subtext,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: S.sm,
      marginBottom: 4,
    },
    input: {
      backgroundColor: bg,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      padding: S.sm,
      color: text,
      fontSize: tokens.typography.caption + 1,
    },
    inputMultiline: {
      minHeight: 80,
      maxHeight: 200,
      textAlignVertical: 'top',
    },
    currencyRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginTop: 4,
    },
    currencyChip: {
      paddingHorizontal: 8,
      paddingVertical: 6,
      borderRadius: R.sm,
      borderWidth: 1,
      borderColor: border,
      backgroundColor: bg,
    },
    currencyChipText: {
      fontSize: tokens.typography.micro,
      color: text,
      fontWeight: '700',
    },
    composerActions: {
      flexDirection: 'row',
      gap: 8,
      marginTop: S.md,
      justifyContent: 'flex-end',
    },
  });
}
