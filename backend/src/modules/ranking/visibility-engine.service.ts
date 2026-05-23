import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * 🔥 VISIBILITY ENGINE
 * 
 * Визначає видимість провайдера у пошуку.
 * Це ядро розподілу попиту на платформі.
 * 
 * visibilityScore визначає:
 * - хто попадає в топ видачі
 * - хто отримує більше заявок
 * - хто "глушиться" за порушення
 * 
 * Формула:
 * visibilityScore = rankScore*0.35 + responseSpeed*0.15 + completion*0.15 
 *                 + repeat*0.10 + freshness*0.05 + trust*0.10 + boost*0.10 - penalties
 */

export enum VisibilityState {
  NORMAL = 'NORMAL',
  BOOSTED = 'BOOSTED',
  LIMITED = 'LIMITED',           // Soft limit
  SHADOW_LIMITED = 'SHADOW_LIMITED', // Hard limit
  SUSPENDED = 'SUSPENDED',
}

export interface VisibilityResult {
  score: number;
  state: VisibilityState;
  components: VisibilityComponents;
  penalties: VisibilityPenalty[];
}

export interface VisibilityComponents {
  rankScore: number;
  responseSpeedScore: number;
  completionScore: number;
  repeatScore: number;
  freshnessScore: number;
  trustScore: number;
  boostScore: number;
  penaltyScore: number;
}

export interface VisibilityPenalty {
  type: string;
  value: number;
  reason: string;
}

@Injectable()
export class VisibilityEngineService {
  private readonly logger = new Logger(VisibilityEngineService.name);

  // Weights for score calculation
  private readonly WEIGHTS = {
    rank: 0.35,
    responseSpeed: 0.15,
    completion: 0.15,
    repeat: 0.10,
    freshness: 0.05,
    trust: 0.10,
    boost: 0.10,
  };

