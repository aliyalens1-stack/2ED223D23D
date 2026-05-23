// Shared inspection case data.
// Powers /reports (showcase) and /case/:id (detail).
// Photos: Unsplash hotlink-safe URLs.
// Real backend integration comes later — this is curated data for the
// public surface that mirrors what real inspection reports will produce.

export type Severity = 'critical' | 'warning' | 'info' | 'ok';
export type Verdict = 'pass' | 'risk' | 'reject';

export interface Finding {
  category: string;
  title: string;
  severity: Severity;
  description: string;
  photo?: string;
}

export interface TimelineStep {
  ts: string;             // ISO date string for display
  label: string;
  detail?: string;
  done: boolean;
}

export interface CaseSpecialist {
  slug: string;
  name: string;
  initials: string;
  city: string;
  ratingAvg: number;
  inspectionsCount: number;
  yearsExperience: number;
  bio: string;
}

export interface InspectionCase {
  id: string;
  slug: string;
  title: string;
  make: string;
  model: string;
  year: number;
  km: number;
  vin?: string;
  city: string;
  country: string;
  askingPrice: number;
  marketPrice: number;
  saved: number;
  verdict: Verdict;
  verdictHeadline: string;
  verdictSummary: string;
  inspectionDate: string;
  reportPages: number;
  heroImage: string;
  gallery: string[];
  findings: Finding[];
  timeline: TimelineStep[];
  specialist: CaseSpecialist;
}

const SPEC_M_KAUFMANN: CaseSpecialist = {
  slug: 'm-kaufmann-berlin',
  name: 'Markus Kaufmann',
  initials: 'MK',
  city: 'Berlin',
  ratingAvg: 4.9,
  inspectionsCount: 312,
  yearsExperience: 12,
  bio: 'TÜV-сертифицированный инспектор. Специализация: BMW, Audi, Mercedes. 12 лет в Berlin Mitte.',
};

const SPEC_T_ALBRECHT: CaseSpecialist = {
  slug: 't-albrecht-munich',
  name: 'Thomas Albrecht',
  initials: 'TA',
  city: 'München',
  ratingAvg: 4.8,
  inspectionsCount: 248,
  yearsExperience: 9,
  bio: 'Бывший мастер сервиса VAG. Специализация на дизельных двигателях и DSG.',
};

const SPEC_J_WEBER: CaseSpecialist = {
  slug: 'j-weber-hamburg',
  name: 'Jens Weber',
  initials: 'JW',
  city: 'Hamburg',
  ratingAvg: 4.9,
  inspectionsCount: 401,
  yearsExperience: 15,
  bio: 'Старший инспектор. 15 лет опыта. Специализация: проверка скрученного пробега и кузовных работ.',
};

