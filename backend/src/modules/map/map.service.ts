import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

export type MapFilter = 'all' | 'today' | 'fast' | 'verified' | 'mobile';

export interface NearbyQuery {
  lat: number;
  lng: number;
  radiusKm: number;
  limit: number;
  filter?: MapFilter;
}

export interface ViewportQuery {
  swLat: number;
  swLng: number;
  neLat: number;
  neLng: number;
  filter?: MapFilter;
}

export interface MatchingQuery {
  lat: number;
  lng: number;
  serviceId?: string;
  urgency?: 'low' | 'medium' | 'high';
  limit: number;
}

export interface MapProvider {
  id: string;
  name: string;
  lat: number;
  lng: number;
  distanceKm: number;
  rating: number;
  reviewsCount: number;
  isVerified: boolean;
  isPopular: boolean;
  isMobile: boolean;
  hasAvailableSlotsToday: boolean;
  avgResponseTimeMinutes: number;
  visibilityScore: number;
  matchingScore: number;
  specializations: string[];
  reasons: string[];
  pinType: 'verified' | 'popular' | 'mobile' | 'standard' | 'admin' | 'unverified';
  locationSource: 'self' | 'admin' | 'auto';
  isLocationVerified: boolean;
}

@Injectable()
export class MapService {
  private readonly logger = new Logger(MapService.name);

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
  ) {}

  /**
   * 🔥 DIRECT MODE — Конверсионный экран
   * "Подходит ли он мне? Близко ли? Могу ли записаться?"
   */
  async getDirectMode(query: { providerId: string; lat: number; lng: number }): Promise<any> {
    const { providerId, lat, lng } = query;

    const orgResult = await this.orgModel.findById(providerId).lean();
    if (!orgResult) {
      return { error: 'Provider not found' };
    }
    
    const org = orgResult as any;
    const provLat = org.location?.coordinates?.[1] || 0;
    const provLng = org.location?.coordinates?.[0] || 0;
    const distanceKm = this.haversine(lat, lng, provLat, provLng);

    // Calculate ETA (average 30 km/h in city)
    const etaMinutes = Math.max(1, Math.round((distanceKm / 30) * 60));

    // Generate conversion-focused reasons
    const reasons: string[] = [];
    if (distanceKm <= 2) reasons.push(`Очень близко (${distanceKm.toFixed(1)} км)`);
    else if (distanceKm <= 5) reasons.push(`Рядом (${distanceKm.toFixed(1)} км)`);
    else reasons.push(`${distanceKm.toFixed(1)} км от вас`);

    if (org.isVerified) reasons.push('Проверенный мастер');
    const rating = org.ratingAvg || 0;
    if (rating >= 4.5 && (org.reviewsCount || 0) >= 5) reasons.push(`Высокий рейтинг (${rating.toFixed(1)})`);
    const responseTime = org.avgResponseTimeMinutes || 0;
    if (responseTime > 0 && responseTime <= 15) reasons.push(`Быстро отвечает (≈${responseTime} мин)`);
    if (org.hasAvailableSlotsToday) reasons.push('Есть слот сегодня');
    if (org.isMobile) reasons.push('Выезд к вам');
    if (org.isPopular) reasons.push('Популярный');

    // Generate available slots (simulated based on current time)
    const now = new Date();
    const slots: string[] = [];
    const hasSlotsToday = org.hasAvailableSlotsToday !== false;

    if (hasSlotsToday) {
      const currentHour = now.getHours();
      // Generate slots from current hour + 1 to 19:00
      for (let h = Math.max(currentHour + 1, 9); h <= 19; h += 2) {
        const slotDate = new Date(now);
        slotDate.setHours(h, 0, 0, 0);
        slots.push(slotDate.toISOString());
        // Add half-hour slot
        if (h + 1 <= 19) {
          const halfSlot = new Date(now);
          halfSlot.setHours(h, 30, 0, 0);
          slots.push(halfSlot.toISOString());
        }
      }
    }

    // If no slots today, generate tomorrow slots
    if (slots.length === 0) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      for (let h = 9; h <= 19; h += 2) {
        const slotDate = new Date(tomorrow);
        slotDate.setHours(h, 0, 0, 0);
        slots.push(slotDate.toISOString());
      }
    }

    // Determine pin type based on source and verification
    let pinType: 'verified' | 'popular' | 'mobile' | 'standard' | 'admin' | 'unverified' = 'standard';
    const locationSource = org.locationSource || 'auto';
    const isLocationVerified = org.isLocationVerified || false;
    
    // Priority: source type > business badges
    if (locationSource === 'auto' && !isLocationVerified) {
      pinType = 'unverified'; // Автоматически найденные, не проверенные
    } else if (locationSource === 'admin') {
      pinType = 'admin'; // Добавлены админом
    } else if (org.isVerified && isLocationVerified) {
      pinType = 'verified'; // Мастер верифицирован + адрес проверен
    } else if (org.isPopular) {
      pinType = 'popular';
    } else if (org.isMobile) {
      pinType = 'mobile';
    }

    // Calculate matching score
    let matchingScore = 40;
    if (distanceKm <= 2) matchingScore += 25;
    else if (distanceKm <= 5) matchingScore += 20;
    else if (distanceKm <= 10) matchingScore += 12;
    else matchingScore += 5;
    matchingScore += Math.round((org.visibilityScore || 0) * 0.20);
    if (rating >= 4.5) matchingScore += 15;
    else if (rating >= 4.0) matchingScore += 10;
    if (responseTime > 0 && responseTime <= 10) matchingScore += 10;
    else if (responseTime <= 20) matchingScore += 6;
    // Boost verified locations
    if (isLocationVerified) matchingScore += 10;
    matchingScore = Math.min(100, matchingScore);

    return {
      provider: {
        id: String(org._id),
        name: org.name || 'Мастер',
        description: org.description || '',
        lat: provLat,
        lng: provLng,
        address: org.address || '',
        rating: org.ratingAvg || 0,
        reviewsCount: org.reviewsCount || 0,
        isVerified: org.isVerified || false,
        isPopular: org.isPopular || false,
        isMobile: org.isMobile || false,
        hasAvailableSlotsToday: hasSlotsToday,
        avgResponseTimeMinutes: org.avgResponseTimeMinutes || 0,
        visibilityScore: org.visibilityScore || 0,
        matchingScore,
        specializations: org.specializations || [],
        pinType,
        bookingsCount: org.bookingsCount || 0,
        completedBookingsCount: org.completedBookingsCount || 0,
        // Location source info
        locationSource,
        isLocationVerified,
      },
      distanceKm: Math.round(distanceKm * 10) / 10,
      etaMinutes,
      reasons: reasons.slice(0, 5),
      availableSlots: slots.slice(0, 8),
      hasSlotsToday,
      nextAvailableSlot: slots[0] || null,
    };
  }

  /**
   * GET nearby providers sorted by visibility + matching score
   */
  async getNearbyProviders(query: NearbyQuery): Promise<MapProvider[]> {
    const { lat, lng, radiusKm, limit, filter } = query;

    this.logger.log(`getNearbyProviders: lat=${lat}, lng=${lng}, radius=${radiusKm}km`);

    let providers: any[];
    try {
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: radiusKm * 1000,
          },
        },
      }).limit(limit * 2).lean();
      this.logger.log(`Geo query found: ${providers.length} providers`);
    } catch (err) {
      this.logger.warn(`Geo query failed: ${err.message}, falling back`);
      // Fallback without geo
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
      }).sort({ visibilityScore: -1 }).limit(limit * 2).lean();
      this.logger.log(`Fallback query found: ${providers.length} providers`);
    }

    let mapped = providers.map(p => this.toMapProvider(p, lat, lng));
    mapped = this.applyFilter(mapped, filter);
    mapped = this.sortByDecisionScore(mapped);

    return mapped.slice(0, limit);
  }

  /**
   * GET providers in viewport bounding box
   */
  async getViewportProviders(query: ViewportQuery): Promise<MapProvider[]> {
    const { swLat, swLng, neLat, neLng, filter } = query;

    let providers: any[];
    try {
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
        location: {
          $geoWithin: {
            $box: [
              [swLng, swLat],
              [neLng, neLat],
            ],
          },
        },
      }).limit(50).lean();
    } catch {
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
      }).limit(50).lean();
    }

    const centerLat = (swLat + neLat) / 2;
    const centerLng = (swLng + neLng) / 2;

    let mapped = providers.map(p => this.toMapProvider(p, centerLat, centerLng));
    mapped = this.applyFilter(mapped, filter);
    mapped = this.sortByDecisionScore(mapped);

    return mapped;
  }

  /**
   * Matching providers — Decision Layer
   * "Кто мне сейчас лучше всего подходит?"
   */
  async getMatchingProviders(query: MatchingQuery): Promise<MapProvider[]> {
    const { lat, lng, urgency, limit } = query;

    let providers: any[];
    try {
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: 20000, // 20km
          },
        },
      }).limit(30).lean();
    } catch {
      providers = await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
      }).sort({ visibilityScore: -1 }).limit(30).lean();
    }

    let mapped = providers.map(p => {
      const mp = this.toMapProvider(p, lat, lng);
      // Boost matching score based on urgency
      if (urgency === 'high') {
        if (mp.avgResponseTimeMinutes <= 10) mp.matchingScore += 15;
        if (mp.hasAvailableSlotsToday) mp.matchingScore += 10;
        if (mp.isMobile) mp.matchingScore += 5;
      }
      mp.matchingScore = Math.min(100, mp.matchingScore);
      return mp;
    });

    // Sort by matching score (Decision Layer priority)
    mapped.sort((a, b) => b.matchingScore - a.matchingScore);

    return mapped.slice(0, limit);
  }

  /**
   * Transform DB entity to MapProvider DTO
   */
  private toMapProvider(org: any, userLat: number, userLng: number): MapProvider {
    const provLat = org.location?.coordinates?.[1] || 0;
    const provLng = org.location?.coordinates?.[0] || 0;
    const distanceKm = this.haversine(userLat, userLng, provLat, provLng);

    // Calculate matching score based on multiple factors
    let matchingScore = 40; // base
    
    // Distance factor (0-25 points)
    if (distanceKm <= 2) matchingScore += 25;
    else if (distanceKm <= 5) matchingScore += 20;
    else if (distanceKm <= 10) matchingScore += 12;
    else matchingScore += 5;

    // Visibility factor (0-20 points)
    matchingScore += Math.round((org.visibilityScore || 0) * 0.20);

    // Rating factor (0-15 points)
    const rating = org.ratingAvg || 0;
    if (rating >= 4.5) matchingScore += 15;
    else if (rating >= 4.0) matchingScore += 10;
    else if (rating >= 3.5) matchingScore += 5;

    // Speed factor (0-10 points)
    const responseTime = org.avgResponseTimeMinutes || 60;
    if (responseTime <= 10) matchingScore += 10;
    else if (responseTime <= 20) matchingScore += 6;
    else if (responseTime <= 30) matchingScore += 3;

    matchingScore = Math.min(100, matchingScore);

    // Generate reasons
    const reasons: string[] = [];
    if (distanceKm <= 3) reasons.push(`Рядом (${distanceKm.toFixed(1)} км)`);
    if (org.isVerified) reasons.push('Проверенный мастер');
    if (responseTime <= 15) reasons.push(`Быстрый ответ (≈${responseTime} мин)`);
    if (rating >= 4.5 && (org.reviewsCount || 0) >= 5) reasons.push(`Рейтинг ${rating.toFixed(1)}`);
    if (org.hasAvailableSlotsToday) reasons.push('Есть слоты сегодня');
    if (org.isMobile) reasons.push('Выезд к вам');
    if (org.isPopular) reasons.push('Популярный');

    // Determine pin type based on source and verification
    let pinType: 'verified' | 'popular' | 'mobile' | 'standard' | 'admin' | 'unverified' = 'standard';
    const locationSource = org.locationSource || 'auto';
    const isLocationVerified = org.isLocationVerified || false;
    
    if (locationSource === 'auto' && !isLocationVerified) {
      pinType = 'unverified';
    } else if (locationSource === 'admin') {
      pinType = 'admin';
    } else if (org.isVerified && isLocationVerified) {
      pinType = 'verified';
    } else if (org.isPopular) {
      pinType = 'popular';
    } else if (org.isMobile) {
      pinType = 'mobile';
    }

    return {
      id: String(org._id),
      name: org.name || 'Мастер',
      lat: provLat,
      lng: provLng,
      distanceKm: Math.round(distanceKm * 10) / 10,
      rating: org.ratingAvg || 0,
      reviewsCount: org.reviewsCount || 0,
      isVerified: org.isVerified || false,
      isPopular: org.isPopular || false,
      isMobile: org.isMobile || false,
      hasAvailableSlotsToday: org.hasAvailableSlotsToday || false,
      avgResponseTimeMinutes: org.avgResponseTimeMinutes || 0,
      visibilityScore: org.visibilityScore || 0,
      matchingScore,
      specializations: org.specializations || [],
      reasons: reasons.slice(0, 4),
      pinType,
      locationSource,
      isLocationVerified,
    };
  }

  /**
   * Apply filter to providers
   */
  private applyFilter(providers: MapProvider[], filter?: MapFilter): MapProvider[] {
    if (!filter || filter === 'all') return providers;
    switch (filter) {
      case 'today': return providers.filter(p => p.hasAvailableSlotsToday);
      case 'fast': return providers.filter(p => p.avgResponseTimeMinutes > 0 && p.avgResponseTimeMinutes <= 15);
      case 'verified': return providers.filter(p => p.isVerified);
      case 'mobile': return providers.filter(p => p.isMobile);
      default: return providers;
    }
  }

  /**
   * Sort by decision score = matchingScore (primary) + visibilityScore (secondary)
   */
  private sortByDecisionScore(providers: MapProvider[]): MapProvider[] {
    return providers.sort((a, b) => {
      const scoreA = a.matchingScore * 0.7 + a.visibilityScore * 0.3;
      const scoreB = b.matchingScore * 0.7 + b.visibilityScore * 0.3;
      return scoreB - scoreA;
    });
  }

  /**
   * Haversine distance in km
   */
  private haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
    if (!lat2 || !lng2) return 999;
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
}
