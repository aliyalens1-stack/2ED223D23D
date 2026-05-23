import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  ProviderLocation,
  ProviderLiveLocation,
  ProviderPresence,
  RequestLocation,
  GeoZone,
  GeoEvent,
  EtaCache,
} from './geo-core.schemas';
import { EventBusService } from '../realtime/event-bus.service';

// In-memory cache for live state (Redis replacement for MVP)
interface LiveState {
  providerId: string;
  lat: number;
  lng: number;
  accuracy?: number;
  heading?: number;
  speed?: number;
  onlineState: 'online' | 'idle' | 'offline';
  workState: 'available' | 'busy' | 'on_route' | 'in_job' | 'paused';
  lastSeenAt: Date;
  name?: string;
  rating?: number;
}

@Injectable()
export class GeoCoreService {
  private logger = new Logger('GeoCoreService');
  
  // In-memory live state cache (would be Redis in production)
  private liveProviders: Map<string, LiveState> = new Map();
  private liveRequests: Map<string, { lat: number; lng: number; serviceType: string; urgency: string; createdAt: Date }> = new Map();

  constructor(
    @InjectModel('ProviderLocation') private providerLocationModel: Model<ProviderLocation>,
    @InjectModel('ProviderLiveLocation') private liveLocationModel: Model<ProviderLiveLocation>,
    @InjectModel('ProviderPresence') private presenceModel: Model<ProviderPresence>,
    @InjectModel('RequestLocation') private requestLocationModel: Model<RequestLocation>,
    @InjectModel('GeoZone') private geoZoneModel: Model<GeoZone>,
    @InjectModel('GeoEvent') private geoEventModel: Model<GeoEvent>,
    @InjectModel('EtaCache') private etaCacheModel: Model<EtaCache>,
    private eventBus: EventBusService,
  ) {}

  // ============ PROVIDER LOCATION ============

  async updateProviderFixedLocation(
    providerId: string,
    data: {
      lat: number;
      lng: number;
      address?: string;
      cityId?: string;
      isMain?: boolean;
      serviceRadius?: number;
      source?: string;
    }
  ) {
    const location = await this.providerLocationModel.findOneAndUpdate(
      { providerId: new Types.ObjectId(providerId), isMain: true },
      {
        $set: {
          point: { type: 'Point', coordinates: [data.lng, data.lat] },
          address: data.address,
          cityId: data.cityId ? new Types.ObjectId(data.cityId) : undefined,
          serviceRadius: data.serviceRadius,
          source: data.source || 'self',
          isMain: true,
        },
      },
      { upsert: true, new: true }
    );

    this.logger.log(`Updated fixed location for provider ${providerId}`);
    return location;
  }

  async verifyProviderLocation(providerId: string) {
    const location = await this.providerLocationModel.findOneAndUpdate(
      { providerId: new Types.ObjectId(providerId), isMain: true },
      { $set: { isVerified: true, source: 'admin' } },
      { new: true }
    );

    if (location) {
      // Emit event
      this.eventBus.emit({
        type: 'provider.verified' as any,
        payload: { providerId, locationVerified: true },
        metadata: { providerId },
      });
    }

    return location;
  }

  // ============ LIVE LOCATION ============

  async updateProviderLiveLocation(
    providerId: string,
    data: {
      lat: number;
      lng: number;
      accuracy?: number;
      heading?: number;
      speed?: number;
      source?: string;
    }
  ) {
    // Update DB
    await this.liveLocationModel.findOneAndUpdate(
      { providerId: new Types.ObjectId(providerId) },
      {
        $set: {
          point: { type: 'Point', coordinates: [data.lng, data.lat] },
          accuracy: data.accuracy,
          heading: data.heading,
          speed: data.speed,
          source: data.source || 'gps',
          capturedAt: new Date(),
        },
      },
      { upsert: true }
    );

    // Update in-memory cache
    const existing = this.liveProviders.get(providerId);
    this.liveProviders.set(providerId, {
      ...existing,
      providerId,
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
      heading: data.heading,
      speed: data.speed,
      lastSeenAt: new Date(),
      onlineState: existing?.onlineState || 'online',
      workState: existing?.workState || 'available',
    });

    // Emit real-time event
    this.eventBus.providerLocationUpdated(
      { _id: providerId, name: existing?.name },
      { lat: data.lat, lng: data.lng }
    );

    // Log geo event
    await this.logGeoEvent('provider.location.updated', 'provider', providerId, data.lat, data.lng, {
      accuracy: data.accuracy,
      heading: data.heading,
      speed: data.speed,
    });

    return { success: true };
  }

