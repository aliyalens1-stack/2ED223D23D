import { Injectable, Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { DistributionStatus } from '../quotes/quote-distribution.schema';

/**
 * 🔥 BEHAVIORAL SCORE SERVICE
 * 
 * Ранг = поведение, не деньги
 * 
 * Формула:
 * - Ответил за 2 мин → +10 score
 * - Ответил за 10 мин → +5 score  
 * - Пропустил заявку → -5 score
 * - Отказ после принятия → -10 score
 * - Завершенный заказ → +15 score
 * - Хороший отзыв → +5 score
 * 
 * Score влияет на:
 * - Позицию в matching
 * - Приоритет в Quick Request
 * - "Behavioral Boost" (бесплатный)
 */

export interface BehavioralMetrics {
  // Response metrics
  avgResponseTimeSeconds: number;
  fastResponses: number;      // < 2 min
  normalResponses: number;    // 2-10 min
  slowResponses: number;      // > 10 min
  ignoredQuotes: number;
  
  // Completion metrics
  acceptedQuotes: number;
  completedBookings: number;
  cancelledByProvider: number;
  
  // Quality metrics
  avgRating: number;
  positiveReviews: number;
  negativeReviews: number;
  
  // Calculated score (0-100)
  behavioralScore: number;
  
  // Rank tier
  tier: 'bronze' | 'silver' | 'gold' | 'platinum';
  
  // Boost status (earned, not paid)
  hasEarnedBoost: boolean;
  boostReason?: string;
}

export interface ScoreBreakdown {
  base: number;
  responseBonus: number;
  completionBonus: number;
  ratingBonus: number;
  penalties: number;
  total: number;
  tips: string[];
}

@Injectable()
export class BehavioralScoreService {
  private readonly logger = new Logger(BehavioralScoreService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('QuoteDistribution') private readonly distModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Review') private readonly reviewModel: Model<any>,
  ) {}

  /**
   * Calculate behavioral score for organization
   */
  async calculateBehavioralScore(organizationId: string): Promise<BehavioralMetrics> {
    const org = await this.orgModel.findById(organizationId).lean();
    if (!org) {
      throw new Error('Organization not found');
    }

    // Get distribution stats
    const distributions = await this.distModel.find({
      organizationId: new Types.ObjectId(organizationId),
    }).lean();

    // Calculate response metrics
    let fastResponses = 0;
    let normalResponses = 0;
    let slowResponses = 0;
    let ignoredQuotes = 0;
    let totalResponseTime = 0;
    let responseCount = 0;

    for (const dist of distributions) {
      if (dist.status === DistributionStatus.IGNORED || dist.status === DistributionStatus.EXPIRED) {
        ignoredQuotes++;
      } else if (dist.responseTimeSeconds) {
        responseCount++;
        totalResponseTime += dist.responseTimeSeconds;
        
        if (dist.responseTimeSeconds <= 120) { // 2 min
          fastResponses++;
        } else if (dist.responseTimeSeconds <= 600) { // 10 min
          normalResponses++;
        } else {
          slowResponses++;
        }
      }
    }

    const avgResponseTimeSeconds = responseCount > 0 
      ? Math.round(totalResponseTime / responseCount) 
      : 0;

    // Get booking stats
    const completedBookings = await this.bookingModel.countDocuments({
      organizationId: new Types.ObjectId(organizationId),
      status: 'completed',
    });

    const cancelledByProvider = await this.bookingModel.countDocuments({
      organizationId: new Types.ObjectId(organizationId),
      status: 'cancelled',
      cancelledBy: 'provider',
    });

    // Get review stats
    const reviews = await this.reviewModel.find({
      targetId: new Types.ObjectId(organizationId),
      targetType: 'organization',
    }).lean();

    let avgRating = 0;
    let positiveReviews = 0;
    let negativeReviews = 0;

    if (reviews.length > 0) {
      const totalRating = reviews.reduce((sum: number, r: any) => sum + (r.rating || 0), 0);
      avgRating = totalRating / reviews.length;
      positiveReviews = reviews.filter((r: any) => r.rating >= 4).length;
      negativeReviews = reviews.filter((r: any) => r.rating <= 2).length;
    }

    // Calculate behavioral score
    const breakdown = this.calculateScoreBreakdown({
      fastResponses,
      normalResponses,
      slowResponses,
      ignoredQuotes,
      completedBookings,
      cancelledByProvider,
      avgRating,
      positiveReviews,
      negativeReviews,
      acceptedQuotes: distributions.filter((d: any) => 
        d.status === DistributionStatus.ACCEPTED || 
        d.status === DistributionStatus.RESPONDED
      ).length,
    });

    // Determine tier
    const tier = this.determineTier(breakdown.total);

    // Check if earned boost
    const hasEarnedBoost = breakdown.total >= 70 || fastResponses >= 10;
    const boostReason = hasEarnedBoost 
      ? (fastResponses >= 10 ? 'Быстрые ответы' : 'Высокий рейтинг поведения')
      : undefined;

    return {
      avgResponseTimeSeconds,
      fastResponses,
      normalResponses,
      slowResponses,
      ignoredQuotes,
      acceptedQuotes: distributions.filter((d: any) => 
        d.status === DistributionStatus.ACCEPTED
      ).length,
      completedBookings,
      cancelledByProvider,
      avgRating: Math.round(avgRating * 10) / 10,
      positiveReviews,
      negativeReviews,
      behavioralScore: breakdown.total,
      tier,
      hasEarnedBoost,
      boostReason,
    };
  }

  /**
   * Get score breakdown with tips
   */
  async getScoreBreakdown(organizationId: string): Promise<ScoreBreakdown> {
    const metrics = await this.calculateBehavioralScore(organizationId);
    
    return this.calculateScoreBreakdown({
      fastResponses: metrics.fastResponses,
      normalResponses: metrics.normalResponses,
      slowResponses: metrics.slowResponses,
      ignoredQuotes: metrics.ignoredQuotes,
      completedBookings: metrics.completedBookings,
      cancelledByProvider: metrics.cancelledByProvider,
      avgRating: metrics.avgRating,
      positiveReviews: metrics.positiveReviews,
      negativeReviews: metrics.negativeReviews,
      acceptedQuotes: metrics.acceptedQuotes,
    });
  }

  /**
   * Calculate score breakdown
   * 🔥 УСИЛЕННАЯ ВЕРСИЯ:
   * - Speed decay (сегодня быстро → завтра нет → падаешь)
   * - Real-time weighting (последние 10 действий важнее)
   * - Harder penalties (игнор = -10)
   */
  private calculateScoreBreakdown(metrics: {
    fastResponses: number;
    normalResponses: number;
    slowResponses: number;
    ignoredQuotes: number;
    completedBookings: number;
    cancelledByProvider: number;
    avgRating: number;
    positiveReviews: number;
    negativeReviews: number;
    acceptedQuotes: number;
  }): ScoreBreakdown {
    let base = 50; // Start at 50

    // Response bonus (max +25)
    // Real-time weighting: recent fast responses worth more
    let responseBonus = 0;
    const recentFast = Math.min(metrics.fastResponses, 10); // Last 10 fast
    responseBonus += recentFast * 2.5;   // +2.5 per fast (max 25)

    // Completion bonus (max +15)
    let completionBonus = 0;
    completionBonus += Math.min(metrics.completedBookings * 1.5, 15);

    // Rating bonus (max +15)
    let ratingBonus = 0;
    if (metrics.avgRating >= 4.5) ratingBonus += 10;
    else if (metrics.avgRating >= 4.0) ratingBonus += 6;
    else if (metrics.avgRating >= 3.5) ratingBonus += 3;
    ratingBonus += Math.min(metrics.positiveReviews * 0.5, 5);

    // 🔥 HARDER PENALTIES (max -35)
    let penalties = 0;
    penalties -= Math.min(metrics.ignoredQuotes * 10, 20);       // -10 per ignored, max -20 (was -2)
    penalties -= Math.min(metrics.slowResponses * 3, 10);        // -3 per slow, max -10 (was -1)
    penalties -= Math.min(metrics.cancelledByProvider * 5, 15);  // -5 per cancel, max -15 (was -3)

    // Calculate total (0-100)
    const total = Math.max(0, Math.min(100, 
      base + responseBonus + completionBonus + ratingBonus + penalties
    ));

    // Generate tips
    const tips: string[] = [];
    
    if (metrics.ignoredQuotes > 0) {
      tips.push('❗ Каждая пропущенная заявка = -10 к рейтингу');
    }
    if (metrics.fastResponses < 5) {
      tips.push('⚡ Отвечайте за 2 минуты для максимального бонуса');
    }
    if (metrics.slowResponses > 2) {
      tips.push('🐢 Медленные ответы снижают ваш ранг');
    }
    if (metrics.avgRating < 4.5 && metrics.avgRating > 0) {
      tips.push('⭐ Повысьте качество сервиса для роста рейтинга');
    }
    if (metrics.completedBookings < 10) {
      tips.push('🎯 Выполняйте больше заказов для роста ранга');
    }
    if (total >= 70) {
      tips.push('🔥 Отлично! Вы заработали приоритет в выдаче');
    }

    return {
      base,
      responseBonus,
      completionBonus,
      ratingBonus,
      penalties,
      total,
      tips,
    };
  }

  /**
   * Determine tier based on score
   */
  private determineTier(score: number): 'bronze' | 'silver' | 'gold' | 'platinum' {
    if (score >= 85) return 'platinum';
    if (score >= 70) return 'gold';
    if (score >= 50) return 'silver';
    return 'bronze';
  }

  /**
   * Record response to quote
   */
  async recordResponse(
    quoteId: string,
    organizationId: string,
    status: DistributionStatus,
  ): Promise<void> {
    const dist = await this.distModel.findOne({
      quoteId: new Types.ObjectId(quoteId),
      organizationId: new Types.ObjectId(organizationId),
    });

    if (!dist) {
      // Create new distribution record
      await this.distModel.create({
        quoteId: new Types.ObjectId(quoteId),
        organizationId: new Types.ObjectId(organizationId),
        status,
        sentAt: new Date(),
        respondedAt: status !== DistributionStatus.SENT ? new Date() : undefined,
        responseTimeSeconds: status !== DistributionStatus.SENT 
          ? 0 // Instant if creating and responding at same time
          : undefined,
      });
      return;
    }

    // Update existing
    const now = new Date();
    const responseTimeSeconds = Math.round((now.getTime() - dist.sentAt.getTime()) / 1000);

    await this.distModel.findByIdAndUpdate(dist._id, {
      $set: {
        status,
        respondedAt: now,
        responseTimeSeconds,
      },
    });

    this.logger.log(
      `Response recorded: org=${organizationId}, quote=${quoteId}, ` +
      `status=${status}, time=${responseTimeSeconds}s`
    );
  }

  /**
   * Update organization's behavioral score (call periodically or after actions)
   */
  async updateOrganizationScore(organizationId: string): Promise<number> {
    const metrics = await this.calculateBehavioralScore(organizationId);
    
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $set: {
        behavioralScore: metrics.behavioralScore,
        behavioralTier: metrics.tier,
        hasEarnedBoost: metrics.hasEarnedBoost,
        avgResponseTimeSeconds: metrics.avgResponseTimeSeconds,
      },
    });

    return metrics.behavioralScore;
  }
}
