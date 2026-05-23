import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { BookingStatus, UserRole } from '../../shared/enums';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * CurrentJobService - Manages the active job lifecycle for providers
 * 
 * This is the execution layer that transforms a booking into a real service delivery:
 * - Provider Current Job screen data
 * - Customer Live Booking data
 * - Location updates
 * - Status transitions
 * - ETA calculations
 */
@Injectable()
export class CurrentJobService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Get organization ID from user ID (for providers)
   */
  async getOrganizationIdFromUser(userId: string): Promise<string | null> {
    try {
      // Try direct connection query (more reliable)
      const UserModel = this.connection.model('User');
      const user = await UserModel.findById(userId).lean() as any;
      console.log(`[CurrentJob] getOrganizationIdFromUser: user found:`, user?.organizationId);
      if (user?.organizationId) {
        return String(user.organizationId);
      }
      // Check if user owns an organization (ownerId may be stored as ObjectId OR plain string in seed data).
      // We bypass mongoose schema casting by using the raw collection driver to allow string-ownerId matches.
      let org: any = null;
      try {
        org = await this.organizationModel.findOne({ ownerId: new Types.ObjectId(userId) }).lean();
      } catch { /* ignore cast error */ }
      if (!org) {
        try {
          org = await (this.connection as any).db
            .collection('organizations')
            .findOne({ ownerId: userId });
        } catch { /* ignore */ }
      }
      if (org) {
        console.log(`[CurrentJob] getOrganizationIdFromUser: owner org found:`, org._id);
        return String(org._id);
      }
      return null;
    } catch (error) {
      console.error(`[CurrentJob] getOrganizationIdFromUser error:`, error);
      return null;
    }
  }

  /**
   * Get provider's current active job
   * Returns the most recent active booking for this provider
   */
  async getProviderCurrentJob(userIdOrOrgId: string): Promise<any> {
    // First try to get organization ID from user
    let providerId = userIdOrOrgId;
    const orgFromUser = await this.getOrganizationIdFromUser(userIdOrOrgId);
    if (orgFromUser) {
      providerId = orgFromUser;
    }

    // Find active booking for this provider
    const activeStatuses = [
      BookingStatus.PENDING,
      BookingStatus.CONFIRMED,
      BookingStatus.ON_ROUTE,
      BookingStatus.ARRIVED,
      BookingStatus.IN_PROGRESS,
    ];

    const booking = await this.bookingModel.findOne({
      organizationId: new Types.ObjectId(providerId),
      status: { $in: activeStatuses },
    }).sort({ createdAt: -1 });

    if (!booking) {
      return null;
    }

    // Get customer info
    const customer = await this.connection.model('User').findById(booking.userId).lean() as any;

    // Get organization (provider) info
    const organization = await this.organizationModel.findById(providerId).lean() as any;

    // Get branch location
    const branch = await this.branchModel.findById(booking.branchId).lean() as any;

    // Calculate ETA based on current data
    const etaInfo = this.calculateETA(booking);

    return {
      bookingId: String(booking._id),
      status: booking.status,
      
      // Service info
      service: {
        name: booking.snapshot?.serviceName || 'Услуга',
        price: booking.snapshot?.price || 0,
      },
      
      // Customer info
      customer: {
        name: booking.snapshot?.customerName || customer?.firstName || 'Клиент',
        phone: booking.snapshot?.customerPhone || customer?.phone || '',
      },
      
      // Vehicle info
      vehicle: {
        brand: booking.snapshot?.vehicleBrand || '',
        model: booking.snapshot?.vehicleModel || '',
      },
      
      // Location data
      customerLocation: booking.customerLocation?.coordinates
        ? { lat: booking.customerLocation.coordinates[1], lng: booking.customerLocation.coordinates[0] }
        : null,
      providerLocation: booking.providerLocation?.coordinates
        ? { lat: booking.providerLocation.coordinates[1], lng: booking.providerLocation.coordinates[0] }
        : branch?.location?.coordinates
          ? { lat: branch.location.coordinates[1], lng: branch.location.coordinates[0] }
          : null,
      
      // ETA & Distance
      etaMinutes: etaInfo.etaMinutes,
      distanceKm: etaInfo.distanceKm,
      
      // Route snapshot
      routeSnapshot: booking.routeSnapshot || null,
      
      // Timestamps for timeline
      createdAt: booking.createdAt,
      confirmedAt: booking.status !== BookingStatus.PENDING ? booking.updatedAt : null,
      routeStartedAt: booking.routeStartedAt,
      arrivedAt: booking.arrivedAt,
      workStartedAt: booking.workStartedAt,
      completedAt: booking.completedAt,
      
      // Notes
      customerNotes: booking.customerNotes || '',
      
      // Actions available based on status
      availableActions: this.getAvailableActions(booking.status),
    };
  }

  /**
   * Get customer's live booking view
   */
  async getCustomerLiveBooking(bookingId: string, userId: string): Promise<any> {
    const booking = await this.bookingModel.findOne({
      _id: bookingId,
      userId: new Types.ObjectId(userId),
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // Get provider info
    const organization = await this.organizationModel.findById(booking.organizationId).lean() as any;
    const branch = await this.branchModel.findById(booking.branchId).lean() as any;

    // Calculate ETA
    const etaInfo = this.calculateETA(booking);

    // Build timeline
    const timeline = this.buildTimeline(booking);

    return {
      bookingId: String(booking._id),
      status: booking.status,
      
      // Provider info
      provider: {
        name: organization?.name || booking.snapshot?.orgName || 'Мастер',
        rating: organization?.rating || 5.0,
        phone: organization?.phone || '',
      },
      
      // Service info
      service: {
        name: booking.snapshot?.serviceName || 'Услуга',
        price: booking.snapshot?.price || 0,
      },
      
      // Address
      branchAddress: booking.snapshot?.branchAddress || branch?.address || '',
      
      // Location data
      customerLocation: booking.customerLocation?.coordinates
        ? { lat: booking.customerLocation.coordinates[1], lng: booking.customerLocation.coordinates[0] }
        : null,
      providerLocation: booking.providerLocation?.coordinates
        ? { lat: booking.providerLocation.coordinates[1], lng: booking.providerLocation.coordinates[0] }
        : null,
      
      // ETA
      etaMinutes: etaInfo.etaMinutes,
      distanceKm: etaInfo.distanceKm,
      
      // Status timeline
      timeline,
      
      // Trust signals
      trustSignals: {
        isVerified: organization?.isVerified || false,
        completedBookings: organization?.completedBookingsCount || 0,
        responseRate: organization?.responseRate || 0,
      },
      
      // Can cancel?
      canCancel: this.canCancel(booking.status),
      
      createdAt: booking.createdAt,
    };
  }

  /**
   * Update provider location during on_route
   */
  async updateProviderLocation(
    bookingId: string,
    userIdOrOrgId: string,
    location: { lat: number; lng: number }
  ): Promise<{ success: boolean; etaMinutes: number }> {
    // Resolve organization ID
    let providerId = userIdOrOrgId;
    const orgFromUser = await this.getOrganizationIdFromUser(userIdOrOrgId);
    if (orgFromUser) {
      providerId = orgFromUser;
    }

    const booking = await this.bookingModel.findOne({
      _id: bookingId,
      organizationId: new Types.ObjectId(providerId),
      status: BookingStatus.ON_ROUTE,
    });

    if (!booking) {
      throw new NotFoundException('Active booking not found');
    }

    // Update location
    booking.providerLocation = {
      type: 'Point',
      coordinates: [location.lng, location.lat],
    };
    booking.providerLocationUpdatedAt = new Date();

    // Recalculate ETA
    const etaInfo = this.calculateETA(booking);
    booking.estimatedEtaMinutes = etaInfo.etaMinutes;
    booking.estimatedDistanceKm = etaInfo.distanceKm;

    await booking.save();

    // Emit location update event
    await this.eventBus.emit(PlatformEvent.BOOKING_LOCATION_UPDATED, {
      bookingId: String(booking._id),
      customerId: String(booking.userId),
      providerId,
      location,
      etaMinutes: etaInfo.etaMinutes,
    });

    return {
      success: true,
      etaMinutes: etaInfo.etaMinutes,
    };
  }

  /**
   * Provider status action - unified method for status changes
   */
  async providerStatusAction(
    bookingId: string,
    userIdOrOrgId: string,
    action: 'start_route' | 'arrive' | 'start_work' | 'complete' | 'no_show'
  ): Promise<any> {
    console.log(`[CurrentJob] providerStatusAction called: bookingId=${bookingId}, userIdOrOrgId=${userIdOrOrgId}, action=${action}`);
    
    try {
      // Resolve organization ID
      let providerId = userIdOrOrgId;
      const orgFromUser = await this.getOrganizationIdFromUser(userIdOrOrgId);
      console.log(`[CurrentJob] orgFromUser: ${orgFromUser}`);
      if (orgFromUser) {
        providerId = orgFromUser;
      }

      const booking = await this.bookingModel.findOne({
        _id: bookingId,
        organizationId: new Types.ObjectId(providerId),
      });
      console.log(`[CurrentJob] booking found: ${booking ? booking._id : 'null'}, status: ${booking?.status}`);

      if (!booking) {
        throw new NotFoundException('Booking not found');
      }

      const now = new Date();
      let newStatus: BookingStatus;
      let eventType: PlatformEvent;

      switch (action) {
        case 'start_route':
          if (booking.status !== BookingStatus.CONFIRMED) {
            throw new BadRequestException('Can only start route from confirmed status');
          }
          newStatus = BookingStatus.ON_ROUTE;
          booking.routeStartedAt = now;
          eventType = PlatformEvent.BOOKING_ON_ROUTE;
          break;

        case 'arrive':
          if (booking.status !== BookingStatus.ON_ROUTE) {
            throw new BadRequestException('Can only arrive from on_route status');
          }
          newStatus = BookingStatus.ARRIVED;
          booking.arrivedAt = now;
          eventType = PlatformEvent.BOOKING_ARRIVED;
          break;

        case 'start_work':
          if (booking.status !== BookingStatus.ARRIVED && booking.status !== BookingStatus.CONFIRMED) {
            throw new BadRequestException('Can only start work from arrived or confirmed status');
          }
          newStatus = BookingStatus.IN_PROGRESS;
          booking.workStartedAt = now;
          eventType = PlatformEvent.BOOKING_STARTED;
          break;

        case 'complete':
          if (booking.status !== BookingStatus.IN_PROGRESS) {
            throw new BadRequestException('Can only complete from in_progress status');
          }
          newStatus = BookingStatus.COMPLETED;
          booking.completedAt = now;
          eventType = PlatformEvent.BOOKING_COMPLETED;
          break;

        case 'no_show':
          if (booking.status !== BookingStatus.ARRIVED && booking.status !== BookingStatus.CONFIRMED) {
            throw new BadRequestException('Can only mark no_show from arrived or confirmed status');
          }
          newStatus = BookingStatus.NO_SHOW;
          booking.noShow = true;
          eventType = PlatformEvent.BOOKING_NO_SHOW;
          break;

        default:
          throw new BadRequestException('Unknown action');
      }

      console.log(`[CurrentJob] changing status from ${booking.status} to ${newStatus}`);
      booking.status = newStatus;
      await booking.save();
      console.log(`[CurrentJob] booking saved successfully`);

      // Emit event (non-blocking)
      try {
        await this.eventBus.emit(eventType, {
          bookingId: String(booking._id),
          customerId: String(booking.userId),
          providerId,
          timestamp: now,
        });
      } catch (err) {
        console.error('[CurrentJob] Event emit failed:', err);
      }

      return {
        success: true,
        newStatus,
        bookingId: String(booking._id),
      };
    } catch (error) {
      console.error(`[CurrentJob] Error in providerStatusAction:`, error);
      throw error;
    }
  }

  /**
   * Admin override for booking status
   */
  async adminOverrideStatus(
    bookingId: string,
    newStatus: BookingStatus,
    adminId: string,
    reason?: string
  ): Promise<any> {
    const booking = await this.bookingModel.findById(bookingId);
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    const prevStatus = booking.status;
    booking.status = newStatus;
    booking.providerNotes = (booking.providerNotes || '') + 
      `\n[Admin override at ${new Date().toISOString()}]: ${prevStatus} → ${newStatus}. Reason: ${reason || 'N/A'}`;

    await booking.save();

    return {
      success: true,
      prevStatus,
      newStatus,
    };
  }

  // ==================== HELPER METHODS ====================

  private calculateETA(booking: any): { etaMinutes: number; distanceKm: number } {
    // If we have stored estimates, use them
    if (booking.estimatedEtaMinutes && booking.status === BookingStatus.ON_ROUTE) {
      // Recalculate based on distance if we have locations
      if (booking.providerLocation?.coordinates && booking.customerLocation?.coordinates) {
        const distanceKm = this.calculateDistance(
          booking.providerLocation.coordinates[1],
          booking.providerLocation.coordinates[0],
          booking.customerLocation.coordinates[1],
          booking.customerLocation.coordinates[0]
        );
        // Assume 30 km/h average city speed
        const etaMinutes = Math.round((distanceKm / 30) * 60);
        return { etaMinutes: Math.max(1, etaMinutes), distanceKm: Math.round(distanceKm * 10) / 10 };
      }
    }

    return {
      etaMinutes: booking.estimatedEtaMinutes || 10,
      distanceKm: booking.estimatedDistanceKm || 0,
    };
  }

  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    // Haversine formula
    const R = 6371; // Earth radius in km
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

  private getAvailableActions(status: BookingStatus): string[] {
    switch (status) {
      case BookingStatus.CONFIRMED:
        return ['start_route', 'start_work', 'cancel'];
      case BookingStatus.ON_ROUTE:
        return ['arrive', 'call', 'cancel'];
      case BookingStatus.ARRIVED:
        return ['start_work', 'no_show', 'call'];
      case BookingStatus.IN_PROGRESS:
        return ['complete', 'call'];
      default:
        return [];
    }
  }

  private buildTimeline(booking: any): any[] {
    const timeline = [
      {
        status: 'confirmed',
        label: 'Мастер назначен',
        completed: booking.status !== BookingStatus.PENDING,
        timestamp: booking.createdAt,
      },
      {
        status: 'on_route',
        label: 'Выехал',
        completed: [BookingStatus.ON_ROUTE, BookingStatus.ARRIVED, BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status),
        timestamp: booking.routeStartedAt,
      },
      {
        status: 'arrived',
        label: 'Прибыл',
        completed: [BookingStatus.ARRIVED, BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status),
        timestamp: booking.arrivedAt,
      },
      {
        status: 'in_progress',
        label: 'Работа началась',
        completed: [BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status),
        timestamp: booking.workStartedAt,
      },
      {
        status: 'completed',
        label: 'Завершено',
        completed: booking.status === BookingStatus.COMPLETED,
        timestamp: booking.completedAt,
      },
    ];

    return timeline;
  }

  private canCancel(status: BookingStatus): boolean {
    return [BookingStatus.PENDING, BookingStatus.CONFIRMED].includes(status);
  }
}
