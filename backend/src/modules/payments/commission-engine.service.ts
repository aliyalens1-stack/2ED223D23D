import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ProviderType } from '../organizations/organization.schema';

/**
 * 🔥 COMMISSION ENGINE
 * 
 * Центральний двигун економіки платформи.
 * Розраховує комісію на основі поведінки провайдера.
 * 
 * Формула:
 * commission = BASE - loyaltyDiscount + boostPremium - repeatDiscount + suspiciousPenalty
 * 
 * Діапазон: 5% - 25%
 */

export interface CommissionInput {
  providerId: string;
  bookingId?: string;
  amount: number;
  isRepeatCustomer?: boolean;
}

export interface CommissionResult {
  rate: number;           // Final rate (0.05 - 0.25)
  ratePercent: number;    // Final rate as percent (5 - 25)
  platformFee: number;    // Amount for platform
  providerAmount: number; // Amount for provider
  log: CommissionLog;     // Detailed breakdown
}

export interface CommissionLog {
  base: number;
  modifiers: CommissionModifier[];
  final: number;
  providerId: string;
  bookingId?: string;
  calculatedAt: Date;
}

export interface CommissionModifier {
  name: string;
  value: number;
  reason: string;
}

@Injectable()
export class CommissionEngineService {
  private readonly logger = new Logger(CommissionEngineService.name);

  // Commission constraints
  private readonly MIN_RATE = 0.05;  // 5%
  private readonly MAX_RATE = 0.25;  // 25%

  // Base rates by provider type
  private readonly BASE_RATES: Record<ProviderType, number> = {
    [ProviderType.NEW]: 0.10,        // 10% - приваблюємо нових
    [ProviderType.ACTIVE]: 0.15,     // 15% - стандарт
    [ProviderType.ESTABLISHED]: 0.12, // 12% - нагорода за лояльність
  };

