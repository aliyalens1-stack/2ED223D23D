import { Injectable, Logger } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { BookingStatus } from '../../shared/enums';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * LiveMovementService - Real-time provider movement tracking (Uber-like)
 * 
 * Features:
 * - Location updates with heading/speed
 * - ETA recalculation
 * - Smooth animation support (interpolation data)
 * - Auto-arrived trigger (< 100m)
 * - Anomaly detection (stuck, wrong direction)
 * - "Almost there" notification (< 200m)
 */
@Injectable()
export class LiveMovementService {
  private readonly logger = new Logger(LiveMovementService.name);
  
  // Thresholds
  private readonly AUTO_ARRIVED_DISTANCE_M = 100;
  private readonly ALMOST_THERE_DISTANCE_M = 200;
  private readonly STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MIN_MOVEMENT_M = 10; // Minimum movement to consider
  private readonly AVERAGE_CITY_SPEED_KMH = 25;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('ProviderLiveLocation') private readonly liveLocationModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Update provider location during active booking
   * This is the main method called every 5 seconds from provider app
   */
  async updateLocation(
    providerId: string,
    bookingId: string,
    location: {
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
    }
  ): Promise<{
    success: boolean;
    etaMinutes: number;
    distanceKm: number;
    isAlmostThere: boolean;
    autoArrived: boolean;
    anomaly?: string;
  }> {
    const now = new Date();

    // Get booking
    const booking = await this.bookingModel.findOne({
      _id: bookingId,
      organizationId: new Types.ObjectId(providerId),
      status: BookingStatus.ON_ROUTE,
    });

    if (!booking) {
      return {
        success: false,
        etaMinutes: 0,
        distanceKm: 0,
        isAlmostThere: false,
        autoArrived: false,
        anomaly: 'booking_not_found',
      };
    }

    // Get or create live location record
    let liveLocation = await this.liveLocationModel.findOne({ providerId, bookingId });
    if (!liveLocation) {
      liveLocation = new this.liveLocationModel({
        providerId: new Types.ObjectId(providerId),
        bookingId: new Types.ObjectId(bookingId),
        isOnline: true,
        recentLocations: [],
      });
    }

    // Store previous location for movement analysis
    const prevLat = liveLocation.location?.coordinates?.[1];
    const prevLng = liveLocation.location?.coordinates?.[0];
    const prevLocation = prevLat && prevLng ? { lat: prevLat, lng: prevLng } : null;

    // Update current location
    liveLocation.location = {
      type: 'Point',
      coordinates: [location.lng, location.lat],
    };
    liveLocation.heading = location.heading || this.calculateHeading(prevLocation, location);
    liveLocation.speed = location.speed || 0;
    liveLocation.accuracy = location.accuracy || 0;
    liveLocation.lastActivity = now;
    liveLocation.isOnline = true;

    // Add to recent locations history (keep last 10)
    liveLocation.recentLocations.push({
      lat: location.lat,
      lng: location.lng,
      timestamp: now,
    });
    if (liveLocation.recentLocations.length > 10) {
      liveLocation.recentLocations.shift();
    }

    // Calculate distance to customer
    const customerLat = booking.customerLocation?.coordinates?.[1];
    const customerLng = booking.customerLocation?.coordinates?.[0];
    
    let distanceKm = 0;
    let etaMinutes = 0;
    let isAlmostThere = false;
    let autoArrived = false;

    if (customerLat && customerLng) {
      distanceKm = this.calculateDistance(location.lat, location.lng, customerLat, customerLng);
      const distanceM = distanceKm * 1000;

      // Calculate ETA
      const speedKmh = liveLocation.speed > 0 ? liveLocation.speed : this.AVERAGE_CITY_SPEED_KMH;
      etaMinutes = Math.ceil((distanceKm / speedKmh) * 60);
      etaMinutes = Math.max(1, etaMinutes); // Minimum 1 minute

      // Check "almost there"
      if (distanceM <= this.ALMOST_THERE_DISTANCE_M && distanceM > this.AUTO_ARRIVED_DISTANCE_M) {
        isAlmostThere = true;
      }

      // Check auto-arrived
      if (distanceM <= this.AUTO_ARRIVED_DISTANCE_M) {
        autoArrived = true;
        
        // Auto transition to arrived status
        booking.status = BookingStatus.ARRIVED;
        booking.arrivedAt = now;
        await booking.save();

        // Emit arrived event
        await this.eventBus.emit(PlatformEvent.BOOKING_ARRIVED, {
          bookingId: String(booking._id),
          customerId: String(booking.userId),
          providerId,
          timestamp: now,
          autoTriggered: true,
        });

        this.logger.log(`[AutoArrived] Booking ${bookingId} auto-arrived (distance: ${distanceM.toFixed(0)}m)`);
      }

      // Update booking with new ETA and distance
      booking.estimatedEtaMinutes = etaMinutes;
      booking.estimatedDistanceKm = Math.round(distanceKm * 10) / 10;
      booking.providerLocation = {
        type: 'Point',
        coordinates: [location.lng, location.lat],
      };
      booking.providerLocationUpdatedAt = now;
      await booking.save();
    }

    // Anomaly detection
    const anomaly = await this.detectAnomalies(liveLocation, prevLocation, distanceKm, now);
    
    // Update total distance traveled
    if (prevLocation) {
      const segmentKm = this.calculateDistance(prevLocation.lat, prevLocation.lng, location.lat, location.lng);
      if (segmentKm * 1000 >= this.MIN_MOVEMENT_M) {
        liveLocation.totalDistanceKm += segmentKm;
        liveLocation.isStuck = false;
        liveLocation.stuckSince = null;
      }
    }

    await liveLocation.save();

    // Emit location update event
    await this.eventBus.emit(PlatformEvent.BOOKING_LOCATION_UPDATED, {
      bookingId: String(booking._id),
      customerId: String(booking.userId),
      providerId,
      location: {
        lat: location.lat,
        lng: location.lng,
        heading: liveLocation.heading,
      },
      etaMinutes,
      distanceKm,
      isAlmostThere,
    });

    return {
      success: true,
      etaMinutes,
      distanceKm: Math.round(distanceKm * 10) / 10,
      isAlmostThere,
      autoArrived,
      anomaly,
    };
  }