  // Shadow limit thresholds
  private readonly SHADOW_LIMIT_THRESHOLDS = {
    suspiciousScore: 7,
    cancellationRate: 0.4,
    disputesCount: 5,
  };

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('VisibilityLog') private readonly visibilityLogModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * 🔥 ГОЛОВНИЙ МЕТОД: Розрахувати visibility score
   */
  async calculateVisibility(providerId: string): Promise<VisibilityResult> {
    const provider: any = await this.orgModel.findById(providerId).lean();
    if (!provider) {
      return this.emptyResult();
    }

    // === КОМПОНЕНТИ SCORE ===

    // 1. Rank Score (0-100)
    const rankScore = Math.min(100, provider.rankScore || 0);

    // 2. Response Speed Score (0-100)
    const avgResponseTime = provider.avgResponseTimeMinutes || 60;
    const responseSpeedScore = 
      avgResponseTime <= 10 ? 100 :
      avgResponseTime <= 20 ? 85 :
      avgResponseTime <= 30 ? 70 :
      avgResponseTime <= 60 ? 50 : 20;

    // 3. Completion Score (0-100)
    const completedBookings = provider.completedBookingsCount || 0;
    const totalBookings = provider.bookingsCount || 1;
    const completionRate = totalBookings > 0 ? completedBookings / totalBookings : 0;
    const completionScore = Math.min(100, Math.round(completionRate * 100));

    // 4. Repeat Score (0-100)
    const repeatRate = provider.repeatBookingRate || 0;
    const repeatScore = Math.min(100, Math.round(repeatRate * 200)); // 50% repeat = 100 score

    // 5. Freshness Score (0-100) 
    const bookingsLast30Days = provider.bookingsLast30Days || 0;
    const freshnessScore = bookingsLast30Days > 0 ? 100 : 
      this.daysSinceLastActive(provider) < 7 ? 70 : 30;

    // 6. Trust Score (0-100)
    let trustScore = 100;
    if (!provider.isVerified) trustScore -= 20;
    trustScore -= (provider.disputesCount || 0) * 10;
    trustScore -= (provider.suspiciousScore || 0) * 8;
    trustScore = Math.max(0, trustScore);

    // 7. Boost Score (0-100)
    const isBoosted = provider.isBoosted && 
      provider.boostUntil && 
      new Date(provider.boostUntil) > new Date();
    const boostScore = isBoosted ? 100 : 0;

    // === PENALTIES ===
    const penalties: VisibilityPenalty[] = [];
    let penaltyScore = 0;

    // Cancellation penalty
    const cancellationRate = 1 - completionRate;
    if (cancellationRate > 0.2) {
      const penalty = Math.round(cancellationRate * 40);
      penalties.push({
        type: 'high_cancellation',
        value: penalty,
        reason: `Cancellation rate: ${(cancellationRate * 100).toFixed(0)}%`,
      });
      penaltyScore += penalty;
    }

    // Suspicious penalty
    const suspiciousScore = provider.suspiciousScore || 0;
    if (suspiciousScore > 0) {
      const penalty = suspiciousScore * 10;
      penalties.push({
        type: 'suspicious_behavior',
        value: penalty,
        reason: `Suspicious score: ${suspiciousScore}`,
      });
      penaltyScore += penalty;
    }

    // Dispute penalty
    if ((provider.disputesCount || 0) > 2) {
      const penalty = provider.disputesCount * 8;
      penalties.push({
        type: 'disputes',
        value: penalty,
        reason: `${provider.disputesCount} disputes`,
      });
      penaltyScore += penalty;
    }

    // Shadow limited penalty
    if (provider.isShadowBanned || provider.isShadowLimited) {
      penalties.push({
        type: 'shadow_limited',
        value: 50,
        reason: 'Account shadow limited',
      });
      penaltyScore += 50;
    }

    // === РОЗРАХУНОК ФІНАЛЬНОГО SCORE ===
    const score = Math.max(0, Math.round(
      rankScore * this.WEIGHTS.rank +
      responseSpeedScore * this.WEIGHTS.responseSpeed +
      completionScore * this.WEIGHTS.completion +
      repeatScore * this.WEIGHTS.repeat +
      freshnessScore * this.WEIGHTS.freshness +
      trustScore * this.WEIGHTS.trust +
      boostScore * this.WEIGHTS.boost -
      penaltyScore
    ));

    // === ВИЗНАЧЕННЯ STATE ===
    let state = VisibilityState.NORMAL;
    
    if (provider.status === 'suspended') {
      state = VisibilityState.SUSPENDED;
    } else if (
      provider.isShadowBanned || 
      suspiciousScore >= this.SHADOW_LIMIT_THRESHOLDS.suspiciousScore ||
      cancellationRate >= this.SHADOW_LIMIT_THRESHOLDS.cancellationRate ||
      (provider.disputesCount || 0) >= this.SHADOW_LIMIT_THRESHOLDS.disputesCount
    ) {
      state = VisibilityState.SHADOW_LIMITED;
    } else if (penaltyScore > 20) {
      state = VisibilityState.LIMITED;
    } else if (isBoosted) {
      state = VisibilityState.BOOSTED;
    }

    return {
      score,
      state,
      components: {
        rankScore,
        responseSpeedScore,
        completionScore,
        repeatScore,
        freshnessScore,
        trustScore,
        boostScore,
        penaltyScore,
      },
      penalties,
    };
  }

  /**
   * Оновити visibility score в БД
   */
  async updateVisibilityScore(providerId: string, reason: string): Promise<number> {
    const result = await this.calculateVisibility(providerId);
    const provider: any = await this.orgModel.findById(providerId);
    
    if (!provider) return 0;

    const oldScore = provider.visibilityScore || 0;
    
    // Update provider
    provider.visibilityScore = result.score;
    provider.visibilityState = result.state;
    provider.isShadowLimited = result.state === VisibilityState.SHADOW_LIMITED;
    await provider.save();

    // Log change
    if (oldScore !== result.score) {
      await this.logVisibilityChange(providerId, oldScore, result.score, reason);
    }

    this.logger.log(`Visibility updated for ${providerId}: ${oldScore} -> ${result.score} (${reason})`);
    
    return result.score;
  }

