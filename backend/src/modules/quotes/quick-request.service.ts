import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { QuickRequestDto, QuickServiceType } from './dto/quick-request.dto';
import { QuoteStatus } from '../../shared/enums';
import { EventBus, PlatformEvent } from '../../shared/events';

// Import AutoDistributionService (will be injected if available)
let AutoDistributionService: any = null;
try {
  AutoDistributionService = require('../provider-inbox/auto-distribution.service').AutoDistributionService;
} catch {}

/**
 * 🔥 QUICK REQUEST SERVICE
 * 
 * 1-tap заявка создания:
 * - Auto-create quote
 * - Auto-assign geo
 * - Auto-push to providers (AUTO-DISTRIBUTION!)
 * - Return instant matching
 */

// Mapping service types to service slugs
const SERVICE_TYPE_TO_SLUG: Record<QuickServiceType, string[]> = {
  [QuickServiceType.ENGINE_WONT_START]: ['engine-diagnostics', 'starter-repair', 'battery-replacement'],
  [QuickServiceType.OIL_CHANGE]: ['oil-change'],
  [QuickServiceType.BRAKES]: ['brake-pads', 'brake-discs', 'brake-fluid'],
  [QuickServiceType.DIAGNOSTICS]: ['engine-diagnostics', 'electrical-diagnostics'],
  [QuickServiceType.URGENT]: ['engine-diagnostics', 'starter-repair'],
  [QuickServiceType.SUSPENSION]: ['shock-absorbers', 'wheel-alignment', 'ball-joints'],
  [QuickServiceType.ELECTRICAL]: ['battery-replacement', 'starter-repair', 'electrical-diagnostics'],
  [QuickServiceType.OTHER]: [],
};

// Human-readable descriptions
const SERVICE_TYPE_DESCRIPTIONS: Record<QuickServiceType, string> = {
  [QuickServiceType.ENGINE_WONT_START]: 'Не заводится двигатель',
  [QuickServiceType.OIL_CHANGE]: 'Замена масла',
  [QuickServiceType.BRAKES]: 'Проблемы с тормозами',
  [QuickServiceType.DIAGNOSTICS]: 'Нужна диагностика',
  [QuickServiceType.URGENT]: 'Срочный ремонт',
  [QuickServiceType.SUSPENSION]: 'Проблемы с подвеской',
  [QuickServiceType.ELECTRICAL]: 'Проблемы с электрикой',
  [QuickServiceType.OTHER]: 'Другая проблема',
};

export interface QuickRequestResult {
  quote: any;
  matches: any[];
  serviceType: QuickServiceType;
  description: string;
}

