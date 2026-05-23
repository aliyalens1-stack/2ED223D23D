import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProviderType } from './organization.schema';

/**
 * 🔴 SUSPICIOUS DETECTION SERVICE
 * 
 * Detects and penalizes providers who might be bypassing the platform:
 * - High response rate but no bookings = taking clients offline
 * - High cancel rate by customers = bad service or price bait
 * - Low conversion rate over time = suspicious behavior
 * 
 * Actions:
 * - Reduce rankScore (soft penalty)
 * - Shadow ban (hard penalty - hidden from search)
 */
@Injectable()
export class SuspiciousDetectionService {
  private readonly logger = new Logger(SuspiciousDetectionService.name);

  // Thresholds
  private readonly MIN_RESPONSES_FOR_CHECK = 10; // Only check after 10 responses
  private readonly SUSPICIOUS_SCORE_THRESHOLD = 5; // Shadow ban after this
  private readonly LOW_CONVERSION_RATE = 0.05; // < 5% conversion is suspicious
  private readonly RANK_PENALTY_PERCENT = 0.3; // 30% rank reduction

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('QuoteResponse') private readonly quoteResponseModel: Model<any>,
  ) {}

  /**
   * Calculate suspicion score for a provider
   */
  async calculateSuspicionScore(organizationId: string): Promise<{
    score: number;
    reasons: string[];
    conversionRate: number;
  }> {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) return { score: 0, reasons: [], conversionRate: 0 };

    const reasons: string[] = [];
    let score = org.suspiciousScore || 0;

    // Get actual booking count from responses
    const responses = org.quotesRespondedCount || 0;
    const bookings = org.bookingsCount || 0;

    // Only check if provider has enough activity
    if (responses < this.MIN_RESPONSES_FOR_CHECK) {
      return { score, reasons, conversionRate: 0 };
    }

    // Calculate conversion rate
    const conversionRate = bookings / responses;

    // === Check 1: High responses, no bookings ===
    if (responses > 10 && bookings === 0) {
      score += 2;
      reasons.push(`High response rate (${responses}) but 0 bookings`);
    }

    // === Check 2: Very low conversion rate ===
    if (conversionRate < this.LOW_CONVERSION_RATE && responses > 20) {
      score += 1;
      reasons.push(`Very low conversion rate: ${(conversionRate * 100).toFixed(1)}%`);
    }

    // === Check 3: High customer cancellation rate ===
    const cancelledCount = org.cancelledByCustomerCount || 0;
    if (cancelledCount > 5 && cancelledCount / bookings > 0.3) {
      score += 1;
      reasons.push(`High customer cancellation rate: ${cancelledCount} cancellations`);
    }

    // === Check 4: Many disputes ===
    if ((org.disputesCount || 0) > 3) {
      score += 1;
      reasons.push(`High dispute count: ${org.disputesCount}`);
    }

    return { score, reasons, conversionRate };
  }

  /**
   * Run suspicion check and apply penalties
   */
  async checkAndPenalize(organizationId: string): Promise<{
    wasPenalized: boolean;
    isShadowBanned: boolean;
    newSuspiciousScore: number;
    reasons: string[];
  }> {
    const { score, reasons, conversionRate } = await this.calculateSuspicionScore(organizationId);
    
    const org: any = await this.orgModel.findById(organizationId);
    if (!org) {
      return { wasPenalized: false, isShadowBanned: false, newSuspiciousScore: 0, reasons: [] };
    }

    let wasPenalized = false;
    let isShadowBanned = org.isShadowBanned || false;

    // Update suspicion score
    if (score !== (org.suspiciousScore || 0)) {
      org.suspiciousScore = score;
      wasPenalized = true;
    }

    // Update conversion rate
    org.avgBookingConversionRate = conversionRate;
    org.lastSuspiciousCheck = new Date();

    // === Apply penalties ===

    // Soft penalty: reduce rank score
    if (score >= 3 && !org.isShadowBanned) {
      const penalty = Math.round(org.rankScore * this.RANK_PENALTY_PERCENT);
      org.rankScore = Math.max(0, org.rankScore - penalty);
      wasPenalized = true;
      this.logger.warn(`Provider ${organizationId} rank reduced by ${penalty} due to suspicious activity`);
    }

    // Hard penalty: shadow ban
    if (score >= this.SUSPICIOUS_SCORE_THRESHOLD && !org.isShadowBanned) {
      org.isShadowBanned = true;
      org.shadowBannedAt = new Date();
      org.shadowBanReason = reasons.join('; ');
      isShadowBanned = true;
      wasPenalized = true;
      this.logger.error(`Provider ${organizationId} SHADOW BANNED: ${reasons.join('; ')}`);
    }

    await org.save();

    return {
      wasPenalized,
      isShadowBanned,
      newSuspiciousScore: score,
      reasons,
    };
  }

  /**
   * Called when provider responds to a quote but booking is NOT created
   * (e.g., customer didn't select this provider)
   */
  async onResponseWithoutBooking(organizationId: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $inc: { responsesWithoutBooking: 1 },
    });
  }

  /**
   * Called when customer cancels after provider response
   */
  async onCustomerCancelled(organizationId: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $inc: { cancelledByCustomerCount: 1 },
    });

    // Trigger check
    await this.checkAndPenalize(organizationId);
  }

  /**
   * Remove shadow ban (admin action)
   */
  async removeShadowBan(organizationId: string): Promise<void> {
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $set: {
        isShadowBanned: false,
        shadowBannedAt: null,
        shadowBanReason: null,
        suspiciousScore: 0, // Reset
      },
    });
    this.logger.log(`Shadow ban removed for provider ${organizationId}`);
  }

  /**
   * Get all shadow-banned providers (admin)
   */
  async getShadowBannedProviders(): Promise<any[]> {
    return this.orgModel.find({ isShadowBanned: true }).lean();
  }

  /**
   * Run periodic check on all providers (cron job)
   */
  async runPeriodicCheck(): Promise<{ checked: number; penalized: number; shadowBanned: number }> {
    const orgs = await this.orgModel.find({
      quotesRespondedCount: { $gte: this.MIN_RESPONSES_FOR_CHECK },
      isShadowBanned: false,
    }).lean();

    let penalized = 0;
    let shadowBanned = 0;

    for (const org of orgs) {
      const result = await this.checkAndPenalize(String(org._id));
      if (result.wasPenalized) penalized++;
      if (result.isShadowBanned) shadowBanned++;
    }

    this.logger.log(`Periodic check: ${orgs.length} checked, ${penalized} penalized, ${shadowBanned} shadow-banned`);

    return { checked: orgs.length, penalized, shadowBanned };
  }
}
