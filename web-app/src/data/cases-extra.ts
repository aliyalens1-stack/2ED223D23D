// Extended inventory for /reports discovery universe.
// Compact case shape — the 3 detailed cases in cases.ts have full
// findings/timeline; these add inventory depth and brand/city diversity.
import type { InspectionCase } from './cases';

const SPEC_M = { slug: 'm-kaufmann-berlin', name: 'Markus Kaufmann', initials: 'MK', city: 'Berlin', ratingAvg: 4.9, inspectionsCount: 312, yearsExperience: 12, bio: 'TÜV-сертифицированный инспектор. Berlin Mitte.' };
const SPEC_T = { slug: 't-albrecht-munich', name: 'Thomas Albrecht', initials: 'TA', city: 'München', ratingAvg: 4.8, inspectionsCount: 248, yearsExperience: 9, bio: 'TÜV. Специализация на VAG и DSG.' };
const SPEC_J = { slug: 'j-weber-hamburg', name: 'Jens Weber', initials: 'JW', city: 'Hamburg', ratingAvg: 4.9, inspectionsCount: 401, yearsExperience: 15, bio: 'TÜV. Специализация — скрученный пробег и кузов.' };

const IMG = {
  bmw_white_m:  'https://images.unsplash.com/photo-1555215695-3004980ad54e?w=1600&q=80&auto=format&fit=crop',
  audi_black:   'https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=1600&q=80&auto=format&fit=crop',
  vw_mustang:   'https://images.unsplash.com/photo-1494976388531-d1058494cdd8?w=1600&q=80&auto=format&fit=crop',
  porsche_red:  'https://images.unsplash.com/photo-1614026480209-a1d2cb37c20e?w=1600&q=80&auto=format&fit=crop',
  white_lux:    'https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?w=1600&q=80&auto=format&fit=crop',
  bmw_grey:     'https://images.unsplash.com/photo-1542362567-b07e54358753?w=1600&q=80&auto=format&fit=crop',
  black_sedan:  'https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=1600&q=80&auto=format&fit=crop',
  red_track:    'https://images.unsplash.com/photo-1502877338535-766e1452684a?w=1600&q=80&auto=format&fit=crop',
  blue_garage:  'https://images.unsplash.com/photo-1503376780353-7e6692767b70?w=1600&q=80&auto=format&fit=crop',
  silver_road:  'https://images.unsplash.com/photo-1525609004556-c46c7d6cf023?w=1600&q=80&auto=format&fit=crop',
  white_coupe:  'https://images.unsplash.com/photo-1494976997866-c1c8a4c39e2c?w=1600&q=80&auto=format&fit=crop',
  classic_g:    'https://images.unsplash.com/photo-1601362840469-51e4d8d58785?w=1600&q=80&auto=format&fit=crop',
  electric_t:   'https://images.unsplash.com/photo-1560958089-b8a1929cea89?w=1600&q=80&auto=format&fit=crop',
};

interface CompactDef {
  slug: string; make: string; model: string; year: number; km: number;
  city: string; askingPrice: number; marketPrice: number; saved: number;
  verdict: 'pass' | 'risk' | 'reject';
  verdictHeadline: string; verdictSummary: string;
  inspectionDate: string;
  hero: string;
  spec: typeof SPEC_M;
  findings: { category: string; title: string; severity: 'critical' | 'warning' | 'info' | 'ok'; description: string }[];
}

