import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';
import { BookingStatus, QuoteStatus } from '../../shared/enums';

interface MatchingCandidate {
  providerId: string;
  providerName: string;
  matchingScore: number;
  visibilityScore: number;
  behavioralScore: number;
  distanceKm: number;
  etaMinutes: number;
  rating: number;
  completedBookings: number;
  responseRate: number;
  isOnline: boolean;
  isMobile: boolean;
  location?: { lat: number; lng: number };
  reasons: string[];
}

export interface AssignmentResult {
  success: boolean;
  bookingId?: string;
  distributionId?: string;
  message: string;
}

export { MatchingCandidate };

@Injectable()
export class AssignmentService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('RequestDistribution') private readonly distributionModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('ProviderService') private readonly providerServiceModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Find matching candidates for a request
   * STABLE VERSION - uses $geoNear on branches, then joins organizations
   */
  async findMatchingCandidates(requestId: string, limit = 10): Promise<MatchingCandidate[]> {
    try {
      const quote = await this.quoteModel.findById(requestId).lean();
      if (!quote) throw new NotFoundException('Request not found');

      // Get request location - default to Moscow if not set
      const requestLocation = (quote as any).location?.coordinates || [37.6173, 55.7558];
      const [lng, lat] = requestLocation;

      console.log(`[Matching] Finding candidates for request ${requestId}, location: [${lng}, ${lat}]`);

      // Use $geoNear on branches collection (which HAS location)
      const nearbyBranches = await this.branchModel.aggregate([
        // 1. GEO SEARCH - MUST BE FIRST!
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: [lng, lat],
            },
            distanceField: 'distanceMeters',
            maxDistance: 50000, // 50 km
            spherical: true,
          },
        },
        // 2. Join with organizations
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            as: 'organization',
          },
        },
        // 3. Unwind organization
        {
          $unwind: {
            path: '$organization',
            preserveNullAndEmptyArrays: false,
          },
        },
        // 4. Filter active and verified
        {
          $match: {
            'organization.status': 'active',
            'organization.isVerified': true,
          },
        },
        // 5. Calculate fields
        {
          $addFields: {
            distanceKm: { $divide: ['$distanceMeters', 1000] },
            ratingSafe: { $ifNull: ['$organization.rating', 4] },
            visibilityScoreSafe: { $ifNull: ['$organization.visibilityScore', 50] },
            behavioralScoreSafe: { $ifNull: ['$organization.behavioralScore', 50] },
            isVerifiedSafe: { $cond: [{ $eq: ['$organization.isVerified', true] }, 1, 0] },
          },
        },
        // 6. Calculate matching score
        {
          $addFields: {
            matchingScore: {
              $round: [
                {
                  $add: [
                    // Distance score (closer = better, max 35 points)
                    { $multiply: [{ $max: [0, { $subtract: [100, { $multiply: ['$distanceKm', 5] }] }] }, 0.35] },
                    // Visibility score (max 25 points)
                    { $multiply: [{ $divide: ['$visibilityScoreSafe', 100] }, 25] },
                    // Behavioral score (max 25 points)
                    { $multiply: [{ $divide: ['$behavioralScoreSafe', 100] }, 25] },
                    // Rating score (max 15 points)
                    { $multiply: [{ $divide: ['$ratingSafe', 5] }, 15] },
                  ],
                },
                0,
              ],
            },
            etaMinutes: { $round: [{ $multiply: [{ $divide: ['$distanceKm', 30] }, 60] }, 0] },
          },
        },
        // 7. Sort by matching score
        { $sort: { matchingScore: -1 } },
        // 8. Limit
        { $limit: limit },
        // 9. Project final fields
        {
          $project: {
            providerId: '$organization._id',
            providerName: '$organization.name',
            matchingScore: 1,
            visibilityScore: '$visibilityScoreSafe',
            behavioralScore: '$behavioralScoreSafe',
            distanceKm: { $round: ['$distanceKm', 1] },
            etaMinutes: 1,
            rating: '$ratingSafe',
            completedBookings: { $ifNull: ['$organization.completedBookingsCount', 0] },
            responseRate: { $ifNull: ['$organization.responseRate', 0] },
            isOnline: { $ne: ['$organization.isOnline', false] },
            isMobile: { $ifNull: ['$organization.isMobile', false] },
            isVerified: '$organization.isVerified',
            location: '$location',
          },
        },
      ]);

      console.log(`[Matching] Found ${nearbyBranches.length} nearby branches`);

      // Transform to MatchingCandidate format
      const candidates: MatchingCandidate[] = nearbyBranches.map((b: any) => {
        // Build reasons for explainability
        const reasons: string[] = [];
        if (b.distanceKm < 3) reasons.push('Очень близко');
        else if (b.distanceKm < 10) reasons.push('В радиусе 10 км');
        if (b.rating >= 4.5) reasons.push('Высокий рейтинг');
        if (b.completedBookings > 50) reasons.push('Опытный мастер');
        if (b.responseRate > 0.8) reasons.push('Быстрый ответ');
        if (b.isVerified) reasons.push('Проверен');

        return {
          providerId: String(b.providerId),
          providerName: b.providerName || 'Мастер',
          matchingScore: b.matchingScore || 50,
          visibilityScore: b.visibilityScore || 50,
          behavioralScore: b.behavioralScore || 50,
          distanceKm: b.distanceKm || 0,
          etaMinutes: b.etaMinutes || 10,
          rating: b.rating || 4,
          completedBookings: b.completedBookings || 0,
          responseRate: b.responseRate || 0,
          isOnline: b.isOnline !== false,
          isMobile: b.isMobile || false,
          location: b.location?.coordinates
            ? { lat: b.location.coordinates[1], lng: b.location.coordinates[0] }
            : { lat, lng },
          reasons,
        };
      });

      return candidates;
    } catch (error) {
      console.error('[Matching] Error:', error);
      throw error;
    }
  }

  /**
   * Distribute request to providers (auto or manual)
   */
  async distributeRequest(
    requestId: string,
    providerIds: string[],
    operatorId?: string,
    distributedBy: 'auto' | 'operator' | 'system' = 'auto'
  ): Promise<any[]> {
    const quote = await this.quoteModel.findById(requestId);
    if (!quote) throw new NotFoundException('Request not found');

    // Get matching candidates for scoring
    const candidates = await this.findMatchingCandidates(requestId, 50);
    const candidateMap = new Map(candidates.map(c => [c.providerId, c]));

    const distributions = [];

    for (const providerId of providerIds) {
      // Check if already distributed
      const existing = await this.distributionModel.findOne({
        requestId,
        providerId,
      });
      if (existing) continue;

      const candidate = candidateMap.get(providerId);

      const distribution = await this.distributionModel.create({
        requestId,
        providerId,
        matchingScore: candidate?.matchingScore || 50,
        visibilityScoreSnapshot: candidate?.visibilityScore || 50,
        behavioralScoreSnapshot: candidate?.behavioralScore || 50,
        distanceKm: candidate?.distanceKm || 0,
        etaMinutes: candidate?.etaMinutes || 0,
        reasons: candidate?.reasons || [],
        distributionStatus: 'sent',
        sentAt: new Date(),
        distributedBy,
        operatorId: operatorId ? new Types.ObjectId(operatorId) : null,
      });

      distributions.push(distribution);

      // Emit event for notifications
      await this.eventBus.emit(PlatformEvent.QUOTE_DISTRIBUTED, {
        requestId,
        providerId,
        distributionId: String(distribution._id),
      });
    }

    // Update quote status
    if (quote.status === QuoteStatus.PENDING) {
      quote.status = QuoteStatus.IN_REVIEW;
      await quote.save();
    }

    return distributions;
  }

  /**
   * Mark distribution as viewed
   */
  async markViewed(distributionId: string): Promise<void> {
    await this.distributionModel.findByIdAndUpdate(distributionId, {
      distributionStatus: 'viewed',
      viewedAt: new Date(),
    });
  }

  /**
   * Provider responds to distribution
   */
  async respondToDistribution(
    distributionId: string,
    response: { price?: number; eta?: number; message?: string }
  ): Promise<any> {
    const distribution = await this.distributionModel.findById(distributionId);
    if (!distribution) throw new NotFoundException('Distribution not found');

    distribution.distributionStatus = 'responded';
    distribution.respondedAt = new Date();
    distribution.responsePrice = response.price;
    distribution.responseEta = response.eta;
    distribution.responseMessage = response.message || '';
    await distribution.save();

    // Update quote to have responses
    const quote = await this.quoteModel.findById(distribution.requestId);
    if (quote && quote.status === QuoteStatus.IN_REVIEW) {
      quote.status = QuoteStatus.RESPONDED;
      quote.responsesCount = (quote.responsesCount || 0) + 1;
      await quote.save();
    }

    // Emit event
    await this.eventBus.emit(PlatformEvent.QUOTE_RESPONDED, {
      requestId: String(distribution.requestId),
      providerId: String(distribution.providerId),
      distributionId,
      price: response.price,
    });

    return distribution;
  }

  /**
   * Select provider and create booking from request
   * This is the key action that closes the loop
   */
  async selectProviderAndCreateBooking(
    requestId: string,
    providerId: string,
    operatorId?: string,
    options: { price?: number; slotId?: string; notes?: string } = {}
  ): Promise<AssignmentResult> {
    const quote = await this.quoteModel.findById(requestId);
    if (!quote) throw new NotFoundException('Request not found');

    const organization = await this.organizationModel.findById(providerId);
    if (!organization) throw new NotFoundException('Provider not found');

    // Get main branch
    const branch = await this.branchModel.findOne({ organizationId: providerId }).lean() as any;
    if (!branch) throw new BadRequestException('Provider has no branch');

    // Get provider service (use first available or requested)
    let providerService = null;
    if ((quote as any).requestedServiceId) {
      providerService = await this.providerServiceModel.findOne({
        organizationId: providerId,
        serviceId: (quote as any).requestedServiceId,
      });
    }
    if (!providerService) {
      providerService = await this.providerServiceModel.findOne({ organizationId: providerId });
    }

    // Get user info
    const user = await this.connection.model('User').findById(quote.userId).lean();

    // Update distribution status
    await this.distributionModel.updateMany(
      { requestId, providerId: { $ne: providerId } },
      { distributionStatus: 'rejected' }
    );
    await this.distributionModel.updateOne(
      { requestId, providerId },
      { 
        distributionStatus: 'selected',
        selectedAt: new Date(),
      }
    );

    // Create booking
    const booking = await this.bookingModel.create({
      userId: quote.userId,
      organizationId: providerId,
      branchId: branch._id,
      providerServiceId: providerService?._id,
      quoteId: quote._id,
      slotId: options.slotId || null,
      status: BookingStatus.PENDING,
      snapshot: {
        orgName: organization.name || '',
        branchName: (branch as any).name || (branch as any).address || '',
        branchAddress: (branch as any).address || '',
        serviceName: providerService?.description || 'Услуга',
        price: options.price || (providerService as any)?.priceMin || 0,
        customerName: user ? `${(user as any).firstName || ''} ${(user as any).lastName || ''}`.trim() : '',
        vehicleBrand: '',
        vehicleModel: '',
      },
      customerNotes: options.notes || '',
    });

    // Update quote status
    quote.status = QuoteStatus.ACCEPTED;
    (quote as any).selectedProviderId = providerId;
    (quote as any).assignedOperatorId = operatorId;
    await quote.save();

    // Emit events
    await this.eventBus.emit(PlatformEvent.BOOKING_CREATED, {
      bookingId: String(booking._id),
      customerId: String(quote.userId),
      providerId,
      requestId,
    });

    return {
      success: true,
      bookingId: String(booking._id),
      message: 'Booking created successfully',
    };
  }

  /**
   * Get distribution logs for a request
   */
  async getDistributionLogs(requestId: string): Promise<any[]> {
    return this.distributionModel
      .find({ requestId })
      .populate('providerId', 'name rating')
      .sort({ matchingScore: -1 })
      .lean();
  }

  /**
   * Get live requests for map (requests with location)
   */
  async getLiveRequestsForMap(params: {
    lat?: number;
    lng?: number;
    radius?: number;
    limit?: number;
    status?: string[];
  } = {}): Promise<any[]> {
    const {
      lat = 55.7558,  // Moscow
      lng = 37.6173,  // Moscow
      radius = 50,
      limit = 100,
      status = ['pending', 'in_review', 'responded'],
    } = params;

    const quotes = await this.quoteModel.aggregate([
      {
        $match: {
          status: { $in: status },
          'location.coordinates': { $exists: true },
        },
      },
      {
        $addFields: {
          // Approximate distance calculation
          distanceKm: {
            $sqrt: {
              $add: [
                { $pow: [{ $multiply: [{ $subtract: [{ $arrayElemAt: ['$location.coordinates', 0] }, lng] }, 111.32] }, 2] },
                { $pow: [{ $multiply: [{ $subtract: [{ $arrayElemAt: ['$location.coordinates', 1] }, lat] }, 110.57] }, 2] },
              ],
            },
          },
        },
      },
      {
        $match: {
          distanceKm: { $lte: radius },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'userId',
          foreignField: '_id',
          as: 'customer',
        },
      },
      {
        $addFields: {
          customer: { $arrayElemAt: ['$customer', 0] },
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $limit: limit,
      },
      {
        $project: {
          _id: 1,
          status: 1,
          description: 1,
          urgency: 1,
          city: 1,
          location: 1,
          createdAt: 1,
          expiresAt: 1,
          responsesCount: 1,
          distanceKm: 1,
          'customer.firstName': 1,
          'customer.lastName': 1,
          'customer.phone': 1,
        },
      },
    ]);

    return quotes.map((q: any) => ({
      id: String(q._id),
      lat: q.location?.coordinates?.[1] || lat,
      lng: q.location?.coordinates?.[0] || lng,
      status: q.status,
      urgency: q.urgency || 'normal',
      description: q.description,
      city: q.city,
      responsesCount: q.responsesCount || 0,
      customerName: q.customer ? `${q.customer.firstName || ''} ${q.customer.lastName || ''}`.trim() : 'Клиент',
      createdAt: q.createdAt,
      expiresAt: q.expiresAt,
      waitingMinutes: Math.round((Date.now() - new Date(q.createdAt).getTime()) / 60000),
    }));
  }

  /**
   * Get matching providers for a specific request (for map overlay)
   */
  async getMatchingProvidersForRequest(requestId: string): Promise<any> {
    const quote = await this.quoteModel.findById(requestId).lean();
    if (!quote) throw new NotFoundException('Request not found');

    const candidates = await this.findMatchingCandidates(requestId, 10);
    const distributions = await this.getDistributionLogs(requestId);

    // Merge distribution status into candidates
    const distributionMap = new Map(distributions.map((d: any) => [String(d.providerId._id || d.providerId), d]));

    return {
      request: {
        id: String((quote as any)._id),
        lat: (quote as any).location?.coordinates?.[1] || 55.7558,
        lng: (quote as any).location?.coordinates?.[0] || 37.6173,
        status: (quote as any).status,
        description: (quote as any).description,
        urgency: (quote as any).urgency || 'normal',
        createdAt: (quote as any).createdAt,
      },
      providers: candidates.map(c => ({
        ...c,
        distributionStatus: distributionMap.get(c.providerId)?.distributionStatus || 'not_sent',
        responsePrice: distributionMap.get(c.providerId)?.responsePrice,
        responseEta: distributionMap.get(c.providerId)?.responseEta,
      })),
    };
  }
}
