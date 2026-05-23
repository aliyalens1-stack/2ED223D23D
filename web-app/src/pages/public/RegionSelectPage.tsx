/**
 * RegionSelectPage — web counterpart of mobile `city-select.tsx`.
 *
 * Backed by:
 *   GET /api/cities                  → list of {code, name, country, providersCount, aliases?}
 *   GET /api/geo/countries           → country catalogue
 *   GET /api/geo/coverage/countries  → per-country supply rollup (optional)
 *
 * Saves the picked city into localStorage under `selectedCityCode` and
 * fires a `cityChanged` window event for downstream consumers
 * (HomePage / RequestIntake / Pricing preview pick it up via custom event).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search, MapPin, Check, ArrowLeft, Globe2 } from 'lucide-react';

interface CityDTO {
  code: string;
  name: string;
  country: string;
  providersCount?: number;
  aliases?: string[];
}
interface CountryDTO {
  code: string;
  name: string;
  flag?: string;
}

const FLAG: Record<string, string> = {
  DE: '🇩🇪', AT: '🇦🇹', CH: '🇨🇭',
  LV: '🇱🇻', LT: '🇱🇹', EE: '🇪🇪',
  BY: '🇧🇾', UA: '🇺🇦',
  PL: '🇵🇱', CZ: '🇨🇿', NL: '🇳🇱', FR: '🇫🇷', IT: '🇮🇹', BE: '🇧🇪',
};
const COUNTRY_NAME: Record<string, string> = {
  DE: 'Germany', AT: 'Austria', CH: 'Switzerland',
  LV: 'Latvia', LT: 'Lithuania', EE: 'Estonia',
  BY: 'Belarus', UA: 'Ukraine',
  PL: 'Poland', CZ: 'Czechia', NL: 'Netherlands', FR: 'France', IT: 'Italy', BE: 'Belgium',
};
const COUNTRY_RANK: Record<string, number> = {
  DE: 0, AT: 1, CH: 2,
  LV: 10, LT: 11, EE: 12,
  BY: 20, UA: 21,
  PL: 30, CZ: 31, NL: 32, FR: 33, IT: 34, BE: 35,
};

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

export default function RegionSelectPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirect = params.get('redirect') || '/';

  const [cities, setCities] = useState<CityDTO[]>([]);
  const [countries, setCountries] = useState<CountryDTO[]>([]);
  const [country, setCountry] = useState<string>('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const selectedCode = typeof window !== 'undefined' ? localStorage.getItem('selectedCityCode') || '' : '';

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    Promise.all([
      fetch('/api/cities').then((r) => r.json()).catch(() => ({})),
      fetch('/api/geo/countries').then((r) => r.json()).catch(() => ({ countries: [] })),
    ])
      .then(([citiesRes, countriesRes]) => {
        if (cancel) return;
        const list: CityDTO[] = Array.isArray(citiesRes) ? citiesRes : (citiesRes.cities || []);
        setCities(list);
        const cs: CountryDTO[] = Array.isArray(countriesRes) ? countriesRes : (countriesRes.countries || []);
        setCountries(cs.length ? cs : Array.from(new Set(list.map((c) => c.country))).map((cc) => ({
          code: cc, name: COUNTRY_NAME[cc] || cc, flag: FLAG[cc],
        })));
      })
      .catch((e) => !cancel && setError(String(e)))
      .finally(() => !cancel && setLoading(false));
    return () => { cancel = true; };
  }, []);

  const handleSelect = (c: CityDTO) => {
    localStorage.setItem('selectedCityCode', c.code);
    localStorage.setItem('selectedCityName', c.name);
    localStorage.setItem('selectedCityCountry', c.country);
    try { window.dispatchEvent(new CustomEvent('cityChanged', { detail: c })); } catch {}
    navigate(redirect);
  };

  const filtered = useMemo(() => {
    const q = fold(query.trim());
    return cities
      .filter((c) => {
        if (country && c.country !== country) return false;
        if (!q) return true;
        const aliasMatch = (c.aliases || []).some((a) => fold(a).includes(q));
        return (
          fold(c.name).includes(q) ||
          c.code.toLowerCase().includes(q) ||
          fold(c.country).includes(q) ||
          fold(COUNTRY_NAME[c.country] || '').includes(q) ||
          aliasMatch
        );
      })
      .sort((a, b) => {
        const ra = COUNTRY_RANK[a.country] ?? 50;
        const rb = COUNTRY_RANK[b.country] ?? 50;
        if (ra !== rb) return ra - rb;
        return a.name.localeCompare(b.name);
      });
  }, [cities, country, query]);

  const grouped = useMemo(() => {
    const out: Array<{ country: string; cities: CityDTO[] }> = [];
    let last = '';
    let bucket: CityDTO[] = [];
    for (const c of filtered) {
      if (c.country !== last) {
        if (bucket.length) out.push({ country: last, cities: bucket });
        last = c.country;
        bucket = [];
      }
      bucket.push(c);
    }
    if (bucket.length) out.push({ country: last, cities: bucket });
    return out;
  }, [filtered]);

  return (
    <div className="mx-auto max-w-5xl px-4 md:px-6 py-8" data-testid="region-select-page">
      <Link to={redirect} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--text-2)] hover:text-[var(--text)] mb-6">
        <ArrowLeft size={16} /> {t('region.back')}
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--primary-h)] mb-2">{t('region.coverage')}</p>
          <h1 className="text-3xl md:text-4xl font-extrabold leading-tight">{t('region.title')}</h1>
          <p className="mt-2 text-[var(--text-2)] max-w-2xl">
            {t('region.subtitle')} {t('region.stats', { cities: cities.length, countries: countries.length })}
          </p>
        </div>
        <div className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-soft)]">{t('region.currently')}</div>
          <div className="text-lg font-extrabold text-[var(--text)]" data-testid="current-city">
            {localStorage.getItem('selectedCityName') || t('region.not_set')}
          </div>
        </div>
      </div>

      {/* Country chips */}
      <div className="mt-6 flex flex-wrap gap-2" data-testid="country-chips">
        <button
          onClick={() => setCountry('')}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${
            country === '' ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                           : 'border-[var(--border)] bg-white text-[var(--text-2)] hover:border-[var(--text-soft)]'
          }`}
          data-testid="country-all"
        >
          <Globe2 size={14} /> {t('region.all_countries')}
        </button>
        {countries
          .slice()
          .sort((a, b) => (COUNTRY_RANK[a.code] ?? 50) - (COUNTRY_RANK[b.code] ?? 50))
          .map((c) => (
            <button
              key={c.code}
              onClick={() => setCountry(country === c.code ? '' : c.code)}
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${
                country === c.code
                  ? 'border-[var(--primary)] bg-[var(--primary-soft)] text-[var(--text)]'
                  : 'border-[var(--border)] bg-white text-[var(--text-2)] hover:border-[var(--text-soft)]'
              }`}
              data-testid={`country-${c.code}`}
            >
              <span>{FLAG[c.code] || c.flag || '🌍'}</span>
              <span>{COUNTRY_NAME[c.code] || c.name}</span>
            </button>
          ))}
      </div>

      {/* Search */}
      <div className="mt-5 flex items-center w-full rounded-xl border border-[var(--border)] bg-white px-4 h-12 focus-within:border-[var(--primary)]">
        <Search size={16} className="text-[var(--text-soft)] shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('region.search_placeholder')}
          className="ml-3 w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-soft)]"
          data-testid="region-search-input"
        />
      </div>

      {/* Loading / empty / list */}
      {error && (
        <div className="mt-6 rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] px-4 py-3 text-sm font-bold">
          {error}
        </div>
      )}
      {loading ? (
        <div className="mt-10 text-center text-[var(--text-soft)]" data-testid="region-loading">{t('region.loading')}</div>
      ) : filtered.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-[var(--border)] bg-white p-8 text-center" data-testid="region-empty">
          <MapPin size={32} className="mx-auto text-[var(--text-soft)] mb-3" />
          <div className="text-lg font-bold">{t('region.city_not_found')}</div>
          <p className="text-sm text-[var(--text-2)] mt-1">{t('region.city_not_found_hint')}</p>
        </div>
      ) : (
        <div className="mt-6 space-y-8" data-testid="region-list">
          {grouped.map((g) => (
            <section key={g.country}>
              <h3 className="mb-3 text-xs font-extrabold uppercase tracking-[0.15em] text-[var(--text-soft)]">
                {FLAG[g.country] || ''} {COUNTRY_NAME[g.country] || g.country} · {g.cities.length}
              </h3>
              <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                {g.cities.map((c) => {
                  const active = selectedCode === c.code;
                  return (
                    <button
                      key={c.code}
                      onClick={() => handleSelect(c)}
                      data-testid={`city-${c.code}`}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition ${
                        active
                          ? 'border-[var(--primary)] bg-[var(--primary-soft)] shadow-[var(--shadow-card)]'
                          : 'border-[var(--border)] bg-white hover:border-[var(--text-soft)]'
                      }`}
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--surface-soft)] text-xl">
                        {FLAG[c.country] || '🌍'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-bold truncate">{c.name}</div>
                        <div className="text-xs text-[var(--text-soft)]">
                          {c.country} ·{' '}
                          {(c.providersCount ?? 0) > 0
                            ? t('region.inspectors_count', { count: c.providersCount })
                            : t('region.looking_for_inspectors')}
                        </div>
                      </div>
                      {active && (
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--primary)] text-black">
                          <Check size={14} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
