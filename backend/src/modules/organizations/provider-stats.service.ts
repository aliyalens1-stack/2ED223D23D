import { Injectable, Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';

/**
 * 🔥 PROVIDER STATS SERVICE
 * 
 * Generates pressure metrics for providers:
 * - Missed requests
 * - Health score
 * - Nearby opportunities
 * - Commission breakdown
 * - Boost status
 */

export interface ProviderPressureStats {
  // Missed requests pressure
  missedRequests: {
    today: number;
    thisWeek: number;
    reasons: string[];
  };
  
  // Health score (0-100)
  healthScore: {
    score: number;
    breakdown: {
      responseSpeed: { score: number; label: string };
      rating: { score: number; label: string };
      completionRate: { score: number; label: string };
      activityLevel: { score: number; label: string };
    };
    positives: string[];
    negatives: string[];
  };
  
  // Nearby opportunities (FOMO)
  nearbyOpportunities: {
    todayCount: number;
    potentialRevenue: number;
  };
  
  // Commission info
  commission: {
    currentRate: number;
    breakdown: {
      base: number;
      loyaltyDiscount: number;
      ratingBonus: number;
      responseBonus: number;
      missedPenalty: number;
    };
    nextGoal: { rate: number; description: string };
    tips: string[];
  };
  
  // Boost status
  boost: {
    isActive: boolean;
    expiresAt: Date | null;
    currentPlan: string | null;
    extraLeadsPercent: number;
  };
  
  // Summary
  summary: {
    moneyLostToday: number;
    potentialWithBoost: number;
    urgentActions: string[];
  };
}

export interface BoostPlan {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  duration: number; // days
  extraLeadsPercent: number;
  multiplier: number;
  benefits: string[];
  popular?: boolean;
}

@Injectable()
export class ProviderStatsService {
  private readonly logger = new Logger(ProviderStatsService.name);

  // Boost plans
  readonly BOOST_PLANS: BoostPlan[] = [
    {
      id: 'basic',
      name: 'Basic',
      description: '+30% заявок',
      price: 49,
      currency: 'USD',
      duration: 30,
      extraLeadsPercent: 30,
      multiplier: 1.3,
      benefits: [
        'Приоритет в поиске',
        '+30% заявок',
        'Badge "Продвигается"',
      ],
    },
    {
      id: 'pro',
      name: 'Pro',
      description: '+70% заявок',
      price: 99,
      currency: 'USD',
      duration: 30,
      extraLeadsPercent: 70,
      multiplier: 1.7,
      benefits: [
        'Всё из Basic',
        '+70% заявок',
        'Топ в Quick Request',
        'Выделение на карте',
      ],
      popular: true,
    },
    {
      id: 'premium',
      name: 'Premium',
      description: 'Максимум заявок',
      price: 199,
      currency: 'USD',
      duration: 30,
      extraLeadsPercent: 150,
      multiplier: 2.5,
      benefits: [
        'Всё из Pro',
        'Первый в выдаче',
        'Push для клиентов',
        'Личный менеджер',
        'Аналитика конкурентов',
      ],
    },
  ];

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
  ) {}

  /**
   * Get full pressure stats for provider
   */
  async getProviderPressureStats(organizationId: string): Promise<ProviderPressureStats> {
    const org = await this.orgModel.findById(organizationId).lean();
    if (!org) {
      throw new Error('Organization not found');
    }

    // Get all stats in parallel
    const [
      missedRequests,
      healthScore,
      nearbyOpportunities,
      commission,
      boost,
    ] = await Promise.all([
      this.getMissedRequests(organizationId),
      this.calculateHealthScore(org),
      this.getNearbyOpportunities(organizationId),
      this.getCommissionBreakdown(org),
      this.getBoostStatus(org),
    ]);

    // Generate summary
    const avgOrderValue = 150; // Average order value
    const moneyLostToday = missedRequests.today * avgOrderValue * 0.5; // Estimated 50% conversion
    const potentialWithBoost = moneyLostToday * 2.5;

    const urgentActions: string[] = [];
    if (missedRequests.today > 3) {
      urgentActions.push('Вы теряете заказы — включите уведомления');
    }
    if (healthScore.score < 60) {
      urgentActions.push('Низкий рейтинг влияет на позицию');
    }
    if (!boost.isActive && nearbyOpportunities.todayCount > 5) {
      urgentActions.push('Активируйте boost для получения большего количества заявок');
    }

    return {
      missedRequests,
      healthScore,
      nearbyOpportunities,
      commission,
      boost,
      summary: {
        moneyLostToday: Math.round(moneyLostToday),
        potentialWithBoost: Math.round(potentialWithBoost),
        urgentActions,
      },
    };
  }

  /**
   * Get missed requests stats
   */
  private async getMissedRequests(organizationId: string): Promise<ProviderPressureStats['missedRequests']> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    // Get branches for this org
    const branches = await this.branchModel.find({ 
      organizationId: new Types.ObjectId(organizationId),
      status: 'active',
    }).lean();

    if (branches.length === 0) {
      return { today: 0, thisWeek: 0, reasons: [] };
    }

    const branchIds = branches.map((b: any) => b._id);

    // Count quotes that were sent nearby but provider didn't respond
    const todayMissed = await this.quoteModel.countDocuments({
      createdAt: { $gte: todayStart },
      status: { $in: ['pending', 'expired', 'cancelled'] },
      // Provider didn't respond (no quote response from this org)
      'responses.organizationId': { $ne: new Types.ObjectId(organizationId) },
    });

    const weekMissed = await this.quoteModel.countDocuments({
      createdAt: { $gte: weekStart },
      status: { $in: ['pending', 'expired', 'cancelled'] },
      'responses.organizationId': { $ne: new Types.ObjectId(organizationId) },
    });

    // Generate reasons based on org stats
    const org = await this.orgModel.findById(organizationId).lean();
    const reasons: string[] = [];

    if ((org as any)?.avgResponseTimeMinutes > 15) {
      reasons.push('Медленные ответы на заявки');
    }
    if ((org as any)?.ratingAvg < 4.0) {
      reasons.push('Рейтинг ниже среднего');
    }
    if (!(org as any)?.isBoosted) {
      reasons.push('Нет активного продвижения');
    }
    if (reasons.length === 0) {
      reasons.push('Конкуренты отвечают быстрее');
    }

    return {
      today: Math.min(todayMissed, 15), // Cap for realism
      thisWeek: Math.min(weekMissed, 50),
      reasons,
    };
  }

  /**
   * Calculate health score
   */
  private async calculateHealthScore(org: any): Promise<ProviderPressureStats['healthScore']> {
    const breakdown = {
      responseSpeed: { score: 0, label: '' },
      rating: { score: 0, label: '' },
      completionRate: { score: 0, label: '' },
      activityLevel: { score: 0, label: '' },
    };

    const positives: string[] = [];
    const negatives: string[] = [];

    // Response speed (0-25 points)
    const responseTime = org.avgResponseTimeMinutes || 30;
    if (responseTime <= 5) {
      breakdown.responseSpeed = { score: 25, label: 'Отлично' };
      positives.push('Быстрые ответы');
    } else if (responseTime <= 15) {
      breakdown.responseSpeed = { score: 20, label: 'Хорошо' };
    } else if (responseTime <= 30) {
      breakdown.responseSpeed = { score: 12, label: 'Средне' };
      negatives.push('Медленные ответы');
    } else {
      breakdown.responseSpeed = { score: 5, label: 'Плохо' };
      negatives.push('Очень медленные ответы');
    }

    // Rating (0-25 points)
    const rating = org.ratingAvg || 3.5;
    if (rating >= 4.5) {
      breakdown.rating = { score: 25, label: 'Отлично' };
      positives.push('Высокий рейтинг');
    } else if (rating >= 4.0) {
      breakdown.rating = { score: 20, label: 'Хорошо' };
    } else if (rating >= 3.5) {
      breakdown.rating = { score: 12, label: 'Средне' };
    } else {
      breakdown.rating = { score: 5, label: 'Плохо' };
      negatives.push('Низкий рейтинг');
    }

    // Completion rate (0-25 points)
    const completedBookings = org.completedBookingsCount || 0;
    const totalBookings = completedBookings + (org.cancelledBookingsCount || 0);
    const completionRate = totalBookings > 0 ? completedBookings / totalBookings : 1;
    
    if (completionRate >= 0.95) {
      breakdown.completionRate = { score: 25, label: 'Отлично' };
      positives.push('Высокий % выполнения');
    } else if (completionRate >= 0.85) {
      breakdown.completionRate = { score: 18, label: 'Хорошо' };
    } else if (completionRate >= 0.7) {
      breakdown.completionRate = { score: 10, label: 'Средне' };
      negatives.push('Много отмен');
    } else {
      breakdown.completionRate = { score: 5, label: 'Плохо' };
      negatives.push('Много отмененных заказов');
    }

    // Activity level (0-25 points)
    const quotesResponded = org.quotesRespondedCount || 0;
    if (quotesResponded >= 50) {
      breakdown.activityLevel = { score: 25, label: 'Отлично' };
      positives.push('Активный участник');
    } else if (quotesResponded >= 20) {
      breakdown.activityLevel = { score: 18, label: 'Хорошо' };
    } else if (quotesResponded >= 5) {
      breakdown.activityLevel = { score: 10, label: 'Средне' };
    } else {
      breakdown.activityLevel = { score: 5, label: 'Начинающий' };
      negatives.push('Низкая активность');
    }

    const score = breakdown.responseSpeed.score + 
                  breakdown.rating.score + 
                  breakdown.completionRate.score + 
                  breakdown.activityLevel.score;

    return {
      score,
      breakdown,
      positives,
      negatives,
    };
  }

  /**
   * Get nearby opportunities
   */
  private async getNearbyOpportunities(organizationId: string): Promise<ProviderPressureStats['nearbyOpportunities']> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Count active quotes in the area
    const todayQuotes = await this.quoteModel.countDocuments({
      createdAt: { $gte: todayStart },
      status: { $in: ['pending', 'active'] },
    });

    // Estimate potential revenue
    const avgOrderValue = 150;
    const conversionRate = 0.3;

    return {
      todayCount: todayQuotes,
      potentialRevenue: Math.round(todayQuotes * avgOrderValue * conversionRate),
    };
  }

  /**
   * Get commission breakdown
   */
  private async getCommissionBreakdown(org: any): Promise<ProviderPressureStats['commission']> {
    // Base rate
    let base = 15;
    const completedBookings = org.completedBookingsCount || 0;
    if (completedBookings < 5) base = 10;
    else if (completedBookings >= 50) base = 12;

    // Calculate modifiers
    const loyaltyDiscount = Math.min((org.loyaltyTier || 0) * 0.5, 2.5);
    
    const rating = org.ratingAvg || 3.5;
    const ratingBonus = rating >= 4.5 ? 2 : rating >= 4.0 ? 1 : 0;
    
    const responseTime = org.avgResponseTimeMinutes || 30;
    const responseBonus = responseTime <= 10 ? 1 : 0;
    
    const missedPenalty = Math.min((org.missedQuotesCount || 0) * 0.1, 2);

    const currentRate = Math.max(8, base - loyaltyDiscount - ratingBonus - responseBonus + missedPenalty);

    // Determine next goal
    let nextGoal = { rate: currentRate - 1, description: 'Отвечайте быстрее' };
    if (currentRate > 12) {
      nextGoal = { rate: 12, description: 'Повысьте рейтинг до 4.5' };
    } else if (currentRate > 10) {
      nextGoal = { rate: 10, description: 'Достигните 50+ заказов' };
    }

    // Tips
    const tips: string[] = [];
    if (rating < 4.5) tips.push('Повысьте рейтинг для снижения комиссии');
    if (responseTime > 10) tips.push('Отвечайте быстрее на заявки');
    if (completedBookings < 50) tips.push('Выполните больше заказов для перехода в категорию "Established"');

    return {
      currentRate: Math.round(currentRate * 10) / 10,
      breakdown: {
        base,
        loyaltyDiscount,
        ratingBonus,
        responseBonus,
        missedPenalty,
      },
      nextGoal,
      tips,
    };
  }

  /**
   * Get boost status
   */
  private async getBoostStatus(org: any): Promise<ProviderPressureStats['boost']> {
    const isActive = org.isBoosted && org.boostUntil && new Date(org.boostUntil) > new Date();
    
    let currentPlan: string | null = null;
    let extraLeadsPercent = 0;
    
    if (isActive) {
      const multiplier = org.boostMultiplier || 1;
      if (multiplier >= 2.5) {
        currentPlan = 'premium';
        extraLeadsPercent = 150;
      } else if (multiplier >= 1.7) {
        currentPlan = 'pro';
        extraLeadsPercent = 70;
      } else {
        currentPlan = 'basic';
        extraLeadsPercent = 30;
      }
    }

    return {
      isActive,
      expiresAt: isActive ? org.boostUntil : null,
      currentPlan,
      extraLeadsPercent,
    };
  }

  /**
   * Get available boost plans
   */
  getBoostPlans(): BoostPlan[] {
    return this.BOOST_PLANS;
  }

  /**
   * Activate boost for organization
   */
  async activateBoost(organizationId: string, planId: string): Promise<{
    success: boolean;
    boost: ProviderPressureStats['boost'];
    message: string;
  }> {
    const plan = this.BOOST_PLANS.find(p => p.id === planId);
    if (!plan) {
      return { success: false, boost: null as any, message: 'План не найден' };
    }

    const boostUntil = new Date();
    boostUntil.setDate(boostUntil.getDate() + plan.duration);

    await this.orgModel.findByIdAndUpdate(organizationId, {
      $set: {
        isBoosted: true,
        boostUntil,
        boostMultiplier: plan.multiplier,
        boostPlanId: plan.id,
      },
    });

    this.logger.log(`Boost activated for ${organizationId}: ${plan.name}`);

    return {
      success: true,
      boost: {
        isActive: true,
        expiresAt: boostUntil,
        currentPlan: plan.id,
        extraLeadsPercent: plan.extraLeadsPercent,
      },
      message: `${plan.name} план активирован до ${boostUntil.toLocaleDateString()}`,
    };
  }
}
