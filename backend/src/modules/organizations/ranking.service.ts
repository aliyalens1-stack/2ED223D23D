import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

/**
 * Ranking Service
 * 
 * Calculates and updates organization rank scores based on:
 * - Rating (40%)
 * - Reviews count (20%)
 * - Completed bookings (20%)
 * - Response speed (20%)
 * 
 * Boost multiplier applied when organization is boosted
 */
@Injectable()
export class RankingService {
  // Weights for ranking formula
  private readonly WEIGHT_RATING = 0.4;
  private readonly WEIGHT_REVIEWS = 0.2;
  private readonly WEIGHT_BOOKINGS = 0.2;
  private readonly WEIGHT_RESPONSE = 0.2;

  // Max values for normalization
  private readonly MAX_REVIEWS = 100;
  private readonly MAX_BOOKINGS = 500;
  private readonly IDEAL_RESPONSE_MINUTES = 5; // 5 min = perfect score

  // Boost bonus
  private readonly BOOST_BONUS = 50;

  constructor(
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
  ) {}

  /**
   * Calculate rank score for an organization
   */
  calculateRankScore(org: any): number {
    // Rating component (0-5 scale -> 0-100)
    const ratingScore = ((org.ratingAvg || 0) / 5) * 100;

    // Reviews component (normalized to MAX_REVIEWS)
    const reviewsScore = Math.min((org.reviewsCount || 0) / this.MAX_REVIEWS, 1) * 100;

    // Bookings component (normalized to MAX_BOOKINGS)
    const bookingsScore = Math.min((org.completedBookingsCount || 0) / this.MAX_BOOKINGS, 1) * 100;

    // Response speed component (faster = better)
    let responseScore = 50; // Default middle score
    if (org.avgResponseTimeMinutes !== null && org.avgResponseTimeMinutes > 0) {
      // Perfect score at IDEAL_RESPONSE_MINUTES, decreases as time increases
      const speedFactor = Math.min(this.IDEAL_RESPONSE_MINUTES / org.avgResponseTimeMinutes, 1);
      responseScore = speedFactor * 100;
    }

    // Calculate weighted score
    let score = 
      (ratingScore * this.WEIGHT_RATING) +
      (reviewsScore * this.WEIGHT_REVIEWS) +
      (bookingsScore * this.WEIGHT_BOOKINGS) +
      (responseScore * this.WEIGHT_RESPONSE);

    // Apply boost bonus if active
    if (org.isBoosted && org.boostUntil && new Date(org.boostUntil) > new Date()) {
      score += this.BOOST_BONUS * (org.boostMultiplier || 1);
    }

    return Math.round(score * 10) / 10; // Round to 1 decimal
  }

  /**
   * Update rank score for a specific organization
   */
  async updateOrganizationRank(organizationId: string): Promise<number> {
    const org = await this.organizationModel.findById(organizationId).lean();
    if (!org) return 0;

    const rankScore = this.calculateRankScore(org);

    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $set: { rankScore },
    });

    return rankScore;
  }

  /**
   * Update response time metrics when a quote is responded
   */
  async updateResponseTime(
    organizationId: string,
    responseTimeMinutes: number,
  ): Promise<void> {
    const org: any = await this.organizationModel.findById(organizationId).lean();
    if (!org) return;

    // Calculate new average response time
    const currentTotal = (org.avgResponseTimeMinutes || 0) * (org.totalResponsesCount || 0);
    const newCount = (org.totalResponsesCount || 0) + 1;
    const newAvg = (currentTotal + responseTimeMinutes) / newCount;

    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $set: {
        avgResponseTimeMinutes: Math.round(newAvg * 10) / 10,
        totalResponsesCount: newCount,
      },
      $inc: { quotesRespondedCount: 1 },
    });

    // Recalculate rank
    await this.updateOrganizationRank(organizationId);
  }

  /**
   * Update when booking is completed
   */
  async onBookingCompleted(organizationId: string): Promise<void> {
    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $inc: { completedBookingsCount: 1 },
    });

    await this.updateOrganizationRank(organizationId);
  }

  /**
   * Update when review is created
   */
  async onReviewCreated(organizationId: string): Promise<void> {
    // Rating and reviewsCount are updated by ReviewsService
    // Just recalculate rank
    await this.updateOrganizationRank(organizationId);
  }

  /**
   * Activate boost for organization
   */
  async activateBoost(
    organizationId: string,
    durationDays: number = 7,
    multiplier: number = 1,
  ): Promise<any> {
    const boostUntil = new Date();
    boostUntil.setDate(boostUntil.getDate() + durationDays);

    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $set: {
        isBoosted: true,
        boostUntil,
        boostMultiplier: multiplier,
      },
    });

    // Recalculate rank with boost
    await this.updateOrganizationRank(organizationId);

    return { isBoosted: true, boostUntil, multiplier };
  }

  /**
   * Deactivate boost
   */
  async deactivateBoost(organizationId: string): Promise<void> {
    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $set: {
        isBoosted: false,
        boostUntil: null,
        boostMultiplier: 1,
      },
    });

    await this.updateOrganizationRank(organizationId);
  }

  /**
   * Check and deactivate expired boosts (run periodically)
   */
  async cleanupExpiredBoosts(): Promise<number> {
    const result = await this.organizationModel.updateMany(
      {
        isBoosted: true,
        boostUntil: { $lt: new Date() },
      },
      {
        $set: {
          isBoosted: false,
          boostUntil: null,
          boostMultiplier: 1,
        },
      },
    );

    return result.modifiedCount || 0;
  }

  /**
   * Recalculate all organization ranks
   */
  async recalculateAllRanks(): Promise<number> {
    const orgs = await this.organizationModel.find().lean();
    
    for (const org of orgs) {
      const rankScore = this.calculateRankScore(org);
      await this.organizationModel.findByIdAndUpdate(org._id, {
        $set: { rankScore },
      });
    }

    return orgs.length;
  }
}