  /**
   * Пересчитать visibility для всех провайдеров
   */
  async recalculateAll(): Promise<{ updated: number; errors: number }> {
    const orgs = await this.orgModel.find({ status: 'active' }).lean();
    let updated = 0;
    let errors = 0;

    for (const org of orgs) {
      try {
        await this.updateVisibilityScore(String(org._id), 'periodic_recalculation');
        updated++;
      } catch (err) {
        errors++;
        this.logger.error(`Failed to update visibility for ${org._id}: ${err.message}`);
      }
    }

    return { updated, errors };
  }

  /**
   * Оновити після завершення booking
   */
  async updateAfterBooking(providerId: string, bookingStatus: string): Promise<void> {
    await this.updateVisibilityScore(providerId, `booking_${bookingStatus}`);
  }

  /**
   * Оновити після отримання review
   */
  async updateAfterReview(providerId: string, rating: number): Promise<void> {
    await this.updateVisibilityScore(providerId, `review_${rating}`);
  }

  /**
   * Оновити після відкриття/закриття dispute
   */
  async updateAfterDispute(providerId: string, opened: boolean): Promise<void> {
    await this.updateVisibilityScore(providerId, opened ? 'dispute_opened' : 'dispute_resolved');
  }

  /**
   * Застосувати boost
   */
  async applyBoost(providerId: string, durationDays: number): Promise<void> {
    const boostUntil = new Date();
    boostUntil.setDate(boostUntil.getDate() + durationDays);

    await this.orgModel.findByIdAndUpdate(providerId, {
      $set: {
        isBoosted: true,
        boostUntil,
      },
    });

    await this.updateVisibilityScore(providerId, 'boost_applied');
    
    this.eventBus.emit(PlatformEvent.ORGANIZATION_VERIFIED, {
      organizationId: providerId,
      type: 'boost_applied',
      expiresAt: boostUntil,
    });
  }

  /**
   * Зняти boost
   */
  async removeBoost(providerId: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(providerId, {
      $set: {
        isBoosted: false,
        boostUntil: null,
      },
    });

    await this.updateVisibilityScore(providerId, 'boost_expired');
  }

  /**
   * Shadow limit провайдера (admin)
   */
  async shadowLimit(providerId: string, reason: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(providerId, {
      $set: {
        isShadowLimited: true,
        shadowLimitedAt: new Date(),
        shadowLimitReason: reason,
      },
    });

    await this.updateVisibilityScore(providerId, `shadow_limited: ${reason}`);

    this.eventBus.emit(PlatformEvent.ORGANIZATION_SHADOW_BANNED, {
      organizationId: providerId,
      reason,
    });
  }

  /**
   * Зняти shadow limit (admin)
   */
  async removeShadowLimit(providerId: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(providerId, {
      $set: {
        isShadowLimited: false,
        isShadowBanned: false,
        shadowLimitedAt: null,
        shadowLimitReason: null,
        shadowBannedAt: null,
        shadowBanReason: null,
      },
    });

    await this.updateVisibilityScore(providerId, 'shadow_limit_removed');
  }

