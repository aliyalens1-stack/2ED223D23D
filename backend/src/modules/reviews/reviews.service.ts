import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateReviewDto } from './dto/create-review.dto';

@Injectable()
export class ReviewsService {
  constructor(
    @InjectModel('Review') private readonly reviewModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
  ) {}

  async create(userId: string, dto: CreateReviewDto) {
    // Check booking exists and belongs to user
    const booking: any = await this.bookingModel.findById(dto.bookingId).lean();
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (String(booking.userId) !== userId) {
      throw new BadRequestException('Not authorized to review this booking');
    }

    if (booking.status !== 'completed') {
      throw new BadRequestException('Can only review completed bookings');
    }

    // Check if review already exists
    const existingReview = await this.reviewModel.findOne({ bookingId: dto.bookingId });
    if (existingReview) {
      throw new ConflictException('Review already exists for this booking');
    }

    // Get user info for snapshot
    const user: any = await this.userModel.findById(userId).lean();

    const review = await this.reviewModel.create({
      userId: new Types.ObjectId(userId),
      organizationId: booking.organizationId,
      branchId: booking.branchId,
      bookingId: new Types.ObjectId(dto.bookingId),
      rating: dto.rating,
      comment: dto.comment || '',
      snapshot: {
        serviceName: booking.snapshot?.serviceName || '',
        userName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
        vehicleInfo: booking.snapshot?.vehicleBrand
          ? `${booking.snapshot.vehicleBrand} ${booking.snapshot.vehicleModel || ''}`.trim()
          : '',
      },
      status: 'active',
    });

    // Update organization rating
    await this.updateOrganizationRating(String(booking.organizationId));

    return review;
  }

  async getByOrganization(organizationId: string, options?: { limit?: number; skip?: number }) {
    const limit = options?.limit || 20;
    const skip = options?.skip || 0;

    const reviews = await this.reviewModel
      .find({ organizationId: new Types.ObjectId(organizationId), status: 'active' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const total = await this.reviewModel.countDocuments({
      organizationId: new Types.ObjectId(organizationId),
      status: 'active',
    });

    return { reviews, total };
  }

  async getByUser(userId: string) {
    return this.reviewModel
      .find({ userId: new Types.ObjectId(userId), status: 'active' })
      .sort({ createdAt: -1 })
      .lean();
  }

  async getByBooking(bookingId: string) {
    return this.reviewModel.findOne({ bookingId: new Types.ObjectId(bookingId) }).lean();
  }

  async getOrganizationStats(organizationId: string) {
    const result = await this.reviewModel.aggregate([
      { $match: { organizationId: new Types.ObjectId(organizationId), status: 'active' } },
      {
        $group: {
          _id: null,
          averageRating: { $avg: '$rating' },
          totalReviews: { $sum: 1 },
          rating1: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
          rating2: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
          rating3: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
          rating4: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
          rating5: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        },
      },
    ]);

    if (result.length === 0) {
      return { averageRating: 0, totalReviews: 0, distribution: {} };
    }

    const stats = result[0];
    return {
      averageRating: Math.round(stats.averageRating * 10) / 10,
      totalReviews: stats.totalReviews,
      distribution: {
        1: stats.rating1,
        2: stats.rating2,
        3: stats.rating3,
        4: stats.rating4,
        5: stats.rating5,
      },
    };
  }

  private async updateOrganizationRating(organizationId: string) {
    const stats = await this.getOrganizationStats(organizationId);
    await this.organizationModel.findByIdAndUpdate(organizationId, {
      $set: {
        rating: stats.averageRating,
        reviewsCount: stats.totalReviews,
      },
    });
  }
}