  // Modifiers
  private readonly REPEAT_DISCOUNT = 0.05;      // -5% для повторних клієнтів
  private readonly BOOST_PREMIUM = 0.05;        // +5% для boosted
  private readonly VERIFIED_DISCOUNT = 0.02;    // -2% для verified
  private readonly HIGH_RATING_DISCOUNT = 0.02; // -2% для рейтингу > 4.5
  private readonly SUSPICIOUS_PENALTY = 0.10;   // +10% для suspicious > 5
  private readonly FAST_RESPONSE_DISCOUNT = 0.02; // -2% для відповіді < 10 хв

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('CommissionLog') private readonly commissionLogModel: Model<any>,
  ) {}

  /**
   * 🔥 ГОЛОВНИЙ МЕТОД: Розрахувати комісію
   */
  async calculate(input: CommissionInput): Promise<CommissionResult> {
    const { providerId, bookingId, amount, isRepeatCustomer } = input;

    // Отримуємо провайдера
    const provider: any = await this.orgModel.findById(providerId).lean();
    if (!provider) {
      // Fallback до стандартної комісії
      return this.buildResult(amount, 0.15, [], providerId, bookingId);
    }

    // Визначаємо тип провайдера
    const completedBookings = provider.completedBookingsCount || 0;
    let providerType: ProviderType;
    
    if (completedBookings < 5) {
      providerType = ProviderType.NEW;
    } else if (completedBookings >= 50) {
      providerType = ProviderType.ESTABLISHED;
    } else {
      providerType = ProviderType.ACTIVE;
    }

    // === РОЗРАХУНОК ===
    const modifiers: CommissionModifier[] = [];
    let rate = this.BASE_RATES[providerType];

    modifiers.push({
      name: 'base',
      value: rate,
      reason: `Provider type: ${providerType} (${completedBookings} bookings)`,
    });

    // 1. Repeat customer discount
    const isRepeat = isRepeatCustomer ?? await this.checkRepeatCustomer(providerId, bookingId);
    if (isRepeat) {
      rate -= this.REPEAT_DISCOUNT;
      modifiers.push({
        name: 'repeat_discount',
        value: -this.REPEAT_DISCOUNT,
        reason: 'Repeat customer bonus',
      });
    }

    // 2. Boost premium
    const isBoosted = provider.isBoosted && 
      provider.boostUntil && 
      new Date(provider.boostUntil) > new Date();
    
    if (isBoosted) {
      rate += this.BOOST_PREMIUM;
      modifiers.push({
        name: 'boost_premium',
        value: this.BOOST_PREMIUM,
        reason: 'Boosted profile active',
      });
    }

    // 3. Verified discount
    if (provider.isVerified) {
      rate -= this.VERIFIED_DISCOUNT;
      modifiers.push({
        name: 'verified_discount',
        value: -this.VERIFIED_DISCOUNT,
        reason: 'Verified provider',
      });
    }

    // 4. High rating discount
    if ((provider.ratingAvg || 0) >= 4.5 && (provider.reviewsCount || 0) >= 10) {
      rate -= this.HIGH_RATING_DISCOUNT;
      modifiers.push({
        name: 'high_rating_discount',
        value: -this.HIGH_RATING_DISCOUNT,
        reason: `High rating: ${provider.ratingAvg?.toFixed(1)}`,
      });
    }

    // 5. Fast response discount
    if ((provider.avgResponseTimeMinutes || Infinity) <= 10) {
      rate -= this.FAST_RESPONSE_DISCOUNT;
      modifiers.push({
        name: 'fast_response_discount',
        value: -this.FAST_RESPONSE_DISCOUNT,
        reason: `Fast response: ${provider.avgResponseTimeMinutes} min`,
      });
    }

    // 6. Suspicious penalty (⚠️ ВАЖЛИВО!)
    const suspiciousScore = provider.suspiciousScore || 0;
    if (suspiciousScore > 5) {
      rate += this.SUSPICIOUS_PENALTY;
      modifiers.push({
        name: 'suspicious_penalty',
        value: this.SUSPICIOUS_PENALTY,
        reason: `Suspicious score: ${suspiciousScore}`,
      });
    } else if (suspiciousScore > 3) {
      rate += this.SUSPICIOUS_PENALTY / 2;
      modifiers.push({
        name: 'suspicious_warning',
        value: this.SUSPICIOUS_PENALTY / 2,
        reason: `Suspicious warning: ${suspiciousScore}`,
      });
    }

    // 7. Custom override (admin)
    if (provider.customCommissionPercent !== null && provider.customCommissionPercent !== undefined) {
      rate = provider.customCommissionPercent / 100;
      modifiers.push({
        name: 'admin_override',
        value: rate,
        reason: `Admin set: ${provider.customCommissionPercent}%`,
      });
    }

    // Clamp to valid range
    const finalRate = Math.max(this.MIN_RATE, Math.min(this.MAX_RATE, rate));

    return this.buildResult(amount, finalRate, modifiers, providerId, bookingId);
  }

  /**
   * Побудувати результат з логом
   */
  private buildResult(
    amount: number,
    rate: number,
    modifiers: CommissionModifier[],
    providerId: string,
    bookingId?: string,
  ): CommissionResult {
    const platformFee = Math.round(amount * rate);
    const providerAmount = amount - platformFee;

    const log: CommissionLog = {
      base: modifiers.find(m => m.name === 'base')?.value || rate,
      modifiers,
      final: rate,
      providerId,
      bookingId,
      calculatedAt: new Date(),
    };

    return {
      rate,
      ratePercent: Math.round(rate * 100 * 10) / 10,
      platformFee,
      providerAmount,
      log,
    };
  }

  /**
   * Перевірка чи це повторний клієнт
   */
  private async checkRepeatCustomer(providerId: string, bookingId?: string): Promise<boolean> {
    if (!bookingId) return false;

    try {
      const booking: any = await this.bookingModel.findById(bookingId).lean();
      if (!booking) return false;

      // Шукаємо попередні completed bookings цього клієнта у цього провайдера
      const previousBookings = await this.bookingModel.countDocuments({
        organizationId: new Types.ObjectId(providerId),
        userId: booking.userId,
        status: 'completed',
        _id: { $ne: new Types.ObjectId(bookingId) },
      });

      return previousBookings > 0;
    } catch {
      return false;
    }
  }

  /**
   * Зберегти лог комісії в БД
   */
  async saveLog(log: CommissionLog, paymentId?: string): Promise<void> {
    try {
      await this.commissionLogModel.create({
        ...log,
        paymentId: paymentId ? new Types.ObjectId(paymentId) : undefined,
      });
    } catch (err) {
      this.logger.error(`Failed to save commission log: ${err.message}`);
    }
  }

  /**
   * Отримати історію комісій провайдера
   */
  async getProviderCommissionHistory(providerId: string, limit = 20): Promise<any[]> {
    return this.commissionLogModel
      .find({ providerId })
      .sort({ calculatedAt: -1 })
      .limit(limit)
      .lean();
  }

  /**
   * Отримати середню комісію провайдера
   */
  async getProviderAverageCommission(providerId: string): Promise<number> {
    const result = await this.commissionLogModel.aggregate([
      { $match: { providerId } },
      { $group: { _id: null, avgRate: { $avg: '$final' } } },
    ]);
    return result[0]?.avgRate || 0.15;
  }

  /**
   * Для UI провайдера: поясненя комісії
   */
  async getCommissionExplanation(providerId: string): Promise<{
    currentRate: number;
    factors: { name: string; impact: string; status: 'positive' | 'negative' | 'neutral' }[];
    tips: string[];
  }> {
    const result = await this.calculate({ providerId, amount: 1000 });
    
    const factors = result.log.modifiers.map(m => ({
      name: this.getModifierDisplayName(m.name),
      impact: m.value > 0 ? `+${(m.value * 100).toFixed(1)}%` : `${(m.value * 100).toFixed(1)}%`,
      status: m.value < 0 ? 'positive' as const : m.value > 0 && m.name !== 'base' ? 'negative' as const : 'neutral' as const,
    }));

    const tips: string[] = [];
    
    // Generate tips
    const provider: any = await this.orgModel.findById(providerId).lean();
    if (provider) {
      if (!provider.isVerified) {
        tips.push('Пройдите верификацию для снижения комиссии на 2%');
      }
      if ((provider.avgResponseTimeMinutes || 100) > 10) {
        tips.push('Отвечайте на заявки быстрее 10 минут для снижения комиссии на 2%');
      }
      if ((provider.ratingAvg || 0) < 4.5 || (provider.reviewsCount || 0) < 10) {
        tips.push('Получите 10+ отзывов с рейтингом 4.5+ для снижения комиссии');
      }
      if ((provider.suspiciousScore || 0) > 0) {
        tips.push('Завершайте заказы через платформу для снижения штрафа');
      }
    }

    return {
      currentRate: result.ratePercent,
      factors,
      tips,
    };
  }

  private getModifierDisplayName(name: string): string {
    const names: Record<string, string> = {
      base: 'Базовая ставка',
      repeat_discount: 'Повторный клиент',
      boost_premium: 'Продвижение активно',
      verified_discount: 'Верифицированный',
      high_rating_discount: 'Высокий рейтинг',
      fast_response_discount: 'Быстрый ответ',
      suspicious_penalty: 'Штраф за подозрительность',
      suspicious_warning: 'Предупреждение',
      admin_override: 'Установлено администратором',
    };
    return names[name] || name;
  }
}
