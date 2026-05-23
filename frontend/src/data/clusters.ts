/**
 * Cluster → Services taxonomy (UX-2A — rewritten 2026-05-13).
 *
 * RULES of this taxonomy (no overlaps, no shared entries):
 *   • inspection — проверка авто ПЕРЕД покупкой (pre-purchase only)
 *   • selection  — поиск/подбор авто на рынке (mobile.de scout work)
 *   • delivery   — пригон / доставка / EU import (logistics across borders)
 *   • repair     — ремонт + диагностика после покупки + эвакуатор + помощь
 *
 * Each cluster's services route to a distinct flow:
 *   inspection → /auto-request/create?type=inspection
 *   selection  → /selection/request?preset=<key>
 *   delivery   → /delivery/request?preset=<key>
 *   repair     → /request/create?serviceKey=<backend-key>
 *
 * The `requestKey` field (when present) maps to backend `SERVICE_MAP` keys in
 * `app/marketplace/requests.py`. Frontend uses it as the `serviceKey` payload
 * for POST /api/requests. When absent (selection/delivery free-form flows),
 * the per-cluster screen provides its own form.
 */
import type { ComponentProps } from 'react';
import type { Ionicons } from '@expo/vector-icons';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export type ClusterId = 'inspection' | 'selection' | 'delivery' | 'repair';

export interface ClusterService {
  /** i18n key under `home.svc.*`. */
  key: string;
  icon: IoniconName;
  /** semantic color hint */
  tone: 'brand' | 'success' | 'warning';
  /** Backend SERVICE_MAP key — when present, frontend POSTs to /api/requests with this key. */
  requestKey?: string;
}

export interface ClusterDef {
  id: ClusterId;
  titleKey: string;
  subKey: string;
  icon: IoniconName;
  tone: 'brand' | 'success' | 'warning';
  /** Route prefix for this cluster's request flow. */
  route: string;
  services: ClusterService[];
}

export const CLUSTERS: Record<ClusterId, ClusterDef> = {
  inspection: {
    id: 'inspection',
    titleKey: 'home.clusters.inspection_title',
    subKey: 'home.clusters.inspection_sub',
    icon: 'shield-checkmark',
    tone: 'success',
    route: '/auto-request/create?type=inspection',
    services: [
      { key: 'pre_purchase_inspection', icon: 'shield-checkmark-outline', tone: 'success', requestKey: 'pre_purchase' },
      { key: 'vin_check',               icon: 'document-text-outline',    tone: 'brand' },
      { key: 'accident_check',          icon: 'warning-outline',          tone: 'warning' },
      { key: 'remote_inspection',       icon: 'videocam-outline',         tone: 'brand' },
    ],
  },
  selection: {
    id: 'selection',
    titleKey: 'home.clusters.selection_title',
    subKey: 'home.clusters.selection_sub',
    icon: 'sparkles',
    tone: 'brand',
    route: '/selection/request',
    services: [
      { key: 'budget_match',     icon: 'wallet-outline',     tone: 'success' },
      { key: 'market_scout',     icon: 'search-outline',     tone: 'brand' },
      { key: 'negotiation_help', icon: 'chatbubbles-outline',tone: 'brand' },
      { key: 'mobile_de_link',   icon: 'link-outline',       tone: 'brand' },
    ],
  },
  delivery: {
    id: 'delivery',
    titleKey: 'home.clusters.delivery_title',
    subKey: 'home.clusters.delivery_sub',
    icon: 'rocket',
    tone: 'warning',
    route: '/delivery/request',
    services: [
      { key: 'eu_import',     icon: 'globe-outline',  tone: 'warning' },
      { key: 'car_pickup',    icon: 'rocket-outline', tone: 'warning' },
      { key: 'customs_help',  icon: 'document-outline',tone: 'brand' },
      { key: 'door_to_door',  icon: 'home-outline',   tone: 'success' },
    ],
  },
  repair: {
    id: 'repair',
    titleKey: 'home.clusters.repair_title',
    subKey: 'home.clusters.repair_sub',
    icon: 'construct',
    tone: 'brand',
    route: '/repair/request',
    services: [
      { key: 'diagnostics',  icon: 'search-outline',       tone: 'brand',   requestKey: 'diagnostics' },
      { key: 'oil_change',   icon: 'water-outline',        tone: 'warning', requestKey: 'oil_change' },
      { key: 'brakes',       icon: 'stop-circle-outline',  tone: 'brand',   requestKey: 'brakes' },
      { key: 'engine',       icon: 'flame-outline',        tone: 'brand',   requestKey: 'engine' },
      { key: 'battery',      icon: 'battery-charging-outline', tone: 'brand', requestKey: 'battery' },
      { key: 'tires',        icon: 'ellipse-outline',      tone: 'success', requestKey: 'tires' },
      { key: 'towing',       icon: 'cube-outline',         tone: 'warning', requestKey: 'towing' },
      { key: 'on_site_help', icon: 'navigate-outline',     tone: 'success' },
    ],
  },
};

export const CLUSTER_ORDER: ClusterId[] = ['inspection', 'selection', 'delivery', 'repair'];

/**
 * Resolve a tap on a cluster's service tile to the destination route.
 * Returns an expo-router `Href` (string + params). Selection/delivery flows
 * carry an optional `preset` so the screen can pre-fill its dropdown.
 */
export function resolveServiceRoute(
  clusterId: ClusterId,
  service: ClusterService,
): { pathname: string; params?: Record<string, string> } {
  const cluster = CLUSTERS[clusterId];
  if (clusterId === 'inspection') {
    return { pathname: '/auto-request/create', params: { type: 'inspection' } };
  }
  if (clusterId === 'repair') {
    return {
      pathname: '/repair/request',
      params: service.requestKey ? { preset: service.requestKey } : undefined,
    };
  }
  // selection / delivery — free-form flows keyed by preset
  return {
    pathname: cluster.route.split('?')[0],
    params: { preset: service.key },
  };
}
