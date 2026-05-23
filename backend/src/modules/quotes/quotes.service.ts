import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { RespondQuoteDto } from './dto/respond-quote.dto';
import { QuoteStatus, UserRole, BookingStatus } from '../../shared/enums';
import { EventBus, PlatformEvent } from '../../shared/events';
import { RankingService } from '../organizations/ranking.service';

// Helper to validate ObjectId
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

@Injectable()
export class QuotesService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('QuoteResponse') private readonly quoteResponseModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('ProviderService') private readonly providerServiceModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('Audit') private readonly auditModel: Model<any>,
    private readonly eventBus: EventBus,
    private readonly rankingService: RankingService,
  ) {}

  async create(userId: string, dto: CreateQuoteDto) {
    const quote = await this.quoteModel.create({
      userId,
      vehicleId: dto.vehicleId || null,
      requestedServiceId: dto.requestedServiceId || dto.serviceId || null,
      description: dto.description,
      city: dto.city || dto.cityId || null,
      status: QuoteStatus.PENDING,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      // New geo fields
      location: (dto as any).location ? {
        type: 'Point',
        coordinates: [(dto as any).location.lng, (dto as any).location.lat],
      } : null,
      locationSource: (dto as any).locationSource || 'gps',
      urgency: (dto as any).urgency || 'normal',
      source: (dto as any).source || 'detailed',
    });

    await this.auditModel.create({
      entity: 'Quote',
      entityId: String(quote._id),
      action: 'QUOTE_CREATED',
      actorId: userId,
      prev: null,
      next: { status: quote.status },
    });

    // Emit event for notifications
    await this.eventBus.emit(PlatformEvent.QUOTE_CREATED, {
      quoteId: String(quote._id),
      customerId: userId,
      cityId: dto.city,
      description: dto.description,
    });

    return quote;
  }

  async myQuotes(userId: string) {
    return this.quoteModel.find({ userId }).sort({ createdAt: -1 }).lean();
  }

  async getById(quoteId: string) {
    const quote = await this.quoteModel.findById(quoteId).lean();
    if (!quote) throw new NotFoundException('Quote not found');

    const responses = await this.quoteResponseModel
      .find({ quoteId })
      .lean();

    // Enrich responses with org/branch/service data
    const enrichedResponses = await Promise.all(
      responses.map(async (resp: any) => {
        const org = resp.providerId
          ? await this.organizationModel.findById(resp.providerId).lean()
          : null;
        const branch = resp.branchId
          ? await this.branchModel.findById(resp.branchId).lean()
          : null;
        const ps = resp.providerServiceId
          ? await this.providerServiceModel.findById(resp.providerServiceId).lean()
          : null;
        return {
          ...resp,
          snapshot: {
            orgName: (org as any)?.name || 'СТО',
            branchName: (branch as any)?.name || '',
            branchAddress: (branch as any)?.address || '',
            serviceName: (ps as any)?.description || 'Услуга',
            rating: (org as any)?.rating || 5.0,
          },
        };
      }),
    );

    // Enrich quote with service name
    let serviceName = '';
    const quoteData = quote as any;
    if (quoteData.requestedServiceId) {
      const svc = await this.connection.model('Service').findById(quoteData.requestedServiceId).lean();
      if (svc) serviceName = (svc as any).name || '';
    }

    return {
      ...quote,
      responses: enrichedResponses,
      snapshot: { serviceName },
    };
  }

  async incomingQuotes() {
    return this.quoteModel
      .find({
        status: {
          $in: [QuoteStatus.PENDING, QuoteStatus.IN_REVIEW, QuoteStatus.RESPONDED],
        },
      })
      .sort({ createdAt: -1 })
      .lean();
  }

  async respond(
    quoteId: string,
    actorId: string,
    actorRole: UserRole,
    dto: RespondQuoteDto,
  ) {
    if (
      actorRole !== UserRole.PROVIDER_OWNER &&
      actorRole !== UserRole.PROVIDER_MANAGER &&
      actorRole !== UserRole.ADMIN
    ) {
      throw new BadRequestException('Only provider can respond');
    }

    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');

    if (
      quote.status !== QuoteStatus.PENDING &&
      quote.status !== QuoteStatus.IN_REVIEW &&
      quote.status !== QuoteStatus.RESPONDED
    ) {
      throw new BadRequestException('Quote is not accepting responses');
    }

    const branch = await this.branchModel.findById(dto.branchId);
    if (!branch) throw new NotFoundException('Branch not found');

    const providerService = await this.providerServiceModel.findById(dto.providerServiceId);
    if (!providerService) throw new NotFoundException('Provider service not found');

    // Get organization from branch
    const organization = await this.organizationModel.findById(branch.organizationId);
    if (!organization) throw new NotFoundException('Organization not found');

    await this.quoteResponseModel.create({
      quoteId,
      providerId: organization._id,
      branchId: dto.branchId,
      providerServiceId: dto.providerServiceId,
      price: dto.price,
      message: dto.message || '',
    });

    const prev = quote.status;

    if (quote.status === QuoteStatus.PENDING) {
      quote.status = QuoteStatus.IN_REVIEW;
    }
    if (quote.status === QuoteStatus.IN_REVIEW) {
      quote.status = QuoteStatus.RESPONDED;
    }

    quote.responsesCount = (quote.responsesCount || 0) + 1;
    await quote.save();

    await this.auditModel.create({
      entity: 'Quote',
      entityId: String(quote._id),
      action: 'QUOTE_RESPONDED',
      actorId,
      prev: { status: prev },
      next: { status: quote.status },
    });

    // Emit event for notifications
    await this.eventBus.emit(PlatformEvent.QUOTE_RESPONDED, {
      quoteId: String(quote._id),
      customerId: String(quote.userId),
      providerId: String(organization._id),
      responseId: String(quote._id),
      price: dto.price,
    });

    // Update ranking: calculate response time and update score
    const quoteCreatedAt = new Date(quote.createdAt).getTime();
    const responseTimeMinutes = (Date.now() - quoteCreatedAt) / 60000;
    await this.rankingService.updateResponseTime(String(organization._id), responseTimeMinutes);

    return { success: true, quoteStatus: quote.status };
  }

  async accept(quoteId: string, responseId: string, userId: string) {
    // Validate ObjectIds first
    if (!isValidObjectId(quoteId)) {
      throw new NotFoundException('Quote not found');
    }
    if (!isValidObjectId(responseId)) {
      throw new BadRequestException('Invalid response ID');
    }

    // Use findOneAndUpdate with atomic check for race condition protection
    const quote = await this.quoteModel.findOneAndUpdate(
      {
        _id: quoteId,
        userId: userId,
        status: QuoteStatus.RESPONDED, // Only accept if status is RESPONDED
      },
      { $set: { status: QuoteStatus.ACCEPTED } },
      { new: false }, // Return original to check if update happened
    );

    if (!quote) {
      // Check why it failed
      const existingQuote = await this.quoteModel.findById(quoteId);
      if (!existingQuote) {
        throw new NotFoundException('Quote not found');
      }
      if (String(existingQuote.userId) !== userId) {
        throw new ForbiddenException('You can only accept your own quotes');
      }
      if (existingQuote.status === QuoteStatus.ACCEPTED) {
        throw new BadRequestException('Quote already accepted');
      }
      if (existingQuote.status === QuoteStatus.CANCELLED) {
        throw new BadRequestException('Quote is cancelled');
      }
      if (existingQuote.status === QuoteStatus.EXPIRED) {
        throw new BadRequestException('Quote is expired');
      }
      throw new BadRequestException('Quote is not ready for accept (status: ' + existingQuote.status + ')');
    }

    // Check if quote is expired
    if (quote.expiresAt && new Date(quote.expiresAt) < new Date()) {
      // Revert quote status
      await this.quoteModel.findByIdAndUpdate(quoteId, { status: QuoteStatus.EXPIRED });
      throw new BadRequestException('Quote has expired');
    }

    const response = await this.quoteResponseModel.findById(responseId);
    if (!response || String(response.quoteId) !== quoteId) {
      // Revert quote status
      await this.quoteModel.findByIdAndUpdate(quoteId, { status: QuoteStatus.RESPONDED });
      throw new BadRequestException('Response not found for this quote');
    }

    // Get related entities
    const provider = await this.organizationModel.findById(response.providerId);
    const branch = await this.branchModel.findById(response.branchId);
    const providerService = await this.providerServiceModel
      .findById(response.providerServiceId)
      .populate('serviceId');
    const user = await this.connection.model('User').findById(userId);

    // Mark all responses as not selected, then mark the chosen one
    await this.quoteResponseModel.updateMany(
      { quoteId },
      { $set: { isSelected: false } },
    );

    response.isSelected = true;
    await response.save();

    // Create booking
    const booking = await this.bookingModel.create({
      userId,
      organizationId: provider?._id,
      branchId: branch?._id,
      providerServiceId: providerService?._id,
      quoteId: quote._id,
      quoteResponseId: response._id,
      status: BookingStatus.PENDING,
      snapshot: {
        orgName: provider?.name || '',
        branchName: branch?.name || branch?.address || '',
        branchAddress: branch?.address || '',
        serviceName: (providerService as any)?.serviceId?.name || '',
        price: response.price,
        customerName: user ? `${(user as any).firstName} ${(user as any).lastName}` : '',
        vehicleBrand: '',
        vehicleModel: '',
      },
    });

    // Audit logs (non-blocking)
    try {
      await this.auditModel.create([
        {
          entity: 'Quote',
          entityId: String(quote._id),
          action: 'QUOTE_ACCEPTED',
          actorId: userId,
          prev: { status: QuoteStatus.RESPONDED },
          next: { status: QuoteStatus.ACCEPTED },
        },
        {
          entity: 'Booking',
          entityId: String(booking._id),
          action: 'BOOKING_CREATED_FROM_QUOTE',
          actorId: userId,
          prev: null,
          next: { status: booking.status },
        },
      ]);
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    return booking;
  }

  async cancel(quoteId: string, userId: string) {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');

    if (String(quote.userId) !== userId) {
      throw new BadRequestException('Forbidden');
    }

    const cancellable = [QuoteStatus.PENDING, QuoteStatus.IN_REVIEW, QuoteStatus.RESPONDED];
    if (!cancellable.includes(quote.status as QuoteStatus)) {
      throw new BadRequestException('Quote cannot be cancelled in current status');
    }

    const prev = quote.status;
    quote.status = QuoteStatus.CANCELLED;
    await quote.save();

    await this.auditModel.create({
      entity: 'Quote',
      entityId: String(quote._id),
      action: 'QUOTE_CANCELLED',
      actorId: userId,
      prev: { status: prev },
      next: { status: quote.status },
    });

    return quote;
  }
}