  /**
   * Отримати провайдерів для пошуку, відсортованих за visibility
   */
  async getProvidersForSearch(filters: any = {}, limit = 50): Promise<any[]> {
    const query: any = {
      status: 'active',
      visibilityState: { $ne: VisibilityState.SUSPENDED },
    };

    // Exclude shadow limited from top results
    if (!filters.includeHidden) {
      query.isShadowLimited = { $ne: true };
      query.isShadowBanned = { $ne: true };
    }

    // Apply other filters
    if (filters.categoryId) {
      query['services.categoryId'] = filters.categoryId;
    }

    return this.orgModel
      .find(query)
      .sort({ visibilityScore: -1, rankScore: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Отримати explanation для провайдера
   */
  async getVisibilityExplanation(providerId: string): Promise<{
    score: number;
    state: VisibilityState;
    rank: string;
    factors: { name: string; score: number; status: 'good' | 'warning' | 'bad' }[];
    tips: string[];
    penalties: VisibilityPenalty[];
  }> {
    const result = await this.calculateVisibility(providerId);
    const provider: any = await this.orgModel.findById(providerId).lean();

    const factors = [
      {
        name: 'Рейтинг',
        score: result.components.rankScore,
        status: result.components.rankScore >= 70 ? 'good' : result.components.rankScore >= 40 ? 'warning' : 'bad',
      },
      {
        name: 'Скорость ответа',
        score: result.components.responseSpeedScore,
        status: result.components.responseSpeedScore >= 70 ? 'good' : result.components.responseSpeedScore >= 40 ? 'warning' : 'bad',
      },
      {
        name: 'Завершённые заказы',
        score: result.components.completionScore,
        status: result.components.completionScore >= 80 ? 'good' : result.components.completionScore >= 50 ? 'warning' : 'bad',
      },
      {
        name: 'Повторные клиенты',
        score: result.components.repeatScore,
        status: result.components.repeatScore >= 50 ? 'good' : result.components.repeatScore >= 20 ? 'warning' : 'bad',
      },
      {
        name: 'Доверие',
        score: result.components.trustScore,
        status: result.components.trustScore >= 80 ? 'good' : result.components.trustScore >= 50 ? 'warning' : 'bad',
      },
    ] as { name: string; score: number; status: 'good' | 'warning' | 'bad' }[];

    // Determine rank
    let rank = 'Стандарт';
    if (result.score >= 80) rank = 'Топ';
    else if (result.score >= 60) rank = 'Выше среднего';
    else if (result.score >= 40) rank = 'Средний';
    else if (result.score >= 20) rank = 'Ниже среднего';
    else rank = 'Низкий';

    // Generate tips
    const tips: string[] = [];
    
    if (result.components.responseSpeedScore < 70) {
      tips.push('Отвечайте на заявки быстрее 10 минут');
    }
    if (result.components.completionScore < 80) {
      tips.push('Завершайте больше заказов через платформу');
    }
    if (result.components.repeatScore < 30) {
      tips.push('Предлагайте скидки для повторных клиентов');
    }
    if (result.components.trustScore < 80) {
      if (!provider?.isVerified) {
        tips.push('Пройдите верификацию профиля');
      }
      tips.push('Избегайте споров и жалоб');
    }
    if (result.state === VisibilityState.SHADOW_LIMITED) {
      tips.push('⚠️ Ваш профиль ограничен. Обратитесь в поддержку.');
    }

    return {
      score: result.score,
      state: result.state,
      rank,
      factors,
      tips,
      penalties: result.penalties,
    };
  }

  /**
   * Логування змін visibility
   */
  private async logVisibilityChange(
    providerId: string,
    oldScore: number,
    newScore: number,
    reason: string,
  ): Promise<void> {
    try {
      await this.visibilityLogModel.create({
        providerId,
        oldScore,
        newScore,
        reason,
        createdAt: new Date(),
      });
    } catch (err) {
      this.logger.error(`Failed to log visibility change: ${err.message}`);
    }
  }

  private daysSinceLastActive(provider: any): number {
    if (!provider.updatedAt) return 999;
    const diff = Date.now() - new Date(provider.updatedAt).getTime();
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  }

  private emptyResult(): VisibilityResult {
    return {
      score: 0,
      state: VisibilityState.SUSPENDED,
      components: {
        rankScore: 0,
        responseSpeedScore: 0,
        completionScore: 0,
        repeatScore: 0,
        freshnessScore: 0,
        trustScore: 0,
        boostScore: 0,
        penaltyScore: 0,
      },
      penalties: [],
    };
  }
}