export const CASES: InspectionCase[] = [
  {
    id: 'bmw-320d-2018-berlin',
    slug: 'bmw-320d-2018-berlin',
    title: 'BMW 320d Touring 2018',
    make: 'BMW',
    model: '320d Touring',
    year: 2018,
    km: 124000,
    vin: 'WBA8E51070K******',
    city: 'Berlin',
    country: 'Deutschland',
    askingPrice: 18900,
    marketPrice: 17000,
    saved: 1900,
    verdict: 'risk',
    verdictHeadline: 'Покупать с торгом — €1 900',
    verdictSummary: 'Машина живая, но турбина уходит в риск через 15–25 тыс. км. Ремонт ~€1 200. Кузовной элемент перекрашен — не критично, но повод для торга.',
    inspectionDate: '2026-04-22',
    reportPages: 18,
    heroImage: 'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=1600&q=80&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=1200&q=80&auto=format&fit=crop',
    ],
    findings: [
      { category: 'Двигатель',  title: 'Утечка масла на турбине',          severity: 'warning',  description: 'Масло на корпусе турбокомпрессора. На сегодня не критично, но по моторесурсу — замена в ближайшие 15–25 тыс. км. Ориентировочно €1 200 в свободном сервисе.' },
      { category: 'Кузов',      title: 'Перекрашен правый порог',          severity: 'info',     description: 'Толщиномер показал 280 мкм против 110 мкм на остальных панелях. Покраска аккуратная, без следов рихтовки. Геометрия кузова в норме.' },
      { category: 'Электрика',  title: 'Без замечаний',                    severity: 'ok',       description: 'OBD-II ошибок нет. Все цепи рабочие. Аккумулятор в норме (вольтаж 12.6V в покое, 14.2V на холостых).' },
      { category: 'Ходовая',    title: 'Тормозные колодки 40%',            severity: 'info',     description: 'Колодки передние 40%, задние 55%. Замена через 10–15 тыс. км. Диски в пределах нормы.' },
      { category: 'Документы',  title: 'TÜV до 2027, 2 владельца',         severity: 'ok',       description: 'Fahrzeugbrief чистый. История у официального дилера до 2023. Без признаков скрученного пробега (по EXIF фото и сервисной книжке).' },
      { category: 'Салон',      title: 'Износ салона по пробегу',          severity: 'ok',       description: 'Кожа руля и сиденья водителя — естественный износ. Обивка целая. Электроника, мультимедиа, климат — рабочие.' },
    ],
    timeline: [
      { ts: '2026-04-20 14:32', label: 'Заявка получена',           detail: 'Ссылка mobile.de — BMW 320d Touring 2018, Berlin',         done: true },
      { ts: '2026-04-20 15:08', label: 'Назначен инспектор',        detail: 'Markus Kaufmann · 12 лет опыта · Berlin Mitte',           done: true },
      { ts: '2026-04-22 10:00', label: 'Осмотр на месте',           detail: 'Длительность 2 ч 15 мин · 47 фото · 6 мин видео',          done: true },
      { ts: '2026-04-22 16:40', label: 'Отчёт сформирован',         detail: 'PDF · 18 страниц · 6 категорий · вердикт RISK',           done: true },
      { ts: '2026-04-23 09:15', label: 'Передан клиенту',           detail: 'Email + кабинет. Решение клиента — торг −€1 900',         done: true },
    ],
    specialist: SPEC_M_KAUFMANN,
  },
  {
    id: 'audi-a4-2020-munich',
    slug: 'audi-a4-2020-munich',
    title: 'Audi A4 Avant 2.0 TDI 2020',
    make: 'Audi',
    model: 'A4 Avant 2.0 TDI',
    year: 2020,
    km: 78000,
    city: 'München',
    country: 'Deutschland',
    askingPrice: 27500,
    marketPrice: 27500,
    saved: 0,
    verdict: 'pass',
    verdictHeadline: 'Брать без торга — рынок',
    verdictSummary: 'Один владелец, история у дилера, без следов ДТП и кузовных работ. TÜV до 2027. Цена соответствует рынку. Брать.',
    inspectionDate: '2026-04-18',
    reportPages: 22,
    heroImage: 'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1600&q=80&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1614026480209-a1d2cb37c20e?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1200&q=80&auto=format&fit=crop',
    ],
    findings: [
      { category: 'Двигатель',  title: 'Без замечаний',                    severity: 'ok',       description: '2.0 TDI, 190 л.с. Запуск ровный, шумов нет. OBD без ошибок. Масло свежее, утечек нет.' },
      { category: 'Кузов',      title: 'Без признаков ДТП',                severity: 'ok',       description: 'Толщиномер по всем панелям 95–115 мкм — заводской слой. Зазоры ровные. Геометрия в норме.' },
      { category: 'Документы',  title: '1 владелец, дилерская история',    severity: 'ok',       description: 'Fahrzeugbrief, сервисная книжка, чеки. Все ТО у Audi. TÜV до 03.2027.' },
      { category: 'Ходовая',    title: 'Сервис по плану',                  severity: 'ok',       description: 'Колодки передние 70%, задние 80%. Сцепление автоматическое (S-tronic) — без замечаний.' },
      { category: 'Салон',      title: 'Состояние очень хорошее',          severity: 'ok',       description: 'Кожа без потёртостей. Электроника, climatronic, MMI — всё рабочее. Без следов курения.' },
    ],
    timeline: [
      { ts: '2026-04-16 11:20', label: 'Заявка получена',           detail: 'Ссылка autoscout24',                                       done: true },
      { ts: '2026-04-16 12:05', label: 'Назначен инспектор',        detail: 'Thomas Albrecht · специализация VAG · München',           done: true },
      { ts: '2026-04-18 09:30', label: 'Осмотр на месте',           detail: 'Длительность 2 ч · 52 фото · 4 мин видео',                done: true },
      { ts: '2026-04-18 14:50', label: 'Отчёт сформирован',         detail: 'PDF · 22 страницы · вердикт PASS',                        done: true },
      { ts: '2026-04-18 18:00', label: 'Передан клиенту',           detail: 'Сделка состоялась через 3 дня по asking price',           done: true },
    ],
    specialist: SPEC_T_ALBRECHT,
  },
  {
    id: 'vw-tiguan-2017-hamburg',
    slug: 'vw-tiguan-2017-hamburg',
    title: 'VW Tiguan 2.0 TSI 2017',
    make: 'VW',
    model: 'Tiguan 2.0 TSI',
    year: 2017,
    km: 142000,
    city: 'Hamburg',
    country: 'Deutschland',
    askingPrice: 16400,
    marketPrice: 12200,
    saved: 4200,
    verdict: 'reject',
    verdictHeadline: 'Не брать — скрученный пробег',
    verdictSummary: 'По EXIF фото и износу салона реальный пробег ~190 тыс. км вместо заявленных 142 тыс. DSG требует ремонта в ближайшее время. 4 окрашенных элемента — следы серьёзного удара. Откажитесь от сделки.',
    inspectionDate: '2026-04-25',
    reportPages: 24,
    heroImage: 'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=1600&q=80&auto=format&fit=crop',
    gallery: [
      'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1200&q=80&auto=format&fit=crop',
      'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=1200&q=80&auto=format&fit=crop',
    ],
    findings: [
      { category: 'Документы',  title: 'Скрученный пробег ~48 тыс. км',    severity: 'critical', description: 'Сервисная история обрывается на 2022 году с пробегом 168 тыс. км. На щитке — 142 тыс. Реальный пробег по EXIF фото и износу деталей — около 190 тыс.' },
      { category: 'Трансмиссия', title: 'Проблема с DSG',                 severity: 'critical', description: 'Рывки при переключении 1→2 на холодную. Логи мехатроника показывают повышенные температуры. Замена/ремонт мехатроника — €1 800–2 400.' },
      { category: 'Кузов',      title: '4 окрашенных элемента',            severity: 'warning',  description: 'Передний бампер, переднее правое крыло, передняя правая дверь, капот. Толщиномер 320–410 мкм. Геометрия кузова имеет отклонения. Признаки лобового удара средней силы.' },
      { category: 'Двигатель',  title: 'Расход масла',                     severity: 'warning',  description: '2.0 TSI EA888 — известная проблема залегания колец. По косвенным признакам (нагар на свечах, прозрачный дымок при перегазовке) — расход выше нормы.' },
      { category: 'Салон',      title: 'Износ не соответствует пробегу',   severity: 'warning',  description: 'Руль, сиденье водителя, накладки педалей — износ соответствует пробегу 180+ тыс. км.' },
    ],
    timeline: [
      { ts: '2026-04-23 16:10', label: 'Заявка получена',           detail: 'Ссылка mobile.de',                                         done: true },
      { ts: '2026-04-23 17:25', label: 'Назначен инспектор',        detail: 'Jens Weber · специализация по скруткам · Hamburg',        done: true },
      { ts: '2026-04-25 11:00', label: 'Осмотр на месте',           detail: 'Длительность 3 ч · 71 фото · 12 мин видео · диагностика DSG', done: true },
      { ts: '2026-04-25 19:40', label: 'Отчёт сформирован',         detail: 'PDF · 24 страницы · вердикт REJECT',                      done: true },
      { ts: '2026-04-26 08:00', label: 'Передан клиенту',           detail: 'Клиент отказался от сделки. Сэкономлено €4 200',          done: true },
    ],
    specialist: SPEC_J_WEBER,
  },
];