  // ============ PRESENCE ============

  async updateProviderPresence(
    providerId: string,
    data: {
      onlineState?: 'online' | 'idle' | 'offline';
      workState?: 'available' | 'busy' | 'on_route' | 'in_job' | 'paused';
      acceptsQuickRequests?: boolean;
      currentBookingId?: string;
    }
  ) {
    const oldPresence = await this.presenceModel.findOne({ providerId: new Types.ObjectId(providerId) });
    
    const presence = await this.presenceModel.findOneAndUpdate(
      { providerId: new Types.ObjectId(providerId) },
      {
        $set: {
          ...data,
          lastSeenAt: new Date(),
          ...(data.onlineState === 'online' && !oldPresence?.onlineSince ? { onlineSince: new Date() } : {}),
          ...(data.onlineState === 'offline' ? { onlineSince: null } : {}),
        },
      },
      { upsert: true, new: true }
    );

    // Update in-memory cache
    const existing = this.liveProviders.get(providerId);
    if (existing || data.onlineState === 'online') {
      this.liveProviders.set(providerId, {
        ...existing,
        providerId,
        lat: existing?.lat || 0,
        lng: existing?.lng || 0,
        onlineState: data.onlineState || existing?.onlineState || 'offline',
        workState: data.workState || existing?.workState || 'available',
        lastSeenAt: new Date(),
      });
    }

    // Emit events
    if (data.onlineState && data.onlineState !== oldPresence?.onlineState) {
      if (data.onlineState === 'online') {
        this.eventBus.providerOnline({ _id: providerId, name: existing?.name });
      } else if (data.onlineState === 'offline') {
        this.eventBus.providerOffline({ _id: providerId, name: existing?.name });
        // Remove from live cache after some time
        setTimeout(() => {
          const current = this.liveProviders.get(providerId);
          if (current?.onlineState === 'offline') {
            this.liveProviders.delete(providerId);
          }
        }, 60000);
      }
    }

    this.eventBus.emit({
      type: 'provider.presence.changed' as any,
      payload: {
        providerId,
        onlineState: presence.onlineState,
        workState: presence.workState,
      },
      metadata: { providerId },
    });

    return presence;
  }

  async getProviderPresence(providerId: string) {
    return this.presenceModel.findOne({ providerId: new Types.ObjectId(providerId) });
  }

  // ============ REQUEST LOCATION ============

  async createRequestLocation(
    requestId: string,
    customerId: string,
    data: {
      lat: number;
      lng: number;
      accuracy?: number;
      source?: string;
      address?: string;
      cityId?: string;
    }
  ) {
    const location = await this.requestLocationModel.create({
      requestId: new Types.ObjectId(requestId),
      customerId: new Types.ObjectId(customerId),
      point: { type: 'Point', coordinates: [data.lng, data.lat] },
      accuracy: data.accuracy,
      source: data.source || 'gps',
      address: data.address,
      cityId: data.cityId ? new Types.ObjectId(data.cityId) : undefined,
    });

    // Add to live cache
    this.liveRequests.set(requestId, {
      lat: data.lat,
      lng: data.lng,
      serviceType: 'Request',
      urgency: 'normal',
      createdAt: new Date(),
    });

    // Log event
    await this.logGeoEvent('request.location.created', 'request', requestId, data.lat, data.lng, {
      customerId,
      source: data.source,
    });

    return location;
  }

  // ============ NEARBY QUERIES ============

