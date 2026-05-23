// Vehicle memory system data.
// Powers /vehicle/:id — the central living object of the platform.
// A vehicle has lineage: events, inspections, documents, mileage history,
// owners, operators, market value trajectory, model-level intelligence.
import { CASES } from './cases';

export type EventKind =
  | 'imported'        // машина появилась в Германии
  | 'purchased'       // куплена текущим владельцем
  | 'inspected'       // прошла проверку платформой → ссылка на case
  | 'service'         // сервисное событие
  | 'mileage_anomaly' // обнаружено отклонение пробега
  | 'document'        // TÜV, страховка, регистрация
  | 'repair'          // ремонт
  | 'reminder';       // upcoming событие в будущем

export interface VehicleEvent {
  date: string;          // ISO YYYY-MM-DD
  kind: EventKind;
  label: string;
  detail?: string;
  caseSlug?: string;     // links to /case/:id
  operatorSlug?: string; // links to /operator/:slug
  km?: number;
  cost?: number;
  upcoming?: boolean;    // for future reminders
}

export interface VehicleDocument {
  kind: 'tuv' | 'insurance' | 'registration' | 'service_plan';
  label: string;
  validUntil: string;    // ISO YYYY-MM-DD
  status: 'active' | 'expiring' | 'expired';
}

export interface ComparativeIntel {
  modelKey: string;          // e.g. "BMW 320d Touring"
  sampleSize: number;        // how many of this model on platform
  percentPass: number;
  percentRisk: number;
  percentReject: number;
  avgSavedEur: number;
  commonFindings: string[];
}

export interface KmPoint {
  date: string;
  km: number;
  source: 'odometer' | 'service' | 'inspection';
}

export interface VehicleMemory {
  slug: string;
  vin: string;             // anonymised
  plate: string;
  make: string;
  model: string;
  generation?: string;
  year: number;
  body: string;
  color: string;
  homeCity: string;
  country: string;
  heroImage: string;
  gallery: string[];

  // ownership
  ownerStartDate: string;  // ISO
  ownerLabel: string;      // first owner / second owner / dealer
  currentKm: number;
  purchasePrice: number;
  marketAtPurchase: number;
  marketNow: number;

  // lineage
  timeline: VehicleEvent[];
  kmHistory: KmPoint[];
  documents: VehicleDocument[];
  linkedCaseSlugs: string[];
  operatorSlugs: string[];

  // intelligence
  intel: ComparativeIntel;
}

// ── BUILD ────────────────────────────────────────────────────────────

