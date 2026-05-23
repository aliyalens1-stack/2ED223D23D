import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';
import { BookingStatus, QuoteStatus } from '../../shared/enums';

export interface InboxItem {
  distributionId: string;
  requestId: string;
  serviceName: string;
  description: string;
  urgency: string;
  distanceKm: number;
  etaMinutes: number;
  matchingScore: number;
  estimatedPrice: number;
  reasons: string[];
  expiresInSeconds: number;
  status: string;
  customerName?: string;
  location?: { lat: number; lng: number };
  createdAt: Date;
}

export interface PressureSummary {
  missedToday: number;
  lostRevenueToday: number;
  behavioralScore: number;
  tier: string;
  onlineState: string;
  acceptedToday: number;
  responseRate: number;
  avgResponseTime: number;
  tips: string[];
}

@Injectable()
export class ProviderInboxService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('RequestDistribution') private readonly distributionModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('ProviderService') private readonly providerServiceModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Get provider inbox - active requests waiting for response
   */
  async getInbox(providerId: string): Promise<InboxItem[]> {
    const now = new Date();
    
    // Get all sent distributions for this provider
    const distributions = await this.distributionModel.aggregate([
      {
        $match: {
          providerId: new Types.ObjectId(providerId),
          distributionStatus: { $in: ['sent', 'viewed'] },
        },
      },
      // Join with quotes
      {
        $lookup: {
          from: 'quotes',
          localField: 'requestId',
          foreignField: '_id',
          as: 'request',
        },
      },
      {
        $unwind: '$request',
      },
      // Filter active requests
      {
        $match: {
          'request.status': { $in: ['pending', 'in_review'] },
        },
      },
      // Join with services
      {
        $lookup: {
          from: 'services',
          localField: 'request.requestedServiceId',
          foreignField: '_id',
          as: 'service',
        },
      },
      // Join with users (customers)
      {
        $lookup: {
          from: 'users',
          localField: 'request.userId',
          foreignField: '_id',
          as: 'customer',
        },
      },
      // Sort by matching score (best first)
      {
        $sort: { matchingScore: -1, sentAt: -1 },
      },
      // Project fields
      {
        $project: {
          distributionId: '$_id',
          requestId: '$requestId',
          serviceName: { $ifNull: [{ $arrayElemAt: ['$service.name', 0] }, 'Услуга'] },
          description: '$request.description',
          urgency: { $ifNull: ['$request.urgency', 'normal'] },
          distanceKm: '$distanceKm',
          etaMinutes: '$etaMinutes',
          matchingScore: '$matchingScore',
          reasons: '$reasons',
          status: '$distributionStatus',
          location: '$request.location',
          createdAt: '$sentAt',
          customerFirstName: { $arrayElemAt: ['$customer.firstName', 0] },
          customerLastName: { $arrayElemAt: ['$customer.lastName', 0] },
          requestCreatedAt: '$request.createdAt',
        },
      },
    ]);

    // Calculate expiration and format response
    return distributions.map((d: any) => {
      // Calculate TTL based on urgency
      const ttlSeconds = this.getTTLByUrgency(d.urgency);
      const elapsedSeconds = Math.floor((now.getTime() - new Date(d.createdAt).getTime()) / 1000);
      const expiresInSeconds = Math.max(0, ttlSeconds - elapsedSeconds);

      // Estimate price (simplified)
      const estimatedPrice = this.estimatePrice(d.serviceName);

      return {
        distributionId: String(d.distributionId),
        requestId: String(d.requestId),
        serviceName: d.serviceName,
        description: d.description || '',
        urgency: d.urgency,
        distanceKm: d.distanceKm || 0,
        etaMinutes: d.etaMinutes || 10,
        matchingScore: d.matchingScore || 50,
        estimatedPrice,
        reasons: d.reasons || [],
        expiresInSeconds,
        status: d.status,
        customerName: [d.customerFirstName, d.customerLastName].filter(Boolean).join(' ') || 'Клиент',
        location: d.location?.coordinates
          ? { lat: d.location.coordinates[1], lng: d.location.coordinates[0] }
          : undefined,
        createdAt: d.createdAt,
      };
    });
  }

  /**
   * Get pressure summary for provider
   */
  async getPressureSummary(providerId: string): Promise<PressureSummary> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const organization = await this.organizationModel.findById(providerId).lean() as any;

    // Count today's distributions
    const todayDistributions = await this.distributionModel.aggregate([
      {
        $match: {
          providerId: new Types.ObjectId(providerId),
          sentAt: { $gte: today },
        },
      },
      {
        $group: {
          _id: '$distributionStatus',
          count: { $sum: 1 },
        },
      },
    ]);

    const statusCounts: Record<string, number> = {};
    todayDistributions.forEach((d: any) => {
      statusCounts[d._id] = d.count;
    });

    const missedToday = (statusCounts['expired'] || 0) + (statusCounts['ignored'] || 0);
    const acceptedToday = statusCounts['selected'] || 0;
    const totalToday = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    // Calculate lost revenue (estimate 1500 per missed request)
    const avgTicket = 1500;
    const lostRevenueToday = missedToday * avgTicket;

    // Calculate response rate
    const responseRate = totalToday > 0 ? (acceptedToday / totalToday) : 0;

    // Get behavioral score
    const behavioralScore = organization?.behavioralScore || 50;

    // Determine tier
    const tier = this.getTierByScore(behavioralScore);

    // Generate tips
    const tips = this.generateTips(behavioralScore, responseRate, missedToday);

    return {
      missedToday,
      lostRevenueToday,
      behavioralScore,
      tier,
      onlineState: organization?.isOnline !== false ? 'online' : 'offline',
      acceptedToday,
      responseRate: Math.round(responseRate * 100) / 100,
      avgResponseTime: 25, // TODO: calculate from real data
      tips,
    };
  }

  /**
   * Provider accepts a request - ATOMIC VERSION
   * Uses findOneAndUpdate for race condition protection
   */
  async acceptRequest(providerId: string, distributionId: string): Promise<any> {
    const now = new Date();

    // ATOMIC: Try to claim this distribution
    // Only succeeds if: status is sent/viewed AND no other distribution is selected
    const distribution = await this.distributionModel.findOneAndUpdate(
      {
        _id: distributionId,
        providerId: new Types.ObjectId(providerId),
        distributionStatus: { $in: ['sent', 'viewed'] },
      },
      {
        $set: {
          distributionStatus: 'selected',
          selectedAt: now,
          respondedAt: now,
        },
      },
      { new: true }
    );

    if (!distribution) {
      // Check why it failed
      const existing = await this.distributionModel.findOne({
        _id: distributionId,
        providerId: new Types.ObjectId(providerId),
      });

      if (!existing) {
        throw new NotFoundException('Distribution not found');
      }
      if (existing.distributionStatus === 'selected') {
        throw new BadRequestException('Вы уже приняли эту заявку');
      }
      if (existing.distributionStatus === 'expired') {
        throw new BadRequestException('Время истекло - заявка больше недоступна');
      }
      throw new BadRequestException('Cannot accept - already processed');
    }

    // ATOMIC CHECK: Verify no other provider already selected this request
    const competingSelection = await this.distributionModel.findOne({
      requestId: distribution.requestId,
      _id: { $ne: distribution._id },
      distributionStatus: 'selected',
    });

    if (competingSelection) {
      // ROLLBACK: Someone beat us - revert our selection
      await this.distributionModel.updateOne(
        { _id: distribution._id },
        {
          $set: {
            distributionStatus: 'rejected',
            respondedAt: now,
          },
        }
      );
      throw new BadRequestException('Заявка уже взята другим мастером');
    }

    // SUCCESS: We won! Mark all others as rejected
    await this.distributionModel.updateMany(
      { 
        requestId: distribution.requestId, 
        _id: { $ne: distribution._id },
        distributionStatus: { $in: ['sent', 'viewed'] },
      },
      { 
        $set: {
          distributionStatus: 'rejected',
          respondedAt: now,
        },
      }
    );

    // Get quote
    const quote = await this.quoteModel.findById(distribution.requestId);
    if (!quote) throw new NotFoundException('Request not found');

    // Get organization
    const organization = await this.organizationModel.findById(providerId);
    if (!organization) throw new NotFoundException('Provider not found');

    // Get branch
    const branch = await this.branchModel.findOne({ organizationId: providerId }).lean() as any;

    // Get provider service
    let providerService = null;
    if (quote.requestedServiceId) {
      providerService = await this.providerServiceModel.findOne({
        organizationId: providerId,
        serviceId: quote.requestedServiceId,
      });
    }
    if (!providerService) {
      providerService = await this.providerServiceModel.findOne({ organizationId: providerId });
    }

    // Get customer
    const customer = await this.connection.model('User').findById(quote.userId).lean() as any;

    // Get customer location from quote
    const customerLocation = quote.location?.coordinates 
      ? { lat: quote.location.coordinates[1], lng: quote.location.coordinates[0] }
      : null;

    // Create booking with location data for Current Job
    const booking = await this.bookingModel.create({
      userId: quote.userId,
      organizationId: providerId,
      branchId: branch?._id,
      providerServiceId: providerService?._id,
      quoteId: quote._id,
      status: BookingStatus.PENDING,
      // Location for route system
      customerLocation: customerLocation ? {
        type: 'Point',
        coordinates: [customerLocation.lng, customerLocation.lat],
      } : null,
      snapshot: {
        orgName: organization.name || '',
        branchName: branch?.name || branch?.address || '',
        branchAddress: branch?.address || '',
        serviceName: providerService?.description || 'Услуга',
        price: providerService?.priceMin || 0,
        customerName: customer ? `${customer.firstName || ''} ${customer.lastName || ''}`.trim() : '',
        customerPhone: customer?.phone || '',
        vehicleBrand: '',
        vehicleModel: '',
      },
      // Estimated values from matching
      estimatedEtaMinutes: distribution.etaMinutes || 10,
      estimatedDistanceKm: distribution.distanceKm || 0,
      customerNotes: `Принято через Provider Inbox. ETA: ${distribution.etaMinutes} мин`,
    });

    // Update quote
    quote.status = QuoteStatus.ACCEPTED;
    quote.selectedProviderId = providerId;
    await quote.save();

    // Calculate response time and update behavioral score
    const responseTimeSeconds = (now.getTime() - new Date(distribution.sentAt).getTime()) / 1000;
    const scoreBonus = responseTimeSeconds < 30 ? 10 : responseTimeSeconds < 60 ? 5 : 3;
    await this.updateBehavioralScore(providerId, scoreBonus, 'quick_accept');

    // Emit events
    await this.eventBus.emit(PlatformEvent.BOOKING_CREATED, {
      bookingId: String(booking._id),
      customerId: String(quote.userId),
      providerId,
      requestId: String(quote._id),
      responseTimeSeconds,
    });

    return {
      success: true,
      bookingId: String(booking._id),
      message: 'Заявка принята! Booking создан.',
      responseTimeSeconds: Math.round(responseTimeSeconds),
    };
  }

  /**
   * Provider rejects/skips a request
   */
  async rejectRequest(providerId: string, distributionId: string, reason?: string): Promise<any> {
    const distribution = await this.distributionModel.findOne({
      _id: distributionId,
      providerId: new Types.ObjectId(providerId),
    });

    if (!distribution) {
      throw new NotFoundException('Distribution not found');
    }

    if (distribution.distributionStatus !== 'sent' && distribution.distributionStatus !== 'viewed') {
      throw new BadRequestException('Cannot reject - already processed');
    }

    distribution.distributionStatus = 'ignored';
    distribution.respondedAt = new Date();
    distribution.responseMessage = reason || '';
    await distribution.save();

    // Update behavioral score (-3 for reject)
    await this.updateBehavioralScore(providerId, -3, 'reject');

    return {
      success: true,
      message: 'Заявка пропущена',
    };
  }

  /**
   * Mark distribution as viewed
   */
  async markViewed(providerId: string, distributionId: string): Promise<void> {
    await this.distributionModel.updateOne(
      {
        _id: distributionId,
        providerId: new Types.ObjectId(providerId),
        distributionStatus: 'sent',
      },
      {
        distributionStatus: 'viewed',
        viewedAt: new Date(),
      }
    );
  }

  /**
   * Update provider online status
   */
  async updatePresence(providerId: string, isOnline: boolean, acceptsQuickRequests?: boolean): Promise<void> {
    const update: any = { isOnline };
    if (acceptsQuickRequests !== undefined) {
      update.acceptsQuickRequests = acceptsQuickRequests;
    }
    await this.organizationModel.updateOne(
      { _id: providerId },
      { $set: update }
    );
  }

  /**
   * Get missed requests for today
   */
  async getMissedRequests(providerId: string): Promise<any[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return this.distributionModel.aggregate([
      {
        $match: {
          providerId: new Types.ObjectId(providerId),
          distributionStatus: { $in: ['expired', 'ignored', 'rejected'] },
          sentAt: { $gte: today },
        },
      },
      {
        $lookup: {
          from: 'quotes',
          localField: 'requestId',
          foreignField: '_id',
          as: 'request',
        },
      },
      {
        $unwind: '$request',
      },
      {
        $lookup: {
          from: 'services',
          localField: 'request.requestedServiceId',
          foreignField: '_id',
          as: 'service',
        },
      },
      {
        $sort: { sentAt: -1 },
      },
      {
        $limit: 20,
      },
      {
        $project: {
          distributionId: '$_id',
          requestId: '$requestId',
          serviceName: { $ifNull: [{ $arrayElemAt: ['$service.name', 0] }, 'Услуга'] },
          status: '$distributionStatus',
          distanceKm: '$distanceKm',
          matchingScore: '$matchingScore',
          sentAt: 1,
          lostRevenue: { $multiply: [1500, 1] }, // Estimate
        },
      },
    ]);
  }

  // ==================== HELPER METHODS ====================

  private getTTLByUrgency(urgency: string): number {
    switch (urgency) {
      case 'critical': return 20;
      case 'high': return 30;
      case 'normal': return 60;
      case 'low': return 120;
      default: return 60;
    }
  }

  private estimatePrice(serviceName: string): number {
    // Simplified price estimation
    const priceMap: Record<string, number> = {
      'Замена масла': 1500,
      'Oil Change': 1500,
      'Диагностика': 800,
      'Brake Pad Replacement': 2500,
      'Шиномонтаж': 600,
      'ТО': 3500,
    };
    return priceMap[serviceName] || 1500;
  }

  private getTierByScore(score: number): string {
    if (score >= 90) return 'Platinum';
    if (score >= 75) return 'Gold';
    if (score >= 50) return 'Silver';
    return 'Bronze';
  }

  private generateTips(score: number, responseRate: number, missedToday: number): string[] {
    const tips: string[] = [];
    
    if (responseRate < 0.5) {
      tips.push('Отвечайте на заявки быстрее 30 сек');
    }
    if (missedToday > 3) {
      tips.push('Вы пропустили много заявок сегодня');
    }
    if (score < 60) {
      tips.push('Повысьте скор - принимайте больше заявок');
    }
    if (tips.length === 0) {
      tips.push('Отличная работа! Продолжайте в том же духе');
    }
    
    return tips;
  }

  private async updateBehavioralScore(providerId: string, delta: number, reason: string): Promise<void> {
    const org = await this.organizationModel.findById(providerId);
    if (!org) return;

    const currentScore = org.behavioralScore || 50;
    const newScore = Math.max(0, Math.min(100, currentScore + delta));

    await this.organizationModel.updateOne(
      { _id: providerId },
      { 
        $set: { behavioralScore: newScore },
        $push: {
          behavioralHistory: {
            delta,
            reason,
            previousScore: currentScore,
            newScore,
            timestamp: new Date(),
          },
        },
      }
    );
  }
}