  async getNearbyProviders(
    lat: number,
    lng: number,
    radiusKm: number,
    options?: {
      onlineOnly?: boolean;
      availableOnly?: boolean;
      limit?: number;
    }
  ) {
    const limit = options?.limit || 50;
    
    // Get from fixed locations with geo query
    const fixedProviders = await this.providerLocationModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
        },
      },
      { $match: { isActive: true } },
      { $limit: limit },
      {
        $lookup: {
          from: 'organizations',
          localField: 'providerId',
          foreignField: '_id',
          as: 'provider',
        },
      },
      { $unwind: '$provider' },
      {
        $lookup: {
          from: 'provider_presences',
          localField: 'providerId',
          foreignField: 'providerId',
          as: 'presence',
        },
      },
      { $unwind: { path: '$presence', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          id: { $toString: '$providerId' },
          name: '$provider.name',
          lat: { $arrayElemAt: ['$point.coordinates', 1] },
          lng: { $arrayElemAt: ['$point.coordinates', 0] },
          distanceKm: { $divide: ['$distanceMeters', 1000] },
          rating: '$provider.ratingAvg',
          isVerified: '$isVerified',
          isMobile: '$provider.isMobile',
          locationSource: '$source',
          pinType: {
            $cond: [
              '$isVerified',
              'verified',
              { $cond: [{ $eq: ['$source', 'admin'] }, 'admin', 'unverified'] },
            ],
          },
          onlineState: { $ifNull: ['$presence.onlineState', 'offline'] },
          workState: { $ifNull: ['$presence.workState', 'available'] },
          isOnline: { $eq: [{ $ifNull: ['$presence.onlineState', 'offline'] }, 'online'] },
        },
      },
    ]);

    // Merge with live locations from cache
    const result = fixedProviders.map((p) => {
      const live = this.liveProviders.get(p.id);
      if (live) {
        return {
          ...p,
          lat: live.lat || p.lat,
          lng: live.lng || p.lng,
          onlineState: live.onlineState,
          workState: live.workState,
          isOnline: live.onlineState === 'online',
          isLive: true,
        };
      }
      return { ...p, isLive: false };
    });

    // Filter if needed
    let filtered = result;
    if (options?.onlineOnly) {
      filtered = filtered.filter((p) => p.isOnline);
    }
    if (options?.availableOnly) {
      filtered = filtered.filter((p) => p.workState === 'available');
    }

    return filtered;
  }

  async getNearbyRequests(lat: number, lng: number, radiusKm: number, limit = 20) {
    const requests = await this.requestLocationModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distanceMeters',
          maxDistance: radiusKm * 1000,
          spherical: true,
        },
      },
      { $match: { isActive: true } },
      { $limit: limit },
      {
        $lookup: {
          from: 'quotes',
          localField: 'requestId',
          foreignField: '_id',
          as: 'request',
        },
      },
      { $unwind: '$request' },
      {
        $project: {
          id: { $toString: '$requestId' },
          lat: { $arrayElemAt: ['$point.coordinates', 1] },
          lng: { $arrayElemAt: ['$point.coordinates', 0] },
          distanceKm: { $divide: ['$distanceMeters', 1000] },
          serviceType: '$request.requestedServiceId',
          urgency: { $ifNull: ['$request.urgency', 'normal'] },
          status: '$request.status',
          createdAt: '$request.createdAt',
        },
      },
    ]);

    return requests;
  }

  // ============ ETA ============

  async calculateEta(
    fromLat: number,
    fromLng: number,
    toLat: number,
    toLng: number
  ): Promise<{ distanceMeters: number; durationSeconds: number; source: string }> {
    // Simple approximation based on straight-line distance
    // In production, would use Google/Mapbox Directions API
    
    const R = 6371000; // Earth's radius in meters
    const dLat = this.toRad(toLat - fromLat);
    const dLon = this.toRad(toLng - fromLng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRad(fromLat)) * Math.cos(this.toRad(toLat)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const distanceMeters = R * c;

    // Approximate speed: 20 km/h in city center, 30 km/h outside
    // For now, use 22 km/h average
    const avgSpeedKmh = 22;
    const avgSpeedMs = avgSpeedKmh / 3.6;
    
    // Add 30% for road factor (not straight line)
    const roadDistance = distanceMeters * 1.3;
    const durationSeconds = Math.round(roadDistance / avgSpeedMs);

    return {
      distanceMeters: Math.round(roadDistance),
      durationSeconds,
      source: 'approx',
    };
  }

  private toRad(deg: number): number {
    return deg * (Math.PI / 180);
  }

  // ============ GEO ZONES ============

  async createGeoZone(data: {
    name: string;
    type: string;
    cityId?: string;
    coordinates: number[][];
    metadata?: any;
  }) {
    const zone = await this.geoZoneModel.create({
      name: data.name,
      type: data.type,
      cityId: data.cityId ? new Types.ObjectId(data.cityId) : undefined,
      polygon: {
        type: 'Polygon',
        coordinates: [data.coordinates], // Wrap in array for GeoJSON Polygon
      },
      metadata: data.metadata,
    });

    return zone;
  }

  async getGeoZones(cityId?: string, type?: string) {
    const query: any = { isActive: true };
    if (cityId) query.cityId = new Types.ObjectId(cityId);
    if (type) query.type = type;
    
    return this.geoZoneModel.find(query);
  }

  async isPointInZone(lat: number, lng: number, zoneType: string): Promise<boolean> {
    const result = await this.geoZoneModel.findOne({
      type: zoneType,
      isActive: true,
      polygon: {
        $geoIntersects: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
        },
      },
    });

    return !!result;
  }

  // ============ GEO EVENTS ============

  async logGeoEvent(
    eventType: string,
    entityType: string,
    entityId: string,
    lat: number,
    lng: number,
    data?: any
  ) {
    await this.geoEventModel.create({
      eventType,
      entityType,
      entityId: new Types.ObjectId(entityId),
      point: { type: 'Point', coordinates: [lng, lat] },
      data,
    });
  }

  // ============ LIVE STATE CACHE (for admin) ============

  getLiveProviders(): LiveState[] {
    return Array.from(this.liveProviders.values());
  }

  getLiveRequests() {
    return Array.from(this.liveRequests.entries()).map(([id, data]) => ({
      id,
      ...data,
    }));
  }

  getGeoOverview() {
    const providers = this.getLiveProviders();
    const requests = this.getLiveRequests();

    return {
      totalOnlineProviders: providers.filter(p => p.onlineState === 'online').length,
      totalAvailableProviders: providers.filter(p => p.onlineState === 'online' && p.workState === 'available').length,
      totalBusyProviders: providers.filter(p => p.workState === 'busy' || p.workState === 'in_job').length,
      totalActiveRequests: requests.length,
      providers,
      requests,
    };
  }

  // ============ SIMULATION (for demo) ============

  async simulateProviderMovement(providerId: string, deltaLat: number, deltaLng: number) {
    const existing = this.liveProviders.get(providerId);
    if (!existing) {
      // Create new simulated provider
      this.liveProviders.set(providerId, {
        providerId,
        lat: 50.4501 + deltaLat,
        lng: 30.5234 + deltaLng,
        onlineState: 'online',
        workState: 'available',
        lastSeenAt: new Date(),
        name: `Simulated Provider ${providerId.slice(-4)}`,
        speed: Math.random() * 10,
        heading: Math.random() * 360,
      });
    } else {
      existing.lat += deltaLat;
      existing.lng += deltaLng;
      existing.lastSeenAt = new Date();
      existing.speed = Math.random() * 10;
      existing.heading = Math.random() * 360;
    }

    const state = this.liveProviders.get(providerId)!;
    
    // Emit real-time event
    this.eventBus.providerLocationUpdated(
      { _id: providerId, name: state.name },
      { lat: state.lat, lng: state.lng }
    );

    return state;
  }

  async simulateNewRequest(lat: number, lng: number, serviceType: string, urgency: string = 'normal') {
    const requestId = new Types.ObjectId().toString();
    
    this.liveRequests.set(requestId, {
      lat,
      lng,
      serviceType,
      urgency,
      createdAt: new Date(),
    });

    // Emit event
    this.eventBus.requestCreated({
      _id: requestId,
      description: serviceType,
      requestedServiceId: { name: serviceType },
      urgency,
      location: { coordinates: [lng, lat] },
      city: { nameLocal: 'Киев' },
    });

    // Remove after 5 minutes
    setTimeout(() => {
      this.liveRequests.delete(requestId);
    }, 300000);

    return { id: requestId, lat, lng, serviceType, urgency };
  }
}