const C: CompactDef[] = [
  // — Premium German —
  { slug: 'porsche-cayenne-2019-stuttgart', make: 'Porsche', model: 'Cayenne S 2019', year: 2019, km: 96000, city: 'Stuttgart',  askingPrice: 52900, marketPrice: 50000, saved: 2900, verdict: 'risk',
    hero: IMG.porsche_red, spec: SPEC_T, inspectionDate: '2026-04-26',
    verdictHeadline: 'Брать с торгом — €2 900', verdictSummary: 'Износ воздушной подвески справа спереди. Замена через 20–30 тыс. км ~€2 100. Остальное в норме.',
    findings: [
      { category: 'Подвеска',  title: 'Износ пневмобаллона FR',  severity: 'warning', description: 'Утечка воздуха ~10% за ночь. Замена через 20–30 тыс. км.' },
      { category: 'Двигатель', title: 'Без замечаний',            severity: 'ok',      description: '3.0 TFSI 340 л.с. Запуск ровный, OBD без ошибок.' },
      { category: 'Кузов',     title: 'Без признаков ДТП',        severity: 'ok',      description: 'Заводские слои на всех панелях.' },
    ] },

  { slug: 'porsche-911-2020-munich', make: 'Porsche', model: '911 Carrera S 2020', year: 2020, km: 38000, city: 'München',  askingPrice: 119000, marketPrice: 119000, saved: 0, verdict: 'pass',
    hero: IMG.red_track, spec: SPEC_T, inspectionDate: '2026-04-19',
    verdictHeadline: 'Брать без торга', verdictSummary: 'Машина в идеальном состоянии. Один владелец, дилерская история, пробег подтверждён. TÜV до 2027.',
    findings: [
      { category: 'Двигатель', title: 'Образцовое состояние',     severity: 'ok', description: '3.0 Twin-Turbo. Без следов трекового использования.' },
      { category: 'Кузов',     title: 'Заводская окраска',         severity: 'ok', description: 'Толщиномер 110–125 мкм по всем панелям.' },
      { category: 'Документы', title: '1 владелец, дилер',         severity: 'ok', description: 'Полная сервисная история у Porsche Zentrum.' },
    ] },

  { slug: 'mercedes-amg-c63-2018-berlin', make: 'Mercedes', model: 'AMG C63 S 2018', year: 2018, km: 78000, city: 'Berlin',  askingPrice: 49900, marketPrice: 44000, saved: 5900, verdict: 'risk',
    hero: IMG.black_sedan, spec: SPEC_M, inspectionDate: '2026-04-24',
    verdictHeadline: 'Торг −€5 900', verdictSummary: 'Машина использовалась на треке (по логам ECU видны 17 high-load циклов). Сцепление AMG SpeedShift в износе. Кузов без замечаний.',
    findings: [
      { category: 'Трансмиссия', title: 'Износ сцепления AMG',       severity: 'warning',  description: 'Поведение на трогании указывает на 70%+ износа. Замена €3 800–4 500.' },
      { category: 'Двигатель',   title: 'Логи track-режима',         severity: 'warning',  description: 'ECU фиксирует 17 циклов high-load. Машина видела трек.' },
      { category: 'Кузов',       title: 'Без замечаний',              severity: 'ok',       description: 'Заводская окраска, без сколов, геометрия в норме.' },
    ] },

  { slug: 'mercedes-eqs-2022-frankfurt', make: 'Mercedes', model: 'EQS 580 4MATIC 2022', year: 2022, km: 32000, city: 'Frankfurt',  askingPrice: 89000, marketPrice: 87000, saved: 2000, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_J, inspectionDate: '2026-04-22',
    verdictHeadline: 'Брать с лёгким торгом', verdictSummary: 'Электромобиль в отличном состоянии. SOH батареи 96%. Дилерская история. Лёгкий торг —€2 000.',
    findings: [
      { category: 'Батарея',  title: 'SOH 96%',                     severity: 'ok', description: 'State of Health батареи проверен через дилерский сканер. Норма для 32 тыс. км.' },
      { category: 'Электроника', title: 'Без ошибок',                 severity: 'ok', description: 'Все модули штатны. Обновления ПО актуальны.' },
      { category: 'Документы', title: 'Дилерская история',           severity: 'ok', description: 'Mercedes-Benz Frankfurt. 1 владелец.' },
    ] },

  { slug: 'audi-rs6-2018-koln', make: 'Audi', model: 'RS6 Avant 2018', year: 2018, km: 87000, city: 'Köln',  askingPrice: 78900, marketPrice: 71000, saved: 7900, verdict: 'reject',
    hero: IMG.white_lux, spec: SPEC_M, inspectionDate: '2026-04-21',
    verdictHeadline: 'Не брать — серьёзное ДТП', verdictSummary: 'Передний удар средней силы. Замена лонжерона. По телеметрии Audi connect — авария зафиксирована в 2022. Машина в продаже без декларации.',
    findings: [
      { category: 'Кузов',     title: 'Замена лонжерона',          severity: 'critical', description: 'Сварной шов нештатный, толщиномер показывает кустарную работу. Геометрия с отклонениями.' },
      { category: 'Документы', title: 'Скрытая авария 2022',       severity: 'critical', description: 'По Audi connect — registered accident event. В объявлении не заявлена.' },
      { category: 'Двигатель', title: '4.0 TFSI в норме',           severity: 'ok',       description: 'Двигатель работает штатно.' },
    ] },

  { slug: 'audi-e-tron-gt-2021-hamburg', make: 'Audi', model: 'e-tron GT 2021', year: 2021, km: 41000, city: 'Hamburg',  askingPrice: 78000, marketPrice: 76000, saved: 2000, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_J, inspectionDate: '2026-04-23',
    verdictHeadline: 'Брать. Лёгкий торг.', verdictSummary: 'Электрокар в отличном состоянии. SOH 94%, без ДТП, дилерская история.',
    findings: [
      { category: 'Батарея',  title: 'SOH 94%',                     severity: 'ok', description: 'Норма для 41 тыс. км.' },
      { category: 'Кузов',    title: 'Заводская окраска',           severity: 'ok', description: 'Все панели штатны.' },
    ] },

  { slug: 'audi-q7-2017-stuttgart', make: 'Audi', model: 'Q7 3.0 TDI 2017', year: 2017, km: 167000, city: 'Stuttgart',  askingPrice: 27800, marketPrice: 24500, saved: 3300, verdict: 'risk',
    hero: IMG.silver_road, spec: SPEC_T, inspectionDate: '2026-04-15',
    verdictHeadline: 'Торг −€3 300', verdictSummary: 'Износ DPF близок к замене. Передние тормозные диски на пределе. Кузов чистый.',
    findings: [
      { category: 'Выхлоп',     title: 'DPF 88% забит',             severity: 'warning', description: 'Регенерация не справляется. Замена/чистка €700–1 100.' },
      { category: 'Тормоза',    title: 'Передние диски — предел',   severity: 'warning', description: 'Замена дисков и колодок ~€600.' },
      { category: 'Кузов',      title: 'Без замечаний',              severity: 'ok',      description: 'Заводская окраска.' },
    ] },

  { slug: 'audi-rs3-2021-berlin', make: 'Audi', model: 'RS3 Sedan 2021', year: 2021, km: 24000, city: 'Berlin',  askingPrice: 64500, marketPrice: 64500, saved: 0, verdict: 'pass',
    hero: IMG.red_track, spec: SPEC_M, inspectionDate: '2026-04-17',
    verdictHeadline: 'Образцовая машина', verdictSummary: 'Демо-кар у дилера. Без треков, дилерская история, гарантия до 2027.',
    findings: [
      { category: 'Двигатель',  title: '2.5 TFSI в идеале',         severity: 'ok', description: 'Без признаков нагрузочной езды.' },
      { category: 'Кузов',      title: 'Заводская',                  severity: 'ok', description: 'Толщиномер ровный.' },
    ] },

  // — BMW —
  { slug: 'bmw-m340i-2022-hamburg', make: 'BMW', model: 'M340i xDrive 2022', year: 2022, km: 28000, city: 'Hamburg',  askingPrice: 56900, marketPrice: 52700, saved: 4200, verdict: 'risk',
    hero: IMG.bmw_grey, spec: SPEC_J, inspectionDate: '2026-04-25',
    verdictHeadline: 'Скрытое ДТП — торг −€4 200', verdictSummary: 'Перекрашен задний бампер и заднее правое крыло. По Carfax зафиксировано боковое касание в 2023. В объявлении не указано.',
    findings: [
      { category: 'Кузов',      title: 'Перекраска 2 элементов',     severity: 'warning', description: 'Толщиномер 280–340 мкм. Покраска аккуратная, без следов рихтовки.' },
      { category: 'Документы',  title: 'Carfax: side impact 2023',   severity: 'critical', description: 'Зафиксированное событие, в объявлении не заявлено.' },
      { category: 'Двигатель',  title: 'B58 в норме',                 severity: 'ok',      description: 'OBD без ошибок.' },
    ] },

  { slug: 'bmw-m5-cs-2023-munich', make: 'BMW', model: 'M5 CS 2023', year: 2023, km: 14000, city: 'München',  askingPrice: 168000, marketPrice: 168000, saved: 0, verdict: 'pass',
    hero: IMG.bmw_white_m, spec: SPEC_T, inspectionDate: '2026-04-20',
    verdictHeadline: 'Лимитированная M5 CS — образцовое состояние', verdictSummary: 'Limited edition. Один владелец. Без треков. Полная гарантия BMW. Брать.',
    findings: [
      { category: 'Двигатель',   title: 'S63 ровно',                  severity: 'ok', description: 'Без следов трекового использования.' },
      { category: 'Кузов',       title: 'Карбон-композит чистый',     severity: 'ok', description: 'Без сколов.' },
      { category: 'Документы',   title: '1 владелец, дилер',          severity: 'ok', description: 'BMW M Munich. Полная история.' },
    ] },

  { slug: 'bmw-x5-40d-2017-hamburg', make: 'BMW', model: 'X5 40d 2017', year: 2017, km: 184000, city: 'Hamburg',  askingPrice: 22500, marketPrice: 16400, saved: 6100, verdict: 'reject',
    hero: IMG.bmw_grey, spec: SPEC_J, inspectionDate: '2026-04-13',
    verdictHeadline: 'Не брать — масло и пробег', verdictSummary: 'Скрученный пробег ~50 тыс. км. Расход масла 1.2 л/1000 км. Замена цепи ГРМ на пороге. Прохождение мимо.',
    findings: [
      { category: 'Двигатель',   title: 'Расход масла 1.2 л/1000',    severity: 'critical', description: 'N57 — известный износ направляющих клапанов.' },
      { category: 'Документы',   title: 'Скрутка ~50 тыс.',           severity: 'critical', description: 'Сервисная книжка обрывается на 230 тыс. На щитке — 184 тыс.' },
      { category: 'ГРМ',         title: 'Цепь на пороге замены',      severity: 'warning',  description: 'Шум на холодную. Замена ~€2 400.' },
    ] },

  { slug: 'bmw-i4-m50-2022-frankfurt', make: 'BMW', model: 'i4 M50 2022', year: 2022, km: 38000, city: 'Frankfurt',  askingPrice: 58900, marketPrice: 56500, saved: 2400, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_M, inspectionDate: '2026-04-16',
    verdictHeadline: 'Лёгкий торг и брать', verdictSummary: 'Электрокар, SOH 95%, без ДТП. Лёгкий торг —€2 400 за пробег.',
    findings: [
      { category: 'Батарея',     title: 'SOH 95%',                     severity: 'ok', description: 'Норма.' },
      { category: 'Документы',   title: '1 владелец',                  severity: 'ok', description: 'Дилерская история.' },
    ] },

  // — VW / Skoda —
  { slug: 'vw-touareg-2019-frankfurt', make: 'VW', model: 'Touareg V6 TDI 2019', year: 2019, km: 102000, city: 'Frankfurt',  askingPrice: 33900, marketPrice: 32000, saved: 1900, verdict: 'risk',
    hero: IMG.silver_road, spec: SPEC_T, inspectionDate: '2026-04-14',
    verdictHeadline: 'Лёгкий торг', verdictSummary: 'AdBlue-сенсор требует замены через 5–10 тыс. км. Кузов чистый. История у дилера.',
    findings: [
      { category: 'Выхлоп',      title: 'AdBlue-сенсор предел',       severity: 'warning', description: 'Ошибка появится через 5–10 тыс. км. Замена ~€420.' },
      { category: 'Кузов',       title: 'Без замечаний',               severity: 'ok',      description: 'Заводская окраска.' },
    ] },

  { slug: 'vw-id4-2022-leipzig', make: 'VW', model: 'ID.4 GTX 2022', year: 2022, km: 41000, city: 'Leipzig',  askingPrice: 39800, marketPrice: 38800, saved: 1000, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_M, inspectionDate: '2026-04-12',
    verdictHeadline: 'Брать', verdictSummary: 'Электромобиль в отличном состоянии. SOH 93%. Гарантия до 2030.',
    findings: [
      { category: 'Батарея',     title: 'SOH 93%',                     severity: 'ok', description: 'Норма для 41 тыс. км.' },
      { category: 'Кузов',       title: 'Без замечаний',               severity: 'ok', description: 'Заводская окраска.' },
    ] },

  { slug: 'vw-arteon-2020-koln', make: 'VW', model: 'Arteon 2.0 TDI 2020', year: 2020, km: 88000, city: 'Köln',  askingPrice: 25400, marketPrice: 25400, saved: 0, verdict: 'pass',
    hero: IMG.black_sedan, spec: SPEC_T, inspectionDate: '2026-04-11',
    verdictHeadline: 'Брать', verdictSummary: 'Сервис у дилера. Без замечаний. TÜV до 2026.',
    findings: [
      { category: 'Двигатель',   title: '2.0 TDI чисто',               severity: 'ok', description: 'Без расхода масла.' },
      { category: 'Документы',   title: '1 владелец',                  severity: 'ok', description: 'Дилерская история.' },
    ] },

  { slug: 'skoda-superb-2019-bremen', make: 'Skoda', model: 'Superb 2.0 TDI 2019', year: 2019, km: 156000, city: 'Bremen',  askingPrice: 17900, marketPrice: 14700, saved: 3200, verdict: 'risk',
    hero: IMG.silver_road, spec: SPEC_J, inspectionDate: '2026-04-09',
    verdictHeadline: 'Торг −€3 200', verdictSummary: 'DSG требует замены масла + износ DMF (двухмассового маховика). Кузов чистый.',
    findings: [
      { category: 'Трансмиссия', title: 'Износ DMF',                   severity: 'warning', description: 'Вибрации на холостых. Замена ~€1 800.' },
      { category: 'Кузов',       title: 'Без замечаний',               severity: 'ok',      description: 'Заводская окраска.' },
    ] },

  // — Other premium / mass —
  { slug: 'tesla-model3-2021-berlin', make: 'Tesla', model: 'Model 3 Long Range 2021', year: 2021, km: 58000, city: 'Berlin',  askingPrice: 32900, marketPrice: 31500, saved: 1400, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_M, inspectionDate: '2026-04-08',
    verdictHeadline: 'Брать с лёгким торгом', verdictSummary: 'Battery health 92%. Без ДТП. Без свапа батареи.',
    findings: [
      { category: 'Батарея',     title: 'SOH 92%',                     severity: 'ok', description: 'Норма для 58 тыс. км.' },
      { category: 'Электроника', title: 'Без ошибок',                  severity: 'ok', description: 'FSD ON, обновления актуальны.' },
    ] },

  { slug: 'volvo-xc90-2018-hannover', make: 'Volvo', model: 'XC90 D5 AWD 2018', year: 2018, km: 142000, city: 'Hannover',  askingPrice: 28400, marketPrice: 27000, saved: 1400, verdict: 'pass',
    hero: IMG.silver_road, spec: SPEC_J, inspectionDate: '2026-04-06',
    verdictHeadline: 'Брать с лёгким торгом', verdictSummary: 'Сервис у дилера. Кузов без замечаний. AdBlue-сенсор предел.',
    findings: [
      { category: 'Выхлоп',      title: 'AdBlue-сенсор предел',       severity: 'warning', description: 'Замена через 10 тыс. км. ~€350.' },
      { category: 'Кузов',       title: 'Без замечаний',               severity: 'ok',      description: 'Заводская окраска.' },
    ] },

  { slug: 'ford-mustang-gt-2018-luebeck', make: 'Ford', model: 'Mustang GT 5.0 2018', year: 2018, km: 67000, city: 'Lübeck',  askingPrice: 32900, marketPrice: 26800, saved: 6100, verdict: 'reject',
    hero: IMG.red_track, spec: SPEC_J, inspectionDate: '2026-04-09',
    verdictHeadline: 'Не брать — track abuse', verdictSummary: 'По логам ECU и износу деталей машина регулярно использовалась на треке. Сцепление, тормоза, подвеска — ресурс выработан. Не брать.',
    findings: [
      { category: 'Двигатель',   title: 'Логи трека',                  severity: 'critical', description: '40+ high-load циклов в логах. Машина видела трек.' },
      { category: 'Тормоза',     title: 'Диски + колодки ушатаны',     severity: 'critical', description: 'Замена комплекта ~€1 600.' },
      { category: 'Сцепление',   title: 'Износ 90%',                   severity: 'warning',  description: 'Замена ~€2 200.' },
    ] },

  { slug: 'toyota-rav4-2020-hamburg', make: 'Toyota', model: 'RAV4 Hybrid 2020', year: 2020, km: 78000, city: 'Hamburg',  askingPrice: 24900, marketPrice: 24500, saved: 400, verdict: 'pass',
    hero: IMG.silver_road, spec: SPEC_J, inspectionDate: '2026-04-13',
    verdictHeadline: 'Брать', verdictSummary: 'Гибрид в отличном состоянии. Battery health отличный. Дилер.',
    findings: [
      { category: 'Гибрид',      title: 'Hybrid battery норма',        severity: 'ok', description: 'Все 240 ячеек балансированы.' },
      { category: 'Кузов',       title: 'Без замечаний',               severity: 'ok', description: 'Заводская окраска.' },
    ] },

  { slug: 'hyundai-ioniq5-2022-dusseldorf', make: 'Hyundai', model: 'IONIQ 5 AWD 2022', year: 2022, km: 36000, city: 'Düsseldorf',  askingPrice: 41900, marketPrice: 41900, saved: 0, verdict: 'pass',
    hero: IMG.electric_t, spec: SPEC_M, inspectionDate: '2026-04-07',
    verdictHeadline: 'Брать', verdictSummary: 'SOH 95%. Без ДТП. Дилер. Гарантия до 2030.',
    findings: [
      { category: 'Батарея',     title: 'SOH 95%',                     severity: 'ok', description: 'Норма.' },
      { category: 'Электроника', title: 'Без ошибок',                  severity: 'ok', description: 'OTA актуально.' },
    ] },

  // — Classic / G-class —
  { slug: 'mercedes-g-class-2015-classic', make: 'Mercedes', model: 'G-Class G500 2015', year: 2015, km: 198000, city: 'Düsseldorf',  askingPrice: 64900, marketPrice: 58000, saved: 6900, verdict: 'risk',
    hero: IMG.classic_g, spec: SPEC_J, inspectionDate: '2026-04-05',
    verdictHeadline: 'Брать с серьёзным торгом', verdictSummary: 'Перекрашены два кузовных элемента. Раздатка требует ремонта в ближайшие 30 тыс. Цена выше рынка.',
    findings: [
      { category: 'Кузов',       title: 'Перекраска 2 эл.',            severity: 'warning', description: 'Толщиномер 290–360 мкм.' },
      { category: 'Трансмиссия', title: 'Раздатка',                    severity: 'warning', description: 'Шум на холодную. Ремонт ~€2 800.' },
    ] },
];

