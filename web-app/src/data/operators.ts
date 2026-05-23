// Public operator (inspector) profile data.
// Powers /operator/:slug — public trust-graph profile.

import { CASES } from './cases';

export interface OperatorExpertise {
  key: string;
  label: string;
  desc: string;
}

export interface MethodologyStep {
  n: string;
  title: string;
  desc: string;
}

export interface OperatorActivityEntry {
  ts: string;
  vehicle: string;
  city: string;
  verdict: 'pass' | 'risk' | 'reject';
  caseSlug?: string;          // links to a real /case/:id when available
}

export interface OperatorProfile {
  slug: string;
  name: string;
  initials: string;
  portrait: string;           // Unsplash CDN URL
  title: string;              // e.g. "TÜV-сертифицированный инспектор"
  cities: string[];
  homeCity: string;
  yearsExperience: number;
  inspectionsCount: number;
  ratingAvg: number;
  reviewsCount: number;
  responseMinutes: number;    // avg response time
  recommendPct: number;       // % buyers who recommend
  savedTotalEur: number;      // EUR saved for buyers across all inspections
  recentCasesCount: number;
  bio: string[];              // paragraphs
  expertise: OperatorExpertise[];
  methodology: MethodologyStep[];
  featuredCaseSlugs: string[];
  activity: OperatorActivityEntry[];
  languages: string[];
}

const COMMON_METHODOLOGY: MethodologyStep[] = [
  { n: '01', title: 'Документы и история',  desc: 'Fahrzeugbrief, сервисная книжка, EXIF фото с объявления, проверка по VIN — всё до выезда.' },
  { n: '02', title: 'Холодный запуск',      desc: 'Двигатель проверяется только с холодным стартом. Это показывает то, что прячут «прогретые» машины.' },
  { n: '03', title: 'OBD-II и логи',        desc: 'Полное чтение всех модулей, не только двигателя. Логи DSG, мехатроника, AdBlue, history-данные.' },
  { n: '04', title: 'Кузов и геометрия',    desc: 'Толщиномер по 24 точкам, осмотр сварных швов, проверка зазоров, диагностика лонжеронов.' },
  { n: '05', title: 'Дорожный тест',        desc: 'Минимум 20 км в смешанном цикле — город, автобан, торможение со 100. Запись поведения коробки.' },
  { n: '06', title: 'Отчёт и переговоры',   desc: 'PDF за 24 часа. По запросу — помощь с торгом по конкретным findings и расчётом ремонта.' },
];