// Inventory depth: extras for /reports discovery universe.
import { EXTRA_CASES } from './cases-extra';
CASES.push(...EXTRA_CASES);

export function findCase(slug: string): InspectionCase | undefined {
  return CASES.find(c => c.slug === slug || c.id === slug);
}

export const VERDICT_META = {
  pass:   { label: 'Пройдено',  short: 'PASS',   accent: '#10b981', bg: '#ecfdf5', ring: '#a7f3d0', text: '#065f46' },
  risk:   { label: 'С рисками', short: 'RISK',   accent: '#f59e0b', bg: '#fffbeb', ring: '#fcd34d', text: '#92400e' },
  reject: { label: 'Не брать',  short: 'REJECT', accent: '#ef4444', bg: '#fef2f2', ring: '#fca5a5', text: '#991b1b' },
} as const;

export const SEVERITY_META = {
  critical: { label: 'Критично',    accent: '#ef4444', bg: 'bg-rose-50',    text: 'text-rose-700',    ring: 'ring-rose-200' },
  warning:  { label: 'Внимание',    accent: '#f59e0b', bg: 'bg-amber-50',   text: 'text-amber-800',   ring: 'ring-amber-200' },
  info:     { label: 'К сведению',  accent: '#3b82f6', bg: 'bg-sky-50',     text: 'text-sky-700',     ring: 'ring-sky-200' },
  ok:       { label: 'В норме',     accent: '#10b981', bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200' },
} as const;