export const VEHICLES: VehicleMemory[] = [
  {
    slug: 'bmw-x3-xdrive30d-2019-berlin',
    vin: 'WBAEX31070K******',
    plate: 'B · AX 3047',
    make: 'BMW',
    model: 'X3 xDrive30d',
    generation: 'G01',
    year: 2019,
    body: 'SUV',
    color: 'Carbonschwarz Metallic',
    homeCity: 'Berlin',
    country: 'Deutschland',
    heroImage: 'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1800&q=85&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1200&q=80&auto=format&fit=crop',
    ],
    ownerStartDate: '2024-12-08',
    ownerLabel: 'Текущий владелец · 2-й',
    currentKm: 87400,
    purchasePrice: 31900,
    marketAtPurchase: 32500,
    marketNow: 30800,
    timeline: [
      { date: '2026-06-15', kind: 'reminder',         label: 'Скоро TÜV',                        detail: 'Запланируйте проверку до 12.07.2026', upcoming: true },
      { date: '2025-11-22', kind: 'inspected',        label: 'Контрольный осмотр',               detail: 'PDF · 14 страниц · вердикт PASS · мелкие замечания по тормозам', operatorSlug: 'm-kaufmann-berlin', km: 84100 },
      { date: '2025-09-04', kind: 'service',          label: 'Замена тормозных дисков',          detail: 'Передняя ось · BMW Service Berlin Mitte', cost: 680, km: 81200 },
      { date: '2025-04-18', kind: 'service',          label: 'ТО · 70 тыс. км',                  detail: 'Масло, фильтры, тормозная жидкость · BMW Service', cost: 420, km: 75100 },
      { date: '2024-12-08', kind: 'purchased',        label: 'Куплена текущим владельцем',       detail: 'После проверки на платформе. Сторговано €1 200', km: 71400 },
      { date: '2024-12-02', kind: 'inspected',        label: 'Pre-purchase проверка',            detail: 'PDF · 18 страниц · вердикт RISK · перекрашен правый порог', caseSlug: 'bmw-x3-2024-prepurchase', operatorSlug: 'm-kaufmann-berlin', km: 71200 },
      { date: '2024-08-12', kind: 'document',         label: 'TÜV пройден',                       detail: 'Действителен до 07.2026' },
      { date: '2022-03-15', kind: 'imported',         label: 'Импорт из Audi-Stuttgart',         detail: '1-й владелец → дилерская сертификация' },
    ],
    kmHistory: [
      { date: '2022-03-15', km: 12400,  source: 'service' },
      { date: '2024-08-12', km: 68900,  source: 'service' },
      { date: '2024-12-02', km: 71200,  source: 'inspection' },
      { date: '2025-04-18', km: 75100,  source: 'service' },
      { date: '2025-09-04', km: 81200,  source: 'service' },
      { date: '2025-11-22', km: 84100,  source: 'inspection' },
      { date: '2026-04-30', km: 87400,  source: 'odometer' },
    ],
    documents: [
      { kind: 'tuv',          label: 'TÜV / Hauptuntersuchung', validUntil: '2026-07-12', status: 'expiring' },
      { kind: 'insurance',    label: 'Allianz Vollkasko',        validUntil: '2026-12-31', status: 'active' },
      { kind: 'registration', label: 'Fahrzeugbrief',            validUntil: '2099-01-01', status: 'active' },
      { kind: 'service_plan', label: 'Сервисный план BMW',       validUntil: '2027-03-15', status: 'active' },
    ],
    linkedCaseSlugs: ['bmw-x3-2024-prepurchase'],
    operatorSlugs: ['m-kaufmann-berlin'],
    intel: {
      modelKey: 'BMW X3 (G01)',
      sampleSize: 47,
      percentPass: 64,
      percentRisk: 28,
      percentReject: 8,
      avgSavedEur: 1380,
      commonFindings: [
        'Утечка масла на турбине N57 — 22% случаев',
        'Износ направляющих клапанов — 14% случаев',
        'Перекрас порога / крыла — 19% случаев',
      ],
    },
  },

  {
    slug: 'vw-touareg-v6-tdi-2018-munich',
    vin: 'WVGZZZ7P0J******',
    plate: 'M · VW 8819',
    make: 'VW',
    model: 'Touareg V6 TDI',
    generation: 'III (CR)',
    year: 2018,
    body: 'SUV',
    color: 'Pure White',
    homeCity: 'München',
    country: 'Deutschland',
    heroImage: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1800&q=85&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=1200&q=80&auto=format&fit=crop',
    ],
    ownerStartDate: '2023-12-22',
    ownerLabel: 'Текущий владелец · 3-й',
    currentKm: 154200,
    purchasePrice: 28400,
    marketAtPurchase: 30900,
    marketNow: 26100,
    timeline: [
      { date: '2026-09-08', kind: 'reminder',         label: 'TÜV до 09.2026',                   detail: 'Контроль через 4 месяца', upcoming: true },
      { date: '2025-12-14', kind: 'inspected',        label: 'Plановый осмотр',                  detail: 'PDF · 16 страниц · вердикт PASS · DSG в норме', operatorSlug: 't-albrecht-munich', km: 142800 },
      { date: '2025-07-09', kind: 'mileage_anomaly',  label: 'Аномалия пробега',                 detail: 'За 14 дней пробег вырос на 4 800 км. Проверено — длительная поездка по ЕС.', km: 132500 },
      { date: '2025-03-21', kind: 'service',          label: 'Замена цепи ГРМ',                  detail: 'Профилактически · €1 850 · VW Service Munich', cost: 1850, km: 124600 },
      { date: '2024-08-04', kind: 'inspected',        label: 'Контрольная проверка',             detail: 'Вердикт PASS · AdBlue-сенсор предел', operatorSlug: 't-albrecht-munich', km: 110900 },
      { date: '2023-12-22', kind: 'purchased',        label: 'Куплена текущим владельцем',       detail: 'После проверки. Pass без торга.', km: 96100 },
      { date: '2023-12-08', kind: 'inspected',        label: 'Pre-purchase проверка',            detail: 'Вердикт PASS · образцовый сервис у дилера', operatorSlug: 'j-weber-hamburg', km: 95800 },
      { date: '2018-04-12', kind: 'imported',         label: 'Импорт от 1-го владельца',         detail: 'VW Zentrum München' },
    ],
    kmHistory: [
      { date: '2018-04-12', km: 11200,  source: 'service' },
      { date: '2023-12-08', km: 95800,  source: 'inspection' },
      { date: '2024-08-04', km: 110900, source: 'inspection' },
      { date: '2025-03-21', km: 124600, source: 'service' },
      { date: '2025-07-09', km: 132500, source: 'odometer' },
      { date: '2025-12-14', km: 142800, source: 'inspection' },
      { date: '2026-04-30', km: 154200, source: 'odometer' },
    ],
    documents: [
      { kind: 'tuv',          label: 'TÜV / Hauptuntersuchung', validUntil: '2026-09-08', status: 'active' },
      { kind: 'insurance',    label: 'HUK24 Teilkasko',          validUntil: '2026-08-31', status: 'active' },
      { kind: 'registration', label: 'Fahrzeugbrief',            validUntil: '2099-01-01', status: 'active' },
      { kind: 'service_plan', label: 'Сервисный план VW',        validUntil: '2027-04-15', status: 'active' },
    ],
    linkedCaseSlugs: ['vw-touareg-2019-frankfurt'],
    operatorSlugs: ['t-albrecht-munich', 'j-weber-hamburg'],
    intel: {
      modelKey: 'VW Touareg III V6 TDI',
      sampleSize: 31,
      percentPass: 71,
      percentRisk: 23,
      percentReject: 6,
      avgSavedEur: 1640,
      commonFindings: [
        'AdBlue-сенсор требует замены — 38% случаев',
        'DSG/коробка-автомат шумы — 12% случаев',
        'Износ пневмоподвески — 17% случаев',
      ],
    },
  },

  {
    slug: 'audi-a6-avant-2020-frankfurt',
    vin: 'WAUZZZ4G0L******',
    plate: 'F · AU 9244',
    make: 'Audi',
    model: 'A6 Avant 45 TDI',
    generation: 'C8',
    year: 2020,
    body: 'Estate',
    color: 'Daytonagrau Perleffekt',
    homeCity: 'Frankfurt',
    country: 'Deutschland',
    heroImage: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1800&q=85&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1614026480209-a1d2cb37c20e?w=1200&q=80&auto=format&fit=crop',
    ],
    ownerStartDate: '2026-01-04',
    ownerLabel: 'Текущий владелец · 1-й после дилера',
    currentKm: 41800,
    purchasePrice: 37500,
    marketAtPurchase: 37500,
    marketNow: 36200,
    timeline: [
      { date: '2026-12-15', kind: 'reminder',         label: 'Первое сервисное ТО',              detail: 'Через ~7 месяцев', upcoming: true },
      { date: '2026-08-04', kind: 'reminder',         label: 'TÜV',                              detail: 'Действителен до 08.2027', upcoming: true },
      { date: '2026-01-04', kind: 'purchased',        label: 'Куплена текущим владельцем',       detail: 'Образцовая проверка. Цена рынка.', km: 38400 },
      { date: '2025-12-22', kind: 'inspected',        label: 'Pre-purchase проверка',            detail: 'PDF · 22 страницы · вердикт PASS', caseSlug: 'audi-a4-2020-munich', operatorSlug: 't-albrecht-munich', km: 38200 },
      { date: '2020-11-08', kind: 'imported',         label: 'Импорт от Audi Frankfurt',         detail: 'Демо-кар у дилера до 2025' },
    ],
    kmHistory: [
      { date: '2020-11-08', km: 0,      source: 'service' },
      { date: '2025-12-22', km: 38200,  source: 'inspection' },
      { date: '2026-01-04', km: 38400,  source: 'odometer' },
      { date: '2026-04-30', km: 41800,  source: 'odometer' },
    ],
    documents: [
      { kind: 'tuv',          label: 'TÜV / Hauptuntersuchung', validUntil: '2027-08-04', status: 'active' },
      { kind: 'insurance',    label: 'AXA Vollkasko',            validUntil: '2027-01-04', status: 'active' },
      { kind: 'registration', label: 'Fahrzeugbrief',            validUntil: '2099-01-01', status: 'active' },
      { kind: 'service_plan', label: 'Audi Service Plan',        validUntil: '2028-11-08', status: 'active' },
    ],
    linkedCaseSlugs: ['audi-a4-2020-munich'],
    operatorSlugs: ['t-albrecht-munich'],
    intel: {
      modelKey: 'Audi A6 Avant (C8)',
      sampleSize: 28,
      percentPass: 79,
      percentRisk: 18,
      percentReject: 3,
      avgSavedEur: 980,
      commonFindings: [
        'AdBlue-сенсор предел — 24% случаев',
        'Износ DPF — 11% случаев',
        'Посторонние шумы S-tronic — 7% случаев',
      ],
    },
  },
];

