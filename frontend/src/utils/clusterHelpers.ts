/**
 * src/utils/clusterHelpers.ts — Sprint 33 C6
 *
 * Pure helpers used by the cluster-aware UI:
 *   - parseCarLink: validate inspection URLs (mobile.de / autoscout24)
 *   - getCurrency: cluster → currency symbol
 *   - getCurrencyCode: cluster → ISO code (UAH/EUR)
 *   - getInputCopy: cluster → contextual placeholder + label
 */

export type ClusterId = 'repair' | 'inspection' | 'selection' | 'delivery';

export interface ParsedCarLink {
  valid: boolean;
  source: 'mobile.de' | 'autoscout24' | null;
  url: string;
  reason?: string;
}

export function parseCarLink(url: string): ParsedCarLink {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return { valid: false, source: null, url: '', reason: 'empty' };
  }
  const lower = trimmed.toLowerCase();
  // Mobile.de (suchen.mobile.de, www.mobile.de, m.mobile.de etc)
  if (lower.includes('mobile.de')) {
    return { valid: true, source: 'mobile.de', url: trimmed };
  }
  if (lower.includes('autoscout24')) {
    return { valid: true, source: 'autoscout24', url: trimmed };
  }
  // Accept any HTTPS URL as "best effort" (some users paste local listings)
  if (/^https?:\/\//i.test(trimmed)) {
    return { valid: true, source: null, url: trimmed, reason: 'unknown_source_accepted' };
  }
  return { valid: false, source: null, url: trimmed, reason: 'not_a_url' };
}

export function getCurrency(cluster: ClusterId | string | undefined): string {
  // Repair = UAH (Ukraine flagship). All other clusters target EUR (Germany pivot).
  return cluster === 'repair' ? '₴' : '€';
}

export function getCurrencyCode(cluster: ClusterId | string | undefined): string {
  return cluster === 'repair' ? 'UAH' : 'EUR';
}

export function formatPrice(cluster: ClusterId | string | undefined, amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const num = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (Number.isNaN(num)) return '—';
  const sym = getCurrency(cluster);
  // EUR: prefix; UAH: postfix
  return cluster === 'repair' ? `${num} ${sym}` : `${sym} ${num}`;
}

export interface ClusterInputCopy {
  label: string;
  placeholder: string;
  field: 'carLink' | 'budget' | 'addressHint' | null; // which extra field to require
  helper?: string;
}

export function getInputCopy(cluster: ClusterId | string): ClusterInputCopy {
  switch (cluster) {
    case 'inspection':
      return {
        label: 'Ссылка на авто',
        placeholder: 'https://mobile.de/...  или  autoscout24',
        field: 'carLink',
        helper: 'Эксперт изучит объявление и осмотрит авто перед сделкой',
      };
    case 'selection':
      return {
        label: 'Бюджет (€)',
        placeholder: '15000',
        field: 'budget',
        helper: 'Эксперт подберёт авто под бюджет и проверит',
      };
    case 'delivery':
      return {
        label: 'Откуда → куда',
        placeholder: 'Berlin → Kyiv',
        field: 'addressHint',
        helper: 'Маршрут пригона авто',
      };
    case 'repair':
    default:
      return {
        label: 'Что случилось?',
        placeholder: 'Не заводится, странный шум, тормоза…',
        field: null,
        helper: 'Срочный выезд мастера',
      };
  }
}