const TIMELINE_GENERIC = [
  { ts: '2026-04-XX', label: 'Заявка получена',     detail: 'Ссылка с объявления',     done: true },
  { ts: '2026-04-XX', label: 'Назначен инспектор',  detail: 'Ближайший эксперт по зоне', done: true },
  { ts: '2026-04-XX', label: 'Осмотр на месте',     detail: 'Чек-лист 60+ пунктов',    done: true },
  { ts: '2026-04-XX', label: 'Отчёт сформирован',   detail: 'PDF · фото · видео',       done: true },
];

export const EXTRA_CASES: InspectionCase[] = C.map(d => ({
  id: d.slug,
  slug: d.slug,
  title: `${d.make} ${d.model}`,
  make: d.make,
  model: d.model,
  year: d.year,
  km: d.km,
  city: d.city,
  country: 'Deutschland',
  askingPrice: d.askingPrice,
  marketPrice: d.marketPrice,
  saved: d.saved,
  verdict: d.verdict,
  verdictHeadline: d.verdictHeadline,
  verdictSummary: d.verdictSummary,
  inspectionDate: d.inspectionDate,
  reportPages: 14 + Math.floor((d.findings.length + 2) * 1.5),
  heroImage: d.hero,
  gallery: [d.hero],
  findings: d.findings,
  timeline: TIMELINE_GENERIC.map(s => ({ ...s, ts: s.ts.replace('XX', String((Math.floor(Math.random() * 28) + 1)).padStart(2, '0')) })),
  specialist: d.spec,
}));
