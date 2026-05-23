/**
 * Shared partner-kind catalogue used by the map, partner-register and admin
 * surfaces. Single source of truth for colours, emoji and labels.
 */

export type PartnerKind = 'workshop' | 'inspector' | 'dealer' | 'carwash';

export interface PartnerKindMeta {
  kind: PartnerKind;
  emoji: string;
  label: string;
  color: string;
  sub: string;
}

export const PARTNER_KINDS: PartnerKindMeta[] = [
  { kind: 'workshop',  emoji: '🔧', label: 'СТО',         color: '#f5c518', sub: 'Сервис, ремонт, диагностика' },
  { kind: 'inspector', emoji: '🔍', label: 'Подборщики', color: '#3b82f6', sub: 'Выездной осмотр авто' },
  { kind: 'dealer',    emoji: '🏢', label: 'Салоны',      color: '#8b5cf6', sub: 'Дилер новых / б/у авто' },
  { kind: 'carwash',   emoji: '🚿', label: 'Мойки',       color: '#0ea5e9', sub: 'Мойка кузова и салона' },
];

export const PARTNER_KIND_MAP: Record<PartnerKind, PartnerKindMeta> =
  PARTNER_KINDS.reduce((acc, m) => ({ ...acc, [m.kind]: m }), {} as any);

/** 7 operating countries — used for region bounds + country labels on the map. */
export const REGION_BOUNDS_LATLNG: [[number, number], [number, number]] = [[44.0, 5.0], [60.5, 41.0]];

export const REGION_COUNTRIES = [
  { iso3: 'DEU', center: [51.16, 10.45] as [number, number], label: 'Германия' },
  { iso3: 'POL', center: [51.92, 19.13] as [number, number], label: 'Польша' },
  { iso3: 'LTU', center: [55.17, 23.88] as [number, number], label: 'Литва' },
  { iso3: 'LVA', center: [56.88, 24.60] as [number, number], label: 'Латвия' },
  { iso3: 'EST', center: [58.60, 25.01] as [number, number], label: 'Эстония' },
  { iso3: 'BLR', center: [53.71, 27.95] as [number, number], label: 'Беларусь' },
  { iso3: 'UKR', center: [48.38, 31.17] as [number, number], label: 'Украина' },
];

export const NAME_TO_ISO3: Record<string, string> = {
  Germany: 'DEU', Poland: 'POL', Lithuania: 'LTU', Latvia: 'LVA',
  Estonia: 'EST', Belarus: 'BLR', Ukraine: 'UKR',
};
