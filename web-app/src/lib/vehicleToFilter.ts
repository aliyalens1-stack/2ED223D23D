/**
 * vehicleToFilter — превращает конкретный vehicle в market subscription filter.
 *
 * Это не "фильтры", это projection:
 *
 *   "мне нравится ЭТА BMW"  →  "я ищу ТАКИЕ BMW"
 *
 * Правила (агрессивно opinionated, чтобы не показывать пустую форму):
 *   - brand        как есть
 *   - model        первый токен (320d Touring → 320d, X5 xDrive40i → X5)
 *   - yearMin/Max  ±1 год от текущего, если год известен
 *   - priceMax     +12% к текущей цене (рынок ±10% спред + buffer)
 *   - city         чистое имя города (без ZIP / страны)
 *   - mileageMax   текущий пробег + 30 000 км (даём верхнюю границу выше)
 *
 * Любое поле может быть undefined — просто не попадает в filter
 * (на сервере missing dimension = wildcard).
 */

export interface MarketFilter {
  brand?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMax?: number;
  mileageMax?: number;
  city?: string;
  fuel?: string;
}

export interface VehicleLike {
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  price?: number | null;
  mileage?: number | null;
  location?: string | null;
  fuel?: string | null;
}

/** "320d Touring" → "320d", "X5 xDrive40i" → "X5", "A4 Avant 2.0 TDI" → "A4". */
export function normalizedModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  const tokens = model.trim().split(/\s+/).filter(Boolean);
  return tokens[0] || undefined;
}

/** "10115 Berlin · Deutschland" → "Berlin". "Berlin, Германия" → "Berlin". */
export function cityOf(location: string | null | undefined): string | undefined {
  if (!location) return undefined;
  const parts = location.split(/[·,]/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const cleaned = p.replace(/^\d{4,5}\s+/, '').trim();
    if (cleaned && !/^\d+$/.test(cleaned)) return cleaned;
  }
  return location.trim();
}

/** Round to nearest 100 EUR for clean labels. */
function roundCents(value: number): number {
  return Math.round(value / 100) * 100;
}

export function vehicleToFilter(v: VehicleLike): MarketFilter {
  const filter: MarketFilter = {};

  if (v.brand) filter.brand = v.brand.trim();

  const model = normalizedModel(v.model);
  if (model) filter.model = model;

  if (typeof v.year === 'number' && v.year > 1900) {
    filter.yearMin = v.year - 1;
    filter.yearMax = v.year + 1;
  }

  if (typeof v.price === 'number' && v.price > 0) {
    filter.priceMax = roundCents(v.price * 1.12);
  }

  if (typeof v.mileage === 'number' && v.mileage > 0) {
    // Round to nearest 5 000 km, add 30k buffer.
    filter.mileageMax = Math.round((v.mileage + 30_000) / 5_000) * 5_000;
  }

  const city = cityOf(v.location);
  if (city) filter.city = city;

  if (v.fuel) filter.fuel = v.fuel.trim();

  return filter;
}

/**
 * Headline для модалки. Не "Save search", а ощущение "следить за рынком".
 *
 * Examples:
 *   "Следить за похожими BMW 320d"
 *   "Следить за похожими BMW 320d в Berlin"
 *   "Следить за похожими машинами"
 */
export function similarHeadline(v: VehicleLike): string {
  const parts: string[] = [];
  if (v.brand) parts.push(v.brand);
  const model = normalizedModel(v.model);
  if (model) parts.push(model);
  const what = parts.length > 0 ? parts.join(' ') : 'машинами';
  const city = cityOf(v.location);
  return city ? `Следить за похожими ${what} в ${city}` : `Следить за похожими ${what}`;
}

/** Subline — небольшой объясняющий текст под headline. */
export function similarSubline(v: VehicleLike): string {
  const f = vehicleToFilter(v);
  const bits: string[] = [];
  if (f.yearMin && f.yearMax) bits.push(`${f.yearMin}–${f.yearMax}`);
  if (f.priceMax) bits.push(`до €${f.priceMax.toLocaleString('de-DE')}`);
  if (f.mileageMax) bits.push(`до ${f.mileageMax.toLocaleString('de-DE')} км`);
  return bits.length > 0
    ? `Рынок будет искать варианты: ${bits.join(' · ')}`
    : 'Рынок будет искать похожие варианты и сообщать вам.';
}