@Injectable()
export class QuickRequestService {
  private readonly logger = new Logger(QuickRequestService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Service') private readonly serviceModel: Model<any>,
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('ProviderService') private readonly providerServiceModel: Model<any>,
    @InjectModel('Audit') private readonly auditModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * 🔥 Main method: Create quick request and return matches
   */
  async createQuickRequest(userId: string, dto: QuickRequestDto): Promise<QuickRequestResult> {
    this.logger.log(`Creating quick request for user ${userId}, type: ${dto.serviceType}`);
    
    // 1. Find matching service
    const serviceSlugs = SERVICE_TYPE_TO_SLUG[dto.serviceType];
    let serviceId: string | null = null;
    
    if (serviceSlugs.length > 0) {
      const service = await this.serviceModel.findOne({ 
        slug: { $in: serviceSlugs } 
      }).lean();
      if (service) {
        serviceId = String((service as any)._id);
      }
    }

    // 2. Create quote automatically
    const description = dto.description || SERVICE_TYPE_DESCRIPTIONS[dto.serviceType];
    const isUrgent = dto.urgent || dto.serviceType === QuickServiceType.URGENT;
    
    const quote = await this.quoteModel.create({
      userId,
      vehicleId: dto.vehicleId || null,
      requestedServiceId: serviceId,
      description,
      location: {
        type: 'Point',
        coordinates: [dto.lng, dto.lat],
      },
      serviceType: dto.serviceType,
      isQuickRequest: true,
      urgent: isUrgent,
      urgency: isUrgent ? 'high' : 'normal', // NEW: for assignment engine
      source: 'quick', // NEW: for assignment engine
      mobileRequired: dto.mobileRequired || false,
      status: QuoteStatus.PENDING,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    // 3. Audit log
    await this.auditModel.create({
      entity: 'Quote',
      entityId: String(quote._id),
      action: 'QUICK_REQUEST_CREATED',
      actorId: userId,
      prev: null,
      next: { 
        status: quote.status, 
        serviceType: dto.serviceType,
        isQuickRequest: true,
      },
    });

    // 4. Find matching providers
    const matches = await this.findInstantMatches(dto, serviceId);

    // 5. 🚀 AUTO-DISTRIBUTION: Send to top 3 providers automatically!
    try {
      // Dynamic import to avoid circular dependency
      const { AutoDistributionService } = await import('../provider-inbox/auto-distribution.service');
      // Use mongoose connection to get distribution model
      const distributionModel = this.connection.model('RequestDistribution');
      const orgModel = this.connection.model('Organization');
      
      // Create distributions for top 3 matches
      const top3 = matches.slice(0, 3);
      for (const match of top3) {
        const existingDist = await distributionModel.findOne({
          requestId: quote._id,
          providerId: new Types.ObjectId(match.providerId),
        });
        
        if (!existingDist) {
          await distributionModel.create({
            requestId: quote._id,
            providerId: new Types.ObjectId(match.providerId),
            matchingScore: match.matchingScore,
            visibilityScoreSnapshot: match.visibilityScore || 50,
            behavioralScoreSnapshot: 50,
            distanceKm: match.distanceKm,
            etaMinutes: Math.round(match.distanceKm / 30 * 60) || 10,
            reasons: match.reasons,
            distributionStatus: 'sent',
            urgency: isUrgent ? 'high' : 'normal',
            expiresAt: new Date(Date.now() + (isUrgent ? 5 : 15) * 60 * 1000),
            sentAt: new Date(),
            distributedBy: 'auto',
          });
          
          this.logger.log(`[AutoDistribute] Sent to provider ${match.providerId} (${match.name})`);
        }
      }
      
      // Update quote status to in_review
      quote.status = QuoteStatus.IN_REVIEW;
      await quote.save();
      
      this.logger.log(`[AutoDistribute] Distributed to ${top3.length} providers`);
    } catch (err) {
      this.logger.warn(`[AutoDistribute] Could not auto-distribute: ${err.message}`);
    }

    // 6. Emit event for provider notifications
    await this.eventBus.emit(PlatformEvent.QUOTE_CREATED, {
      quoteId: String(quote._id),
      customerId: userId,
      lat: dto.lat,
      lng: dto.lng,
      serviceType: dto.serviceType,
      urgent: isUrgent,
      matchedProviders: matches.map(m => m.providerId),
    });

    this.logger.log(`Quick request created: ${quote._id}, found ${matches.length} matches`);

    return {
      quote,
      matches,
      serviceType: dto.serviceType,
      description,
    };
  }

  /**
   * Find providers instantly for quick request
   */
  private async findInstantMatches(dto: QuickRequestDto, serviceId: string | null): Promise<any[]> {
    const radiusKm = dto.urgent ? 30 : 20; // Larger radius for urgent
    
    // Get branches nearby with provider services
    const branches = await this.findNearbyBranches(dto.lat, dto.lng, radiusKm);
    
    if (branches.length === 0) {
      return [];
    }

    const results: any[] = [];

    for (const branch of branches) {
      const org = await this.orgModel.findById(branch.organizationId).lean();
      if (!org || (org as any).status !== 'active') continue;

      // Calculate distance
      const distanceKm = this.calculateDistance(
        dto.lat, dto.lng,
        branch.location?.coordinates?.[1] || 0,
        branch.location?.coordinates?.[0] || 0,
      );

      // Get provider services
      let priceFrom = 0;
      if (serviceId) {
        const ps = await this.providerServiceModel.findOne({
          branchId: branch._id,
          serviceId: new Types.ObjectId(serviceId),
          status: 'active',
        }).lean();
        if (ps) {
          priceFrom = (ps as any).priceFrom || (ps as any).price || 0;
        }
      }

      // Calculate matching score
      const score = this.calculateMatchScore(org as any, branch, distanceKm, dto);
      const reasons = this.generateReasons(org as any, branch, distanceKm, dto);

      // Check boost status
      const hasBoost = (org as any).boostActive || (org as any).boostUntil > new Date();
      
      results.push({
        providerId: String((org as any)._id),
        branchId: String(branch._id),
        name: (org as any).name,
        matchingScore: score,
        reasons,
        distanceKm: Math.round(distanceKm * 10) / 10,
        rating: (org as any).rating || (org as any).ratingAvg || 4.5,
        reviewsCount: (org as any).reviewsCount || 0,
        isVerified: (org as any).isVerified || false,
        isPopular: (org as any).isPopular || score >= 75,
        isMobile: (org as any).isMobile || branch.isMobile || false,
        hasAvailableSlotsToday: this.checkTodayAvailability(branch),
        priceFrom,
        avgResponseTimeMinutes: (org as any).avgResponseTimeMinutes || 15,
        visibilityScore: (org as any).visibilityScore || 50,
        hasBoost,
        lat: branch.location?.coordinates?.[1] || 0,
        lng: branch.location?.coordinates?.[0] || 0,
        address: branch.address || '',
        phone: branch.phone || '',
      });
    }

    // Sort: Boosted first, then by score
    results.sort((a, b) => {
      if (a.hasBoost && !b.hasBoost) return -1;
      if (!a.hasBoost && b.hasBoost) return 1;
      return b.matchingScore - a.matchingScore;
    });

    // Return top 5
    return results.slice(0, 5);
  }

  /**
   * Find nearby branches
   */
  private async findNearbyBranches(lat: number, lng: number, radiusKm: number): Promise<any[]> {
    try {
      // Try geo query first
      return await this.branchModel.find({
        status: 'active',
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lng, lat] },
            $maxDistance: radiusKm * 1000,
          },
        },
      }).limit(20).lean();
    } catch {
      // Fallback: get all active branches
      const allBranches = await this.branchModel.find({ status: 'active' }).limit(50).lean();
      
      // Filter by distance manually
      return allBranches.filter((branch: any) => {
        const dist = this.calculateDistance(
          lat, lng,
          branch.location?.coordinates?.[1] || 0,
          branch.location?.coordinates?.[0] || 0,
        );
        return dist <= radiusKm;
      });
    }
  }

  /**
   * Calculate match score
   */
  private calculateMatchScore(org: any, branch: any, distanceKm: number, dto: QuickRequestDto): number {
    let score = 50;

    // Distance factor (max +30)
    if (distanceKm <= 2) score += 30;
    else if (distanceKm <= 5) score += 20;
    else if (distanceKm <= 10) score += 10;

    // Rating factor (max +15)
    const rating = org.rating || org.ratingAvg || 4.0;
    if (rating >= 4.5) score += 15;
    else if (rating >= 4.0) score += 10;
    else if (rating >= 3.5) score += 5;

    // Verified (max +10)
    if (org.isVerified) score += 10;

    // Response time (max +10)
    const responseTime = org.avgResponseTimeMinutes || 30;
    if (responseTime <= 10) score += 10;
    else if (responseTime <= 20) score += 5;

    // Today availability (max +10)
    if (this.checkTodayAvailability(branch)) score += 10;

    // Mobile for urgent (max +5)
    if (dto.urgent && (org.isMobile || branch.isMobile)) score += 5;

    // Boost bonus (max +10)
    if (org.boostActive || org.boostUntil > new Date()) score += 10;

    return Math.min(100, score);
  }

  /**
   * Generate human-readable reasons
   */
  private generateReasons(org: any, branch: any, distanceKm: number, dto: QuickRequestDto): string[] {
    const reasons: string[] = [];

    if (distanceKm <= 2) reasons.push('Очень близко');
    else if (distanceKm <= 5) reasons.push(`Рядом (${distanceKm.toFixed(1)} км)`);

    if (this.checkTodayAvailability(branch)) reasons.push('Есть слот сегодня');

    const rating = org.rating || org.ratingAvg || 0;
    if (rating >= 4.5 && (org.reviewsCount || 0) >= 5) {
      reasons.push(`Высокий рейтинг (${rating.toFixed(1)})`);
    }

    if (org.isVerified) reasons.push('Проверенный');

    const responseTime = org.avgResponseTimeMinutes || 30;
    if (responseTime <= 10) reasons.push('Быстрый ответ');

    if (dto.urgent && (org.isMobile || branch.isMobile)) {
      reasons.push('Выезд к вам');
    }

    if (org.boostActive || org.boostUntil > new Date()) {
      reasons.push('Популярный');
    }

    return reasons.slice(0, 4);
  }

  /**
   * Check if branch has availability today
   */
  private checkTodayAvailability(branch: any): boolean {
    if (!branch.workingHours) return true; // Assume available if no data

    const today = new Date();
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[today.getDay()];
    
    const hours = branch.workingHours[dayName];
    if (!hours || !hours.open) return false;

    // Check if current time is within working hours
    const now = today.getHours() * 60 + today.getMinutes();
    const [openH, openM] = hours.open.split(':').map(Number);
    const [closeH, closeM] = hours.close.split(':').map(Number);
    const open = openH * 60 + openM;
    const close = closeH * 60 + closeM;

    return now >= open && now < close - 60; // At least 1 hour before closing
  }

  /**
   * Haversine distance
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    if (!lat2 || !lng2) return 999;
    
    const R = 6371;
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
   * Get available quick service types
   */
  getServiceTypes(): { type: QuickServiceType; label: string; icon: string }[] {
    return [
      { type: QuickServiceType.ENGINE_WONT_START, label: 'Не заводится', icon: 'car-off' },
      { type: QuickServiceType.OIL_CHANGE, label: 'Замена масла', icon: 'oil' },
      { type: QuickServiceType.BRAKES, label: 'Тормоза', icon: 'brake-warning' },
      { type: QuickServiceType.DIAGNOSTICS, label: 'Диагностика', icon: 'magnify' },
      { type: QuickServiceType.URGENT, label: 'Срочно', icon: 'alert-circle' },
      { type: QuickServiceType.SUSPENSION, label: 'Подвеска', icon: 'car-suspension' },
      { type: QuickServiceType.ELECTRICAL, label: 'Электрика', icon: 'flash' },
      { type: QuickServiceType.OTHER, label: 'Другое', icon: 'dots-horizontal' },
    ];
  }
}
