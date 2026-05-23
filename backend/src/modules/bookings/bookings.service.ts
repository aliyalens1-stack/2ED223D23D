import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { BookingStatus, UserRole } from '../../shared/enums';
import { EventBus, PlatformEvent } from '../../shared/events';
import { RankingService } from '../organizations/ranking.service';

const allowedTransitions: Record<string, BookingStatus[]> = {
  [BookingStatus.DRAFT]: [BookingStatus.PENDING, BookingStatus.CANCELLED],
  [BookingStatus.PENDING]: [BookingStatus.CONFIRMED, BookingStatus.CANCELLED],
  [BookingStatus.CONFIRMED]: [
    BookingStatus.ON_ROUTE,  // NEW: Provider starts driving
    BookingStatus.IN_PROGRESS, // Can skip on_route for in-place services
    BookingStatus.CANCELLED,
    BookingStatus.NO_SHOW,
  ],
  [BookingStatus.ON_ROUTE]: [
    BookingStatus.ARRIVED,
    BookingStatus.CANCELLED,
  ],
  [BookingStatus.ARRIVED]: [
    BookingStatus.IN_PROGRESS,
    BookingStatus.CANCELLED,
    BookingStatus.NO_SHOW,
  ],
  [BookingStatus.IN_PROGRESS]: [
    BookingStatus.COMPLETED,
    BookingStatus.CANCELLED,
    BookingStatus.DISPUTED,
  ],
  // Terminal states
  [BookingStatus.COMPLETED]: [BookingStatus.DISPUTED],
  [BookingStatus.CANCELLED]: [],
  [BookingStatus.NO_SHOW]: [],
  [BookingStatus.DISPUTED]: [],
};

// Statuses that only provider/admin can set
const providerOnlyStatuses = new Set([
  BookingStatus.CONFIRMED,
  BookingStatus.ON_ROUTE,
  BookingStatus.ARRIVED,
  BookingStatus.IN_PROGRESS,
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
]);

// Map status to event
const statusToEvent: Partial<Record<BookingStatus, PlatformEvent>> = {
  [BookingStatus.CONFIRMED]: PlatformEvent.BOOKING_CONFIRMED,
  [BookingStatus.ON_ROUTE]: PlatformEvent.BOOKING_ON_ROUTE,
  [BookingStatus.ARRIVED]: PlatformEvent.BOOKING_ARRIVED,
  [BookingStatus.IN_PROGRESS]: PlatformEvent.BOOKING_STARTED,
  [BookingStatus.COMPLETED]: PlatformEvent.BOOKING_COMPLETED,
  [BookingStatus.CANCELLED]: PlatformEvent.BOOKING_CANCELLED,
  [BookingStatus.NO_SHOW]: PlatformEvent.BOOKING_NO_SHOW,
};

@Injectable()
export class BookingsService {
  constructor(
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Audit') private readonly auditModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('BookingSlot') private readonly slotModel: Model<any>,
    private readonly eventBus: EventBus,
    private readonly rankingService: RankingService,
  ) {}

  async myBookings(userId: string, options?: { vehicleId?: string; status?: string }) {
    const query: any = { userId };
    if (options?.vehicleId) query.vehicleId = options.vehicleId;
    if (options?.status) query.status = options.status;
    return this.bookingModel.find(query).sort({ createdAt: -1 }).lean();
  }

  async getById(bookingId: string) {
    const booking = await this.bookingModel.findById(bookingId).lean();
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async incomingBookings(organizationId?: string) {
    const query: any = {};
    if (organizationId) query.organizationId = organizationId;
    return this.bookingModel.find(query).sort({ createdAt: -1 }).lean();
  }

  async updateStatus(
    bookingId: string,
    actorId: string,
    actorRole: UserRole,
    nextStatus: BookingStatus,
  ) {
    const booking = await this.bookingModel.findById(bookingId);
    if (!booking) throw new NotFoundException('Booking not found');

    const current = booking.status as BookingStatus;
    const allowed = allowedTransitions[current] || [];

    if (!allowed.includes(nextStatus)) {
      throw new BadRequestException(
        `Invalid transition: ${current} -> ${nextStatus}`,
      );
    }

    // Check role permissions
    if (
      providerOnlyStatuses.has(nextStatus) &&
      actorRole !== UserRole.PROVIDER_OWNER &&
      actorRole !== UserRole.PROVIDER_MANAGER &&
      actorRole !== UserRole.PROVIDER_STAFF &&
      actorRole !== UserRole.ADMIN
    ) {
      throw new BadRequestException('Only provider/admin can set this status');
    }

    // Customer can only cancel their own bookings
    if (
      nextStatus === BookingStatus.CANCELLED &&
      actorRole === UserRole.CUSTOMER &&
      String(booking.userId) !== actorId
    ) {
      throw new BadRequestException('Cannot cancel another user booking');
    }

    const prev = booking.status;
    booking.status = nextStatus;

    // Track timestamps for Current Job
    const now = new Date();
    if (nextStatus === BookingStatus.ON_ROUTE) {
      booking.routeStartedAt = now;
    }
    if (nextStatus === BookingStatus.ARRIVED) {
      booking.arrivedAt = now;
    }
    if (nextStatus === BookingStatus.IN_PROGRESS) {
      booking.workStartedAt = now;
    }
    if (nextStatus === BookingStatus.COMPLETED) {
      booking.completedAt = now;
    }
    if (nextStatus === BookingStatus.CANCELLED) {
      booking.cancelledAt = now;
      booking.cancelledBy = actorId;
      // Release the slot when booking is cancelled
      if (booking.slotId) {
        await this.slotModel.findByIdAndUpdate(booking.slotId, {
          $set: { status: 'available', bookingId: null },
        });
      }
    }
    if (nextStatus === BookingStatus.NO_SHOW) {
      booking.noShow = true;
    }

    await booking.save();

    // Audit log (no transaction)
    try {
      await this.auditModel.create({
        entity: 'Booking',
        entityId: String(booking._id),
        action: 'BOOKING_STATUS_CHANGED',
        actorId,
        prev: { status: prev },
        next: { status: nextStatus },
      });
    } catch (err) {
      console.error('Audit log failed:', err);
    }

    // Emit event for notifications
    const event = statusToEvent[nextStatus];
    if (event) {
      let providerId: string | undefined;
      if (booking.organizationId) {
        const org = await this.organizationModel.findById(booking.organizationId);
        providerId = org?.ownerId ? String(org.ownerId) : undefined;
      }

      await this.eventBus.emit(event, {
        bookingId: String(booking._id),
        customerId: String(booking.userId),
        providerId,
        cancelledBy: nextStatus === BookingStatus.CANCELLED ? actorId : undefined,
        scheduledAt: booking.scheduledAt,
        serviceName: booking.snapshot?.serviceName,
      });
    }

    // Update ranking when booking completed
    if (nextStatus === BookingStatus.COMPLETED && booking.organizationId) {
      setImmediate(async () => {
        try {
          await this.rankingService.onBookingCompleted(String(booking.organizationId));
        } catch (err) {
          console.error('Failed to update ranking on booking completed:', err);
        }
      });
    }

    return booking;
  }
}
