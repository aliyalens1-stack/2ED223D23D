import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { DisputeStatus, isDisputeTerminal } from './dispute.schema';
import { CreateDisputeDto, AddMessageDto, ResolveDisputeDto } from './dto/dispute.dto';
import { BookingStatus } from '../../shared/enums';

@Injectable()
export class DisputesService {
  constructor(
    @InjectModel('Dispute') private readonly disputeModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
  ) {}

  /**
   * Create a dispute for booking
   */
  async create(userId: string, dto: CreateDisputeDto) {
    // Get booking
    const booking: any = await this.bookingModel.findById(dto.bookingId).lean();
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Verify user owns this booking
    if (String(booking.userId) !== userId) {
      throw new BadRequestException('Not authorized');
    }

    // Check booking status - must be completed or in_progress
    if (!['completed', 'in_progress'].includes(booking.status)) {
      throw new BadRequestException('Can only dispute completed or in-progress bookings');
    }

    // Check if dispute already exists for this booking
    const existingDispute = await this.disputeModel.findOne({
      bookingId: dto.bookingId,
      status: { $nin: [DisputeStatus.RESOLVED, DisputeStatus.REJECTED] },
    });
    if (existingDispute) {
      throw new ConflictException('Active dispute already exists for this booking');
    }

    // Get user and payment
    const user: any = await this.userModel.findById(userId).lean();
    const payment: any = await this.paymentModel.findOne({ bookingId: dto.bookingId }).lean();

    // Create dispute
    const dispute = await this.disputeModel.create({
      bookingId: new Types.ObjectId(dto.bookingId),
      paymentId: payment ? payment._id : null,
      userId: new Types.ObjectId(userId),
      organizationId: booking.organizationId,
      reason: dto.reason,
      description: dto.description,
      status: DisputeStatus.OPEN,
      messages: [
        {
          senderId: new Types.ObjectId(userId),
          senderRole: 'customer',
          message: dto.description,
        },
      ],
      snapshot: {
        serviceName: booking.snapshot?.serviceName || '',
        orgName: booking.snapshot?.orgName || '',
        userName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
        amount: payment?.amount || booking.snapshot?.price || 0,
      },
    });

    return dispute;
  }

  /**
   * Get user's disputes
   */
  async getMyDisputes(userId: string) {
    return this.disputeModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Get dispute by ID
   */
  async getById(disputeId: string, userId?: string) {
    const dispute: any = await this.disputeModel.findById(disputeId).lean();
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    // If userId provided, verify access
    if (userId && String(dispute.userId) !== userId) {
      throw new BadRequestException('Not authorized');
    }

    return dispute;
  }

  /**
   * Add message to dispute
   */
  async addMessage(disputeId: string, userId: string, dto: AddMessageDto, role: string = 'customer') {
    const dispute: any = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    // Check if dispute is still open (I2 — terminal lock)
    if (isDisputeTerminal(dispute.status)) {
      throw new BadRequestException('Dispute is closed');
    }

    dispute.messages.push({
      senderId: new Types.ObjectId(userId),
      senderRole: role,
      message: dto.message,
    });

    // Update status to reviewing if it was open
    if (dispute.status === DisputeStatus.OPEN) {
      dispute.status = DisputeStatus.REVIEWING;
    }

    await dispute.save();
    return dispute;
  }

  /**
   * Resolve dispute (admin)
   */
  async resolve(disputeId: string, adminId: string, dto: ResolveDisputeDto) {
    const dispute: any = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }

    if (isDisputeTerminal(dispute.status)) {
      throw new BadRequestException('Dispute is already closed');
    }

    dispute.status = dto.status === 'rejected' ? DisputeStatus.REJECTED : DisputeStatus.RESOLVED;
    dispute.resolution = dto.resolution;
    dispute.resolvedBy = new Types.ObjectId(adminId);
    dispute.resolvedAt = new Date();

    // Add resolution message
    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: `[${dispute.status.toUpperCase()}] ${dto.resolution}`,
    });

    await dispute.save();
    return dispute;
  }

  /**
   * Get all disputes (admin)
   */
  async getAllDisputes(options?: { status?: string; limit?: number; skip?: number }) {
    const query: any = {};
    if (options?.status) {
      query.status = options.status;
    }

    const [disputes, total] = await Promise.all([
      this.disputeModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.disputeModel.countDocuments(query),
    ]);

    // Get stats
    const stats = await this.disputeModel.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const statsByStatus = stats.reduce((acc: any, s: any) => {
      acc[s._id] = s.count;
      return acc;
    }, {});

    return { disputes, total, stats: statsByStatus };
  }
}
