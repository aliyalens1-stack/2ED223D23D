import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

/**
 * 🧠 SMART MATCHING ENGINE
 * 
 * Розумний підбір виконавців під конкретний кейс користувача.
 * Не просто список - а "ми підібрали найкращих для вас".
 * 
 * Формула matchingScore:
 * serviceFit*0.30 + geoFit*0.20 + availabilityFit*0.15 + trustFit*0.15 + speedFit*0.10 + priceFit*0.05 + repeatFit*0.05
 */

export interface MatchingInput {
  customerId?: string;
  serviceId?: string;
  serviceCategoryId?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  lat: number;
  lng: number;
  urgency?: 'low' | 'medium' | 'high';
  budgetFrom?: number;
  budgetTo?: number;
  mobileRequired?: boolean;
  preferredProviderId?: string;
}

export interface MatchResult {
  providerId: string;
  name: string;
  matchingScore: number;
  reasons: string[];
  distanceKm: number;
  rating: number;
  isVerified: boolean;
  isPopular: boolean;
  isMobile: boolean;
  hasAvailableSlotsToday: boolean;
  priceFrom?: number;
  avgResponseTimeMinutes?: number;
  visibilityScore: number;
  lat: number;
  lng: number;
}

@Injectable()
export class SmartMatchingService {
  private readonly logger = new Logger(SmartMatchingService.name);

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Service') private readonly serviceModel: Model<any>,
    @InjectModel('MatchingLog') private readonly matchingLogModel: Model<any>,
  ) {}

  /**
   * 🔥 Головний метод: знайти найкращих провайдерів
   */
  async findTopMatches(input: MatchingInput, limit = 3): Promise<MatchResult[]> {
    // Отримуємо всіх активних провайдерів поблизу
    const providers = await this.getNearbyProviders(input.lat, input.lng, 20); // 20 km radius

    // Рахуємо score для кожного
    const scoredProviders: (MatchResult & { _score: number })[] = [];

    for (const provider of providers) {
      const result = await this.calculateMatchingScore(input, provider);
      if (result._score > 30) { // Minimum threshold
        scoredProviders.push(result);
      }
    }

    // Сортуємо за score
    scoredProviders.sort((a, b) => b._score - a._score);

    // Логуємо результат
    if (input.customerId) {
      await this.logMatching(input, scoredProviders.slice(0, limit));
    }

    return scoredProviders.slice(0, limit);
  }

  /**
   * Розрахунок matching score
   */
  private async calculateMatchingScore(
    input: MatchingInput,
    provider: any,
  ): Promise<MatchResult & { _score: number }> {
    const reasons: string[] = [];
    
    // === SERVICE FIT (30%) ===
    let serviceFit = 50; // default
    if (input.serviceId) {
      const hasExactService = provider.services?.some(
        (s: any) => String(s.serviceId) === String(input.serviceId)
      );
      if (hasExactService) {
        serviceFit = 100;
        reasons.push('Точное совпадение услуги');
      } else if (input.serviceCategoryId) {
        const hasCategoryService = provider.services?.some(
          (s: any) => String(s.categoryId) === String(input.serviceCategoryId)
        );
        if (hasCategoryService) {
          serviceFit = 70;
          reasons.push('Работает с этой категорией');
        }
      }
    }

    // === GEO FIT (20%) ===
    const distanceKm = this.calculateDistance(
      input.lat, input.lng,
      provider.location?.coordinates?.[1] || 0,
      provider.location?.coordinates?.[0] || 0,
    );
    
    let geoFit = 40;
    if (distanceKm <= 2) {
      geoFit = 100;
      reasons.push(`Очень близко (${distanceKm.toFixed(1)} км)`);
    } else if (distanceKm <= 5) {
      geoFit = 85;
      reasons.push(`Рядом (${distanceKm.toFixed(1)} км)`);
    } else if (distanceKm <= 10) {
      geoFit = 70;
    }

    // Mobile provider bonus
    if (input.mobileRequired && provider.isMobile) {
      geoFit = 95;
      reasons.push('Выезд к вам');
    }

    // === AVAILABILITY FIT (15%) ===
    let availabilityFit = 30;
    if (provider.hasAvailableSlotsToday) {
      availabilityFit = 100;
      reasons.push('Есть слот сегодня');
    } else if (provider.bookingsLast30Days > 0) {
      availabilityFit = 60;
    }

    // Urgency boost
    if (input.urgency === 'high' && provider.avgResponseTimeMinutes <= 10) {
      availabilityFit += 20;
      reasons.push('Быстрый ответ для срочных кейсов');
    }

    // === TRUST FIT (15%) ===
    let trustFit = 50;
    if (provider.isVerified) {
      trustFit += 25;
      reasons.push('Проверенный мастер');
    }
    if ((provider.ratingAvg || 0) >= 4.5 && (provider.reviewsCount || 0) >= 5) {
      trustFit += 25;
      reasons.push(`Высокий рейтинг (${provider.ratingAvg?.toFixed(1)})`);
    }
    trustFit -= (provider.disputesCount || 0) * 10;
    trustFit -= (provider.suspiciousScore || 0) * 5;
    trustFit = Math.max(0, Math.min(100, trustFit));

    // === SPEED FIT (10%) ===
    const responseTime = provider.avgResponseTimeMinutes || 60;
    let speedFit = 30;
    if (responseTime <= 10) {
      speedFit = 100;
      if (!reasons.some(r => r.includes('Быстрый'))) {
        reasons.push('Быстрый ответ');
      }
    } else if (responseTime <= 30) {
      speedFit = 70;
    } else if (responseTime <= 60) {
      speedFit = 50;
    }

    // === PRICE FIT (5%) ===
    let priceFit = 60;
    const providerMinPrice = provider.services?.[0]?.priceFrom || 0;
    if (input.budgetTo && providerMinPrice > 0) {
      if (providerMinPrice <= input.budgetTo) {
        priceFit = 90;
      } else {
        priceFit = 30;
      }
    }

    // === REPEAT FIT (5%) ===
    let repeatFit = 0;
    if (input.preferredProviderId && String(provider._id) === input.preferredProviderId) {
      repeatFit = 100;
      reasons.push('Вы уже работали с этим мастером');
    } else if (input.customerId) {
      const previousBooking = await this.bookingModel.findOne({
        userId: new Types.ObjectId(input.customerId),
        organizationId: provider._id,
        status: 'completed',
      }).lean();
      if (previousBooking) {
        repeatFit = 80;
        reasons.push('Вы уже работали с этим мастером');
      }
    }

    // === FINAL SCORE ===
    const score = Math.round(
      serviceFit * 0.30 +
      geoFit * 0.20 +
      availabilityFit * 0.15 +
      trustFit * 0.15 +
      speedFit * 0.10 +
      priceFit * 0.05 +
      repeatFit * 0.05
    );

    // Popular badge
    if (provider.isPopular) {
      reasons.push('Популярный');
    }

    return {
      providerId: String(provider._id),
      name: provider.name,
      matchingScore: score,
      reasons: reasons.slice(0, 4), // Max 4 reasons
      distanceKm: Math.round(distanceKm * 10) / 10,
      rating: provider.ratingAvg || 0,
      isVerified: provider.isVerified || false,
      isPopular: provider.isPopular || false,
      isMobile: provider.isMobile || false,
      hasAvailableSlotsToday: provider.hasAvailableSlotsToday || false,
      priceFrom: providerMinPrice,
      avgResponseTimeMinutes: responseTime,
      visibilityScore: provider.visibilityScore || 0,
      lat: provider.location?.coordinates?.[1] || 0,
      lng: provider.location?.coordinates?.[0] || 0,
      _score: score,
    };
  }

  /**
   * Отримати провайдерів поблизу
   */
  private async getNearbyProviders(lat: number, lng: number, radiusKm: number): Promise<any[]> {
    // Якщо є geo index
    try {
      return await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: radiusKm * 1000,
          },
        },
      }).limit(50).lean();
    } catch {
      // Fallback: simple query without geo
      return await this.orgModel.find({
        status: 'active',
        isShadowBanned: { $ne: true },
        isShadowLimited: { $ne: true },
      }).limit(50).lean();
    }
  }

  /**
   * Haversine formula для відстані
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    if (!lat2 || !lng2) return 999;
    
    const R = 6371; // Earth radius in km
    const dLat = this.toRad(lat2 - lat1);
    const dLng = this.toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  /**
   * Логування matching результатів
   */
  private async logMatching(input: MatchingInput, results: MatchResult[]): Promise<void> {
    try {
      await this.matchingLogModel.create({
        customerId: input.customerId,
        serviceId: input.serviceId,
        lat: input.lat,
        lng: input.lng,
        results: results.map(r => ({
          providerId: r.providerId,
          score: r.matchingScore,
          reasons: r.reasons,
        })),
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to log matching: ${err.message}`);
    }
  }

  /**
   * Match для конкретної заявки (quote)
   */
  async matchForQuote(quoteId: string): Promise<MatchResult[]> {
    // В реальному випадку тут отримуємо quote з БД
    // та витягуємо serviceId, location тощо
    // Зараз повертаємо пустий масив як заглушку
    return [];
  }

  /**
   * Repeat match - знайти попереднього хорошого провайдера
   */
  async findRepeatMatch(customerId: string, serviceId?: string): Promise<MatchResult | null> {
    const lastGoodBooking: any = await this.bookingModel.findOne({
      userId: new Types.ObjectId(customerId),
      status: 'completed',
      ...(serviceId && { 'snapshot.serviceId': serviceId }),
    }).sort({ completedAt: -1 }).lean();

    if (!lastGoodBooking) return null;

    const provider: any = await this.orgModel.findById(lastGoodBooking.organizationId).lean();
    if (!provider || provider.status !== 'active') return null;

    return {
      providerId: String(provider._id),
      name: provider.name,
      matchingScore: 95,
      reasons: ['Вы уже работали с этим мастером', 'Предыдущий заказ успешно завершён'],
      distanceKm: 0,
      rating: provider.ratingAvg || 0,
      isVerified: provider.isVerified || false,
      isPopular: provider.isPopular || false,
      isMobile: provider.isMobile || false,
      hasAvailableSlotsToday: provider.hasAvailableSlotsToday || false,
      visibilityScore: provider.visibilityScore || 0,
      lat: provider.location?.coordinates?.[1] || 0,
      lng: provider.location?.coordinates?.[0] || 0,
    };
  }
}