export const OPERATORS: OperatorProfile[] = [
  {
    slug: 'm-kaufmann-berlin',
    name: 'Markus Kaufmann',
    initials: 'MK',
    portrait: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=900&q=80&auto=format&fit=crop',
    title: 'TÜV-сертифицированный инспектор',
    cities: ['Berlin', 'Potsdam', 'Brandenburg'],
    homeCity: 'Berlin',
    yearsExperience: 12,
    inspectionsCount: 312,
    ratingAvg: 4.9,
    reviewsCount: 287,
    responseMinutes: 38,
    recommendPct: 96,
    savedTotalEur: 184000,
    recentCasesCount: 17,
    bio: [
      'TÜV Süd · сертификат с 2014 года. До запуска практики — 8 лет ведущим механиком в дилерском сервисе BMW (Berlin Mitte).',
      'Специализация — немецкий премиум: BMW, Audi, Mercedes-Benz. За 12 лет провёл 312 предпродажных проверок. Сэкономил покупателям €184k через находки и обоснованный торг.',
    ],
    expertise: [
      { key: 'german-premium', label: 'Немецкий премиум',         desc: 'BMW, Audi, Mercedes-Benz — все поколения, моторные семейства N20/N47/N57, S55, M270/M274, EA888.' },
      { key: 'accident',       label: 'Детекция ДТП',             desc: 'Толщиномер, проверка сварных швов, лонжеронов, идентификация замены SRS-модулей.' },
      { key: 'diesel',         label: 'Дизельная диагностика',    desc: 'EGR, AdBlue, DPF, NOX-сенсоры. Чтение и анализ history-данных через ISTA/ODIS.' },
      { key: 'mileage',        label: 'Скрученный пробег',        desc: 'Перекрёстная сверка одометра, EXIF фото объявления, истории по VIN, износа узлов.' },
      { key: 'negotiation',    label: 'Переговоры с продавцом',   desc: 'По итогу осмотра — расчёт ремонта и обоснованный торг с цифрами. По запросу.' },
    ],
    methodology: COMMON_METHODOLOGY,
    featuredCaseSlugs: ['bmw-320d-2018-berlin'],
    activity: [
      { ts: '2026-04-22', vehicle: 'BMW 320d Touring 2018',         city: 'Berlin',     verdict: 'risk',   caseSlug: 'bmw-320d-2018-berlin' },
      { ts: '2026-04-18', vehicle: 'Mercedes E220d 2019',           city: 'Berlin',     verdict: 'pass'   },
      { ts: '2026-04-15', vehicle: 'BMW X3 xDrive20d 2020',         city: 'Potsdam',    verdict: 'pass'   },
      { ts: '2026-04-12', vehicle: 'Audi Q5 2.0 TFSI 2018',         city: 'Berlin',     verdict: 'risk'   },
      { ts: '2026-04-08', vehicle: 'BMW 530d 2017',                 city: 'Berlin',     verdict: 'reject' },
      { ts: '2026-04-04', vehicle: 'Mercedes GLC 220d 2019',        city: 'Berlin',     verdict: 'pass'   },
    ],
    languages: ['Deutsch', 'English', 'Русский'],
  },
  {
    slug: 't-albrecht-munich',
    name: 'Thomas Albrecht',
    initials: 'TA',
    portrait: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=900&q=80&auto=format&fit=crop',
    title: 'TÜV-сертифицированный инспектор · VAG Specialist',
    cities: ['München', 'Augsburg', 'Ingolstadt'],
    homeCity: 'München',
    yearsExperience: 9,
    inspectionsCount: 248,
    ratingAvg: 4.8,
    reviewsCount: 221,
    responseMinutes: 52,
    recommendPct: 94,
    savedTotalEur: 142000,
    recentCasesCount: 12,
    bio: [
      'TÜV Süd · мастер сервиса VAG-группы 7 лет до перехода в инспекцию. Глубокая экспертиза по дизельным двигателям 2.0 TDI и DSG-коробкам всех поколений.',
      'Работает в радиусе München / Augsburg / Ingolstadt. 248 проверок, среди клиентов — много покупателей, которые приезжают за машиной из других городов и не могут осмотреть лично.',
    ],
    expertise: [
      { key: 'vag',            label: 'VAG-группа',               desc: 'VW, Audi, Škoda, Seat, Cupra. Полное знание моторов EA189/EA288/EA888 и коробок DQ200/DQ250/DQ381.' },
      { key: 'diesel',         label: 'Дизельная диагностика',    desc: 'NOX, AdBlue, DPF, EGR, рециркуляция. Сертификат на работу со скандалом «Dieselgate».' },
      { key: 'dsg',            label: 'DSG / S-tronic',           desc: 'Чтение мехатроника, износ сцепления, температурные графики, прогноз ресурса.' },
      { key: 'remote-buyers',  label: 'Покупатели из других стран', desc: 'Проверка для клиентов, которые приедут за машиной из RU/UA/PL. Полное видеосопровождение.' },
    ],
    methodology: COMMON_METHODOLOGY,
    featuredCaseSlugs: ['audi-a4-2020-munich'],
    activity: [
      { ts: '2026-04-18', vehicle: 'Audi A4 Avant 2.0 TDI 2020',   city: 'München',    verdict: 'pass',   caseSlug: 'audi-a4-2020-munich' },
      { ts: '2026-04-14', vehicle: 'VW Passat B8 2.0 TDI 2019',    city: 'Augsburg',   verdict: 'pass'   },
      { ts: '2026-04-11', vehicle: 'Škoda Kodiaq 2.0 TDI 2018',    city: 'München',    verdict: 'risk'   },
      { ts: '2026-04-07', vehicle: 'Audi Q3 35 TDI 2020',          city: 'Ingolstadt', verdict: 'pass'   },
      { ts: '2026-04-03', vehicle: 'VW Golf 7 GTD 2017',           city: 'München',    verdict: 'risk'   },
    ],
    languages: ['Deutsch', 'English'],
  },
  {
    slug: 'j-weber-hamburg',
    name: 'Jens Weber',
    initials: 'JW',
    portrait: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=900&q=80&auto=format&fit=crop',
    title: 'TÜV-сертифицированный инспектор · Senior',
    cities: ['Hamburg', 'Bremen', 'Lübeck'],
    homeCity: 'Hamburg',
    yearsExperience: 15,
    inspectionsCount: 401,
    ratingAvg: 4.9,
    reviewsCount: 365,
    responseMinutes: 24,
    recommendPct: 97,
    savedTotalEur: 247000,
    recentCasesCount: 23,
    bio: [
      'TÜV Nord · 15 лет в осмотрах. До этого — 6 лет в страховой экспертизе кузовных повреждений (HUK-Coburg).',
      'Главная экспертиза — поиск скрученного пробега и скрытых кузовных работ. Из 401 проверки 23 были возвратами в магазин по факту обмана продавца.',
    ],
    expertise: [
      { key: 'mileage-fraud',  label: 'Скрученный пробег',        desc: 'EXIF, сервисная история, износ деталей, диагностика по VIN-сопроводительной базе.' },
      { key: 'body-damage',    label: 'Скрытые кузовные работы',  desc: '15 лет страховой экспертизы. Толщиномер, эндоскоп, проверка геометрии лонжеронов.' },
      { key: 'imports',        label: 'Импортные авто',           desc: 'Проверка происхождения и истории для серых импортов из США, Японии, ОАЭ.' },
      { key: 'classic',        label: 'Youngtimer / Classic',     desc: 'Авто 1990–2010 годов. Оценка коллекционной ценности, оригинальность кузова и салона.' },
    ],
    methodology: COMMON_METHODOLOGY,
    featuredCaseSlugs: ['vw-tiguan-2017-hamburg'],
    activity: [
      { ts: '2026-04-25', vehicle: 'VW Tiguan 2.0 TSI 2017',       city: 'Hamburg',    verdict: 'reject', caseSlug: 'vw-tiguan-2017-hamburg' },
      { ts: '2026-04-21', vehicle: 'Mercedes C220d 2019',          city: 'Bremen',     verdict: 'pass'   },
      { ts: '2026-04-17', vehicle: 'BMW 5-series 2018',            city: 'Hamburg',    verdict: 'risk'   },
      { ts: '2026-04-13', vehicle: 'Toyota RAV4 Hybrid 2020',      city: 'Hamburg',    verdict: 'pass'   },
      { ts: '2026-04-09', vehicle: 'Ford Mustang GT 2018',         city: 'Lübeck',     verdict: 'reject' },
      { ts: '2026-04-05', vehicle: 'Volvo XC60 D4 2019',           city: 'Hamburg',    verdict: 'pass'   },
    ],
    languages: ['Deutsch', 'English', 'Русский'],
  },
];

export function findOperator(slug: string): OperatorProfile | undefined {
  return OPERATORS.find(o => o.slug === slug);
}

export function operatorFeaturedCases(op: OperatorProfile) {
  return op.featuredCaseSlugs
    .map(s => CASES.find(c => c.slug === s))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
}
