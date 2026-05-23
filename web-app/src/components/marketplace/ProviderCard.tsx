import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Star, MapPin, Clock, ShieldCheck, Wrench, Award, CheckCircle2 } from 'lucide-react';

export interface TrustChip { key: string; label: string; tone: 'gold' | 'success' | 'neutral'; }
export interface TrustProfile {
  tuvVerified?: boolean;
  yearsExperience?: number;
  vehiclesInspected?: number;
  reviewsCount?: number;
  ratingAvg?: number;
  boostFactor?: number;
  chips?: TrustChip[];
}

export interface ProviderCardData {
  id?: string;
  _id?: string;
  slug?: string;
  name?: string;
  title?: string;
  photo?: string;
  logo?: string;
  description?: string;
  specialization?: string;
  isOnline?: boolean;
  status?: string;
  ratingAvg?: number;
  rating?: number;
  reviewsCount?: number;
  reviewCount?: number;
  distanceKm?: number;
  distance?: number;
  etaMin?: number;
  eta?: number;
  priceFrom?: number;
  minPrice?: number;
  trustBadges?: string[];
  trustProfile?: TrustProfile;  // Berlin Launch B3
  tags?: string[];
  verified?: boolean;
  mobileService?: boolean;
}

/**
 * Sprint 14 — Light ProviderCard
 * Goals: scannable in <3 seconds, trust-first, Booking-class layout.
 * Layout: [photo 96] [title + meta] [price + CTAs]
 * Yellow used only on the primary CTA. Trust signals as soft chips.
 */
export function ProviderCard({ provider }: { provider: ProviderCardData }) {
  const { t } = useTranslation();
  const slug = provider.slug || provider.id || provider._id || 'unknown';
  const isOnline = provider.isOnline ?? provider.status === 'online' ?? true;
  const rating = provider.ratingAvg ?? provider.rating ?? 4.8;
  const reviews = provider.reviewsCount ?? provider.reviewCount ?? 0;
  const distance = provider.distanceKm ?? provider.distance ?? null;
  const eta = provider.etaMin ?? provider.eta ?? null;
  const price = provider.priceFrom ?? provider.minPrice ?? null;
  const photo = provider.photo || provider.logo;
  const description = provider.specialization || provider.description || t('provider_card.default_description');
  const trust = provider.trustProfile;

  const tpChips = trust?.chips && trust.chips.length > 0 ? trust.chips : null;
  const legacyChips = !tpChips
    ? (provider.trustBadges && provider.trustBadges.length > 0
        ? provider.trustBadges
        : (provider.tags && provider.tags.length > 0
            ? provider.tags
            : (() => {
                const auto: string[] = [];
                if (provider.verified) auto.push(t('provider_card.fallback_verified'));
                if (provider.mobileService) auto.push('Mobile');
                if (auto.length === 0) auto.push(t('provider_card.fallback_verified'), t('provider_card.fallback_fast'));
                return auto;
              })()))
    : null;

  return (
    <article
      className="provider-card grid gap-4 p-4 md:grid-cols-[96px_1fr_auto] items-center"
      data-testid={`provider-card-${slug}`}
    >
      {/* Photo */}
      <Link
        to={`/provider/${slug}`}
        className="block h-24 w-24 overflow-hidden rounded-2xl bg-[var(--surface-soft)] shrink-0"
        data-testid={`provider-photo-${slug}`}
      >
        {photo ? (
          <img src={photo} alt={provider.name || 'Provider'} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[var(--text-soft)]">
            <Wrench size={32} />
          </div>
        )}
      </Link>

      {/* Content */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/provider/${slug}`} className="text-lg font-extrabold text-[var(--text)] hover:underline truncate" data-testid={`provider-name-${slug}`}>
            {provider.name || provider.title}
          </Link>
          {trust?.tuvVerified && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-[var(--primary)] text-black px-2 py-0.5 text-[11px] font-extrabold"
              data-testid={`provider-tuv-${slug}`}
              title={t('provider_card.tuv_title')}
            >
              <Award size={11} /> {t('provider_card.tuv_label')}
            </span>
          )}
          {isOnline && (
            <span className="rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-[11px] font-bold text-[var(--success)]" data-testid={`provider-status-${slug}`}>
              {t('provider_card.open')}
            </span>
          )}
        </div>

        <p className="mt-1 text-sm text-[var(--text-2)] line-clamp-1">
          {trust?.tuvVerified ? t('provider_card.tuv_description') : description}
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-[var(--text-2)]">
          <span className="inline-flex items-center gap-1 font-semibold text-[var(--text)]">
            <Star size={14} className="text-[var(--primary)] fill-[var(--primary)]" />
            {Number(rating).toFixed(1)}
            {reviews > 0 && <span className="text-[var(--text-soft)] font-normal">({reviews})</span>}
          </span>
          {distance !== null && (
            <span className="inline-flex items-center gap-1">
              <MapPin size={14} className="text-[var(--text-soft)]" /> {Number(distance).toFixed(1)} km
            </span>
          )}
          {eta !== null && (
            <span className="inline-flex items-center gap-1">
              <Clock size={14} className="text-[var(--text-soft)]" /> {eta} {t('common.minutes_short')}
            </span>
          )}
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {tpChips && tpChips.slice(0, 4).map((c) => (
            <span
              key={c.key}
              className={
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold ' +
                (c.tone === 'gold'
                  ? 'border-[#f59e0b] bg-[#fef3c7] text-[#78350f]'
                  : c.tone === 'success'
                  ? 'border-[var(--border)] bg-[var(--success-soft)] text-[var(--success)]'
                  : 'border-[var(--border)] bg-[var(--surface-soft)] text-[var(--text-2)]')
              }
              data-testid={`provider-chip-${slug}-${c.key}`}
            >
              {c.key === 'tuv' && <Award size={11} />}
              {c.key === 'verified' && <ShieldCheck size={11} />}
              {c.key === 'experience' && <CheckCircle2 size={11} />}
              {c.label}
            </span>
          ))}
          {!tpChips && legacyChips && legacyChips.slice(0, 4).map((badge: string) => (
            <span
              key={badge}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--text-2)]"
            >
              {badge.toLowerCase().includes('verif') && <ShieldCheck size={11} className="text-[var(--success)]" />}
              {badge}
            </span>
          ))}
        </div>
      </div>

      {/* Price + CTAs */}
      <div className="flex flex-row md:flex-col md:items-end justify-between md:justify-start gap-3 md:min-w-[180px]">
        {price !== null && (
          <div className="md:text-right">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-[var(--text-soft)]">{t('provider_card.from')}</div>
            <div className="text-2xl font-extrabold text-[var(--text)]">{price} €</div>
          </div>
        )}
        <div className="flex gap-2">
          <Link
            to={`/provider/${slug}?action=book`}
            className="btn-primary btn-sm"
            data-testid={`provider-book-${slug}`}
          >
            {t('provider_card.book')}
          </Link>
          <Link
            to={`/provider/${slug}`}
            className="btn-secondary btn-sm"
            data-testid={`provider-profile-${slug}`}
          >
            {t('provider_card.profile')}
          </Link>
        </div>
      </div>
    </article>
  );
}

export default ProviderCard;
