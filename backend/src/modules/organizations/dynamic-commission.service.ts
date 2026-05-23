import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProviderType } from './organization.schema';

/**
 * 🟡 DYNAMIC COMMISSION SERVICE
 * 
 * Calculates variable commission based on:
 * - Provider type (new, active, established)
 * - Loyalty tier (higher tier = lower commission)
 * - Boost status (boosted = higher commission)
 * - Repeat booking rate
 * 
 * Commission Formula:
 * commission = BASE - loyaltyDiscount + boostPremium
 * 
 * Ranges:
 * - New providers: 10%
 * - Active providers: 15%
 * - Established: 12%
 * - Boosted: +5%
 * - High repeat rate: -3%
 * - Custom override: always used if set
 */
@Injectable()
export class DynamicCommissionService {
  private readonly logger = new Logger(DynamicCommissionService.name);

  // Base commission rates by provider type
  private readonly BASE_RATES: Record<ProviderType, number> = {
    [ProviderType.NEW]: 10,        // Low to attract new providers
    [ProviderType.ACTIVE]: 15,     // Standard rate
    [ProviderType.ESTABLISHED]: 12, // Reward for loyalty
  };

  // Thresholds for provider type
  private readonly NEW_THRESHOLD = 5;       // < 5 bookings = new
  private readonly ESTABLISHED_THRESHOLD = 50; // > 50 bookings = established

  // Loyalty tier discounts (%)
  private readonly LOYALTY_DISCOUNTS = [0, 0.5, 1, 1.5, 2, 2.5]; // Tiers 0-5