  /**
   * Get customer live view data (for polling or WebSocket)
   */
  async getCustomerLiveView(bookingId: string, customerId: string): Promise<any> {
    const booking = await this.bookingModel.findOne({
      _id: bookingId,
      userId: new Types.ObjectId(customerId),
    });

    if (!booking) {
      return null;
    }

    // Get provider live location
    const liveLocation = await this.liveLocationModel.findOne({
      bookingId: new Types.ObjectId(bookingId),
    });

    // Get organization info
    const organization = await this.organizationModel.findById(booking.organizationId).lean() as any;

    // Calculate current distance and ETA
    const providerLat = liveLocation?.location?.coordinates?.[1] || booking.providerLocation?.coordinates?.[1];
    const providerLng = liveLocation?.location?.coordinates?.[0] || booking.providerLocation?.coordinates?.[0];
    const customerLat = booking.customerLocation?.coordinates?.[1];
    const customerLng = booking.customerLocation?.coordinates?.[0];

    let distanceKm = 0;
    let etaMinutes = booking.estimatedEtaMinutes || 10;

    if (providerLat && providerLng && customerLat && customerLng) {
      distanceKm = this.calculateDistance(providerLat, providerLng, customerLat, customerLng);
      const speedKmh = liveLocation?.speed > 0 ? liveLocation.speed : this.AVERAGE_CITY_SPEED_KMH;
      etaMinutes = Math.ceil((distanceKm / speedKmh) * 60);
      etaMinutes = Math.max(1, etaMinutes);
    }

    const distanceM = distanceKm * 1000;

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

      // Location data (for map)
      providerLocation: providerLat && providerLng ? {
        lat: providerLat,
        lng: providerLng,
        heading: liveLocation?.heading || 0,
        speed: liveLocation?.speed || 0,
        updatedAt: liveLocation?.updatedAt || booking.providerLocationUpdatedAt,
      } : null,

      customerLocation: customerLat && customerLng ? {
        lat: customerLat,
        lng: customerLng,
      } : null,

      // ETA & Distance
      etaMinutes,
      distanceKm: Math.round(distanceKm * 10) / 10,
      distanceM: Math.round(distanceM),

      // Status indicators
      isAlmostThere: distanceM <= this.ALMOST_THERE_DISTANCE_M && distanceM > this.AUTO_ARRIVED_DISTANCE_M,
      isStuck: liveLocation?.isStuck || false,
      isMovingAway: liveLocation?.isMovingAway || false,

      // Status message for UI
      statusMessage: this.getStatusMessage(booking.status, distanceM, liveLocation),

      // Timeline
      timeline: this.buildTimeline(booking),

      // Trust signals
      trustSignals: {
        isVerified: organization?.isVerified || false,
        completedBookings: organization?.completedBookingsCount || 0,
        responseRate: organization?.responseRate || 0,
      },

      // Actions
      canCancel: [BookingStatus.PENDING, BookingStatus.CONFIRMED].includes(booking.status),

      // Timestamps
      createdAt: booking.createdAt,
      routeStartedAt: booking.routeStartedAt,
      arrivedAt: booking.arrivedAt,
    };
  }

  /**
   * Set provider online/offline status
   */
  async setProviderOnlineStatus(providerId: string, isOnline: boolean, location?: { lat: number; lng: number }): Promise<void> {
    const now = new Date();

    const update: any = {
      isOnline,
      lastActivity: now,
    };

    if (location) {
      update.location = {
        type: 'Point',
        coordinates: [location.lng, location.lat],
      };
    }

    await this.liveLocationModel.findOneAndUpdate(
      { providerId: new Types.ObjectId(providerId), bookingId: null },
      { $set: update },
      { upsert: true }
    );

    // Emit presence event
    await this.eventBus.emit(PlatformEvent.PROVIDER_PRESENCE_UPDATED, {
      providerId,
      isOnline,
      location,
      timestamp: now,
    });
  }

  /**
   * Get all online providers for admin map
   */
  async getOnlineProviders(bounds?: { minLat: number; maxLat: number; minLng: number; maxLng: number }): Promise<any[]> {
    const query: any = { isOnline: true };

    if (bounds) {
      query.location = {
        $geoWithin: {
          $box: [
            [bounds.minLng, bounds.minLat],
            [bounds.maxLng, bounds.maxLat],
          ],
        },
      };
    }

    const locations = await this.liveLocationModel.find(query)
      .populate('providerId', 'name rating')
      .lean();

    return locations.map((loc: any) => ({
      providerId: String(loc.providerId?._id || loc.providerId),
      providerName: loc.providerId?.name || 'Unknown',
      location: {
        lat: loc.location?.coordinates?.[1],
        lng: loc.location?.coordinates?.[0],
      },
      heading: loc.heading,
      speed: loc.speed,
      isOnline: loc.isOnline,
      hasActiveBooking: !!loc.bookingId,
      lastActivity: loc.lastActivity,
    }));
  }

  // ==================== HELPER METHODS ====================

  /**
   * Detect anomalies in provider movement
   */
  private async detectAnomalies(
    liveLocation: any,
    prevLocation: { lat: number; lng: number } | null,
    currentDistanceToCustomer: number,
    now: Date
  ): Promise<string | undefined> {
    // Check if stuck (no significant movement for 5 minutes)
    if (liveLocation.recentLocations.length >= 2) {
      const oldest = liveLocation.recentLocations[0];
      const newest = liveLocation.recentLocations[liveLocation.recentLocations.length - 1];
      
      const timeDiffMs = new Date(newest.timestamp).getTime() - new Date(oldest.timestamp).getTime();
      const distanceMoved = this.calculateDistance(oldest.lat, oldest.lng, newest.lat, newest.lng) * 1000;

      if (timeDiffMs > this.STUCK_TIMEOUT_MS && distanceMoved < 50) {
        if (!liveLocation.isStuck) {
          liveLocation.isStuck = true;
          liveLocation.stuckSince = now;
          return 'stuck';
        }
      }

      // Check if moving away from customer
      if (prevLocation && liveLocation.recentLocations.length >= 3) {
        // Compare last 3 distances
        const recentDistances = liveLocation.recentLocations.slice(-3).map((loc: any) => {
          const customerLat = liveLocation.location?.coordinates?.[1];
          const customerLng = liveLocation.location?.coordinates?.[0];
          if (!customerLat || !customerLng) return 0;
          return this.calculateDistance(loc.lat, loc.lng, customerLat, customerLng);
        });

        // If distance consistently increasing
        if (recentDistances[2] > recentDistances[1] && recentDistances[1] > recentDistances[0]) {
          if (recentDistances[2] - recentDistances[0] > 0.1) { // More than 100m increase
            liveLocation.isMovingAway = true;
            return 'moving_away';
          }
        } else {
          liveLocation.isMovingAway = false;
        }
      }
    }

    return undefined;
  }

  /**
   * Calculate heading from two points
   */
  private calculateHeading(from: { lat: number; lng: number } | null, to: { lat: number; lng: number }): number {
    if (!from) return 0;

    const dLng = this.toRad(to.lng - from.lng);
    const lat1 = this.toRad(from.lat);
    const lat2 = this.toRad(to.lat);

    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

    let heading = Math.atan2(y, x);
    heading = this.toDeg(heading);
    heading = (heading + 360) % 360;

    return Math.round(heading);
  }

  /**
   * Calculate distance between two points (Haversine)
   */
  private calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

  private toDeg(rad: number): number {
    return rad * (180 / Math.PI);
  }

  /**
   * Get status message for customer UI
   */
  private getStatusMessage(status: BookingStatus, distanceM: number, liveLocation: any): string {
    if (liveLocation?.isStuck) {
      return 'Мастер немного задерживается';
    }
    if (liveLocation?.isMovingAway) {
      return 'Мастер корректирует маршрут';
    }

    switch (status) {
      case BookingStatus.PENDING:
        return 'Ожидание подтверждения';
      case BookingStatus.CONFIRMED:
        return 'Мастер готовится выехать';
      case BookingStatus.ON_ROUTE:
        if (distanceM <= 200) return 'Мастер почти приехал!';
        if (distanceM <= 500) return 'Мастер совсем рядом';
        return 'Мастер едет к вам';
      case BookingStatus.ARRIVED:
        return 'Мастер прибыл';
      case BookingStatus.IN_PROGRESS:
        return 'Работа выполняется';
      case BookingStatus.COMPLETED:
        return 'Услуга выполнена';
      default:
        return 'Обработка заказа';
    }
  }

  /**
   * Build timeline for customer view
   */
  private buildTimeline(booking: any): any[] {
    return [
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
        active: booking.status === BookingStatus.ON_ROUTE,
      },
      {
        status: 'arrived',
        label: 'Прибыл',
        completed: [BookingStatus.ARRIVED, BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status),
        timestamp: booking.arrivedAt,
        active: booking.status === BookingStatus.ARRIVED,
      },
      {
        status: 'in_progress',
        label: 'Работа началась',
        completed: [BookingStatus.IN_PROGRESS, BookingStatus.COMPLETED].includes(booking.status),
        timestamp: booking.workStartedAt,
        active: booking.status === BookingStatus.IN_PROGRESS,
      },
      {
        status: 'completed',
        label: 'Завершено',
        completed: booking.status === BookingStatus.COMPLETED,
        timestamp: booking.completedAt,
      },
    ];
  }
}