export function findVehicle(slug: string): VehicleMemory | undefined {
  return VEHICLES.find(v => v.slug === slug);
}

export function vehicleLinkedCases(v: VehicleMemory) {
  return v.linkedCaseSlugs
    .map(s => CASES.find(c => c.slug === s))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
}

export const EVENT_META: Record<EventKind, { label: string; accent: string; bg: string; text: string }> = {
  imported:        { label: 'Импорт',           accent: '#64748b', bg: 'bg-slate-50',   text: 'text-slate-700' },
  purchased:       { label: 'Покупка',          accent: '#0ea5e9', bg: 'bg-sky-50',     text: 'text-sky-700' },
  inspected:       { label: 'Проверка',         accent: '#fbbf24', bg: 'bg-amber-50',   text: 'text-amber-800' },
  service:         { label: 'Сервис',           accent: '#10b981', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  mileage_anomaly: { label: 'Аномалия пробега', accent: '#f97316', bg: 'bg-orange-50',  text: 'text-orange-700' },
  document:        { label: 'Документ',         accent: '#8b5cf6', bg: 'bg-violet-50',  text: 'text-violet-700' },
  repair:          { label: 'Ремонт',           accent: '#ef4444', bg: 'bg-rose-50',    text: 'text-rose-700' },
  reminder:        { label: 'Напоминание',      accent: '#737373', bg: 'bg-neutral-50', text: 'text-neutral-700' },
};