  // Other modifiers
  private readonly BOOST_PREMIUM = 5;       // Boosted providers pay more
  private readonly HIGH_REPEAT_DISCOUNT = 3; // High repeat rate = discount
  private readonly HIGH_REPEAT_THRESHOLD = 0.3; // > 30% repeat rate

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
  ) {}

  /**
   * Calculate commission rate for a provider
   */
  async calculateCommissionRate(organizationId: string): Promise<{
    rate: number;
    breakdown: {
      base: number;
      loyaltyDiscount: number;
      boostPremium: number;
      repeatDiscount: number;
      customOverride: number | null;
    };
    providerType: ProviderType;
  }> {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) {
      return {
        rate: 15, // Default
        breakdown: { base: 15, loyaltyDiscount: 0, boostPremium: 0, repeatDiscount: 0, customOverride: null },
        providerType: ProviderType.NEW,
      };
    }

    // Check for custom override first
    if (org.customCommissionPercent !== null && org.customCommissionPercent !== undefined) {
      return {
        rate: org.customCommissionPercent,
        breakdown: {
          base: org.customCommissionPercent,
          loyaltyDiscount: 0,
          boostPremium: 0,
          repeatDiscount: 0,
          customOverride: org.customCommissionPercent,
        },
        providerType: org.providerType || ProviderType.NEW,
      };
    }

    // Determine provider type
    const completedBookings = org.completedBookingsCount || 0;
    let providerType: ProviderType;
    
    if (completedBookings < this.NEW_THRESHOLD) {
      providerType = ProviderType.NEW;
    } else if (completedBookings >= this.ESTABLISHED_THRESHOLD) {
      providerType = ProviderType.ESTABLISHED;
    } else {
      providerType = ProviderType.ACTIVE;
    }

    // Base rate
    const base = this.BASE_RATES[providerType];

    // Loyalty discount
    const loyaltyTier = Math.min(org.loyaltyTier || 0, 5);
    const loyaltyDiscount = this.LOYALTY_DISCOUNTS[loyaltyTier];

    // Boost premium
    const isBoosted = org.isBoosted && org.boostUntil && new Date(org.boostUntil) > new Date();
    const boostPremium = isBoosted ? this.BOOST_PREMIUM : 0;

    // Repeat rate discount
    const repeatRate = org.repeatBookingRate || 0;
    const repeatDiscount = repeatRate >= this.HIGH_REPEAT_THRESHOLD ? this.HIGH_REPEAT_DISCOUNT : 0;

    // Calculate final rate
    const rate = Math.max(5, base - loyaltyDiscount + boostPremium - repeatDiscount);

    return {
      rate: Math.round(rate * 10) / 10, // Round to 1 decimal
      breakdown: {
        base,
        loyaltyDiscount,
        boostPremium,
        repeatDiscount,
        customOverride: null,
      },
      providerType,
    };
  }

  /**
   * Get commission amount for a booking
   */
  async calculateCommissionAmount(
    organizationId: string,
    bookingAmount: number,
  ): Promise<{
    amount: number;
    rate: number;
    providerAmount: number;
  }> {
    const { rate } = await this.calculateCommissionRate(organizationId);
    const amount = Math.round(bookingAmount * (rate / 100));
    const providerAmount = bookingAmount - amount;

    return { amount, rate, providerAmount };
  }

  /**
   * Update provider type based on bookings
   */
  async updateProviderType(organizationId: string): Promise<ProviderType> {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) return ProviderType.NEW;

    const completedBookings = org.completedBookingsCount || 0;
    let newType: ProviderType;

    if (completedBookings < this.NEW_THRESHOLD) {
      newType = ProviderType.NEW;
    } else if (completedBookings >= this.ESTABLISHED_THRESHOLD) {
      newType = ProviderType.ESTABLISHED;
    } else {
      newType = ProviderType.ACTIVE;
    }

    if (newType !== org.providerType) {
      await this.orgModel.findByIdAndUpdate(organizationId, {
        $set: { providerType: newType },
      });
      this.logger.log(`Provider ${organizationId} type updated: ${org.providerType} -> ${newType}`);
    }

    return newType;
  }

  /**
   * Update loyalty tier based on total fees paid
   */
  async updateLoyaltyTier(organizationId: string): Promise<number> {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) return 0;

    const totalFees = org.totalPlatformFeesPaid || 0;

    // Loyalty tiers based on total fees paid
    // Tier 0: < $100
    // Tier 1: $100-500
    // Tier 2: $500-1000
    // Tier 3: $1000-5000
    // Tier 4: $5000-10000
    // Tier 5: $10000+
    let newTier = 0;
    if (totalFees >= 10000) newTier = 5;
    else if (totalFees >= 5000) newTier = 4;
    else if (totalFees >= 1000) newTier = 3;
    else if (totalFees >= 500) newTier = 2;
    else if (totalFees >= 100) newTier = 1;

    if (newTier !== (org.loyaltyTier || 0)) {
      await this.orgModel.findByIdAndUpdate(organizationId, {
        $set: { loyaltyTier: newTier },
      });
      this.logger.log(`Provider ${organizationId} loyalty tier updated: ${org.loyaltyTier || 0} -> ${newTier}`);
    }

    return newTier;
  }

  /**
   * Update repeat booking rate
   */
  async updateRepeatBookingRate(organizationId: string): Promise<number> {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) return 0;

    // Count unique customers
    const uniqueCustomers = await this.bookingModel.distinct('userId', {
      organizationId: new Types.ObjectId(organizationId),
      status: 'completed',
    });

    // Count repeat customers (>1 booking)
    const repeatCustomers = await this.bookingModel.aggregate([
      {
        $match: {
          organizationId: new Types.ObjectId(organizationId),
          status: 'completed',
        },
      },
      {
        $group: {
          _id: '$userId',
          count: { $sum: 1 },
        },
      },
      {
        $match: { count: { $gt: 1 } },
      },
    ]);

    const repeatRate = uniqueCustomers.length > 0
      ? repeatCustomers.length / uniqueCustomers.length
      : 0;

    await this.orgModel.findByIdAndUpdate(organizationId, {
      $set: { repeatBookingRate: Math.round(repeatRate * 100) / 100 },
    });

    return repeatRate;
  }

  /**
   * Set custom commission override (admin)
   */
  async setCustomCommission(organizationId: string, percent: number | null): Promise<void> {
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $set: { customCommissionPercent: percent },
    });
    this.logger.log(`Custom commission set for ${organizationId}: ${percent}%`);
  }

  /**
   * Track fee payment and update loyalty
   */
  async trackFeePaid(organizationId: string, feeAmount: number): Promise<void> {
    await this.orgModel.findByIdAndUpdate(organizationId, {
      $inc: { totalPlatformFeesPaid: feeAmount },
    });

    // Update loyalty tier
    await this.updateLoyaltyTier(organizationId);
  }

  /**
   * Get commission report for all providers (admin)
   */
  async getCommissionReport(): Promise<{
    byType: Record<ProviderType, { count: number; avgRate: number }>;
    totalProviders: number;
    avgCommission: number;
  }> {
    const orgs = await this.orgModel.find().lean();
    
    const byType: Record<ProviderType, { count: number; totalRate: number }> = {
      [ProviderType.NEW]: { count: 0, totalRate: 0 },
      [ProviderType.ACTIVE]: { count: 0, totalRate: 0 },
      [ProviderType.ESTABLISHED]: { count: 0, totalRate: 0 },
    };

    let totalRate = 0;

    for (const org of orgs) {
      const { rate, providerType } = await this.calculateCommissionRate(String(org._id));
      byType[providerType].count++;
      byType[providerType].totalRate += rate;
      totalRate += rate;
    }

    return {
      byType: {
        [ProviderType.NEW]: {
          count: byType[ProviderType.NEW].count,
          avgRate: byType[ProviderType.NEW].count > 0
            ? Math.round(byType[ProviderType.NEW].totalRate / byType[ProviderType.NEW].count * 10) / 10
            : 10,
        },
        [ProviderType.ACTIVE]: {
          count: byType[ProviderType.ACTIVE].count,
          avgRate: byType[ProviderType.ACTIVE].count > 0
            ? Math.round(byType[ProviderType.ACTIVE].totalRate / byType[ProviderType.ACTIVE].count * 10) / 10
            : 15,
        },
        [ProviderType.ESTABLISHED]: {
          count: byType[ProviderType.ESTABLISHED].count,
          avgRate: byType[ProviderType.ESTABLISHED].count > 0
            ? Math.round(byType[ProviderType.ESTABLISHED].totalRate / byType[ProviderType.ESTABLISHED].count * 10) / 10
            : 12,
        },
      },
      totalProviders: orgs.length,
      avgCommission: orgs.length > 0 ? Math.round(totalRate / orgs.length * 10) / 10 : 15,
    };
  }
}
