import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * ZoneEngineService - City-Level Marketplace Control
 * 
 * This is the brain for zone-based market management:
 * - Real-time zone metrics calculation
 * - Market state detection (surplus → critical)
 * - Auto-actions based on zone state
 * - Supply redistribution between zones
 * 
 * Market States:
 * - surplus: ratio < 0.5 (too many providers)
 * - balanced: ratio 0.5-1.0 (good balance)
 * - busy: ratio 1.0-2.0 (getting busy)
 * - surge: ratio 2.0-3.0 (surge pricing active)
 * - critical: ratio > 3.0 (urgent intervention needed)
 * - dead: 0 providers (no supply)
 */
@Injectable()
export class ZoneEngineService implements OnModuleInit {
  private readonly logger = new Logger(ZoneEngineService.name);
  private readonly UPDATE_INTERVAL_MS = 5000; // 5 seconds
  private intervalHandle: NodeJS.Timeout | null = null;

  // Auto-action thresholds
  private readonly AUTO_SURGE_THRESHOLD = 2.0;
  private readonly CRITICAL_THRESHOLD = 3.0;
  private readonly SUPPLY_PULL_THRESHOLD = 2.5;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('GeoZone') private readonly zoneModel: Model<any>,
    @InjectModel('ZoneMetrics') private readonly metricsModel: Model<any>,
    @InjectModel('ZoneAction') private readonly actionModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit() {
    this.startEngine();
    this.logger.log('🌍 Zone Engine started (tick every 5s)');
  }

  private startEngine() {
    // Initial calculation
    this.updateAllZoneMetrics().catch(err => 
      this.logger.error('Initial zone metrics error:', err)
    );

    this.intervalHandle = setInterval(() => {
      this.updateAllZoneMetrics().catch(err => 
        this.logger.error('Zone metrics update error:', err)
      );
    }, this.UPDATE_INTERVAL_MS);
  }

  /**
   * Update metrics for all active zones
   */
  async updateAllZoneMetrics(): Promise<void> {
    const zones = await this.zoneModel.find({ 
      status: { $in: ['active', 'monitoring'] }
    }).lean();

    for (const zone of zones) {
      try {
        await this.updateZoneMetrics(zone);
      } catch (err) {
        this.logger.error(`Error updating zone ${zone.code}:`, err);
      }
    }
  }

  /**
   * Update metrics for a single zone
   */
  async updateZoneMetrics(zone: any): Promise<any> {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Build geo query for zone
    const geoQuery = zone.polygon?.coordinates 
      ? { location: { $geoWithin: { $geometry: zone.polygon } } }
      : { 
          location: { 
            $geoWithin: { 
              $centerSphere: [zone.center.coordinates, zone.radiusKm / 6378.1] 
            } 
          } 
        };

    // Count providers in zone
    const providersInZone = await this.organizationModel.find({
      status: 'active',
      $or: [
        geoQuery,
        { 'branches.location': geoQuery.location }
      ]
    }).lean();

    const totalProviders = providersInZone.length;
    const onlineProviders = providersInZone.filter(p => p.isOnline).length;
    const busyProviders = providersInZone.filter(p => p.currentBookingId).length;
    const availableProviders = onlineProviders - busyProviders;

    // Provider quality metrics
    const avgProviderRating = providersInZone.length > 0
      ? providersInZone.reduce((sum, p) => sum + (p.rating || 0), 0) / providersInZone.length
      : 0;
    const avgProviderScore = providersInZone.length > 0
      ? providersInZone.reduce((sum, p) => sum + (p.behavioralScore || 50), 0) / providersInZone.length
      : 0;
    const strongProviders = providersInZone.filter(p => (p.behavioralScore || 50) > 70).length;
    const weakProviders = providersInZone.filter(p => (p.behavioralScore || 50) < 30).length;

    // Count requests in zone
    const requestsQuery = {
      ...geoQuery,
      status: { $in: ['pending', 'awaiting_responses'] },
      createdAt: { $gte: fiveMinutesAgo },
    };

    const activeRequests = await this.quoteModel.countDocuments(requestsQuery);
    const pendingRequests = await this.quoteModel.countDocuments({
      ...geoQuery,
      status: 'pending',
      createdAt: { $gte: fiveMinutesAgo },
    });
    const urgentRequests = await this.quoteModel.countDocuments({
      ...requestsQuery,
      urgency: { $in: ['critical', 'high'] },
    });

    // Calculate ratio
    const ratio = availableProviders > 0 
      ? activeRequests / availableProviders 
      : activeRequests > 0 ? 10 : 0;

    // Determine state
    const state = this.calculateState(ratio, availableProviders);

    // Calculate surge multiplier
    const surgeMultiplier = this.calculateSurge(ratio, zone.config?.baseSurge || 1.0);

    // Historical metrics (last hour)
    const requestsLastHour = await this.quoteModel.countDocuments({
      ...geoQuery,
      createdAt: { $gte: oneHourAgo },
    });

    const completedLastHour = await this.bookingModel.countDocuments({
      status: 'completed',
      completedAt: { $gte: oneHourAgo },
    });

    // Average response time (from recent bookings)
    const recentBookings = await this.bookingModel.find({
      status: { $in: ['confirmed', 'in_progress', 'completed'] },
      createdAt: { $gte: oneHourAgo },
    }).limit(50).lean();

    const avgResponseTime = recentBookings.length > 0
      ? recentBookings.reduce((sum, b) => {
          const responseTime = b.confirmedAt && b.createdAt 
            ? (new Date(b.confirmedAt).getTime() - new Date(b.createdAt).getTime()) / 1000
            : 0;
          return sum + responseTime;
        }, 0) / recentBookings.length
      : 0;

    // Get previous state to detect changes
    const previousMetrics = await this.metricsModel.findOne({ 
      zoneId: zone._id 
    }).lean() as any;
    
    const stateChanged = previousMetrics?.state !== state;

    // Build metrics object
    const metrics = {
      zoneId: zone._id,
      zoneCode: zone.code,
      totalProviders,
      onlineProviders,
      busyProviders,
      availableProviders,
      avgProviderRating: Math.round(avgProviderRating * 100) / 100,
      avgProviderScore: Math.round(avgProviderScore),
      strongProviders,
      weakProviders,
      activeRequests,
      pendingRequests,
      urgentRequests,
      avgResponseTime: Math.round(avgResponseTime),
      completionRate: requestsLastHour > 0 
        ? Math.round((completedLastHour / requestsLastHour) * 100) 
        : 0,
      ratio: Math.round(ratio * 100) / 100,
      surgeMultiplier: Math.round(surgeMultiplier * 100) / 100,
      state,
      stateChangedAt: stateChanged ? now : previousMetrics?.stateChangedAt,
      requestsLastHour,
      completedLastHour,
      updatedAt: now,
    };

    // Upsert metrics
    await this.metricsModel.findOneAndUpdate(
      { zoneId: zone._id },
      { $set: metrics },
      { upsert: true }
    );

    // Emit event if state changed
    if (stateChanged) {
      this.logger.warn(`[ZoneEngine] ${zone.code}: ${previousMetrics?.state || 'new'} → ${state}`);
      await this.eventBus.emit('ZONE_STATE_CHANGED' as PlatformEvent, {
        zoneId: String(zone._id),
        zoneCode: zone.code,
        previousState: previousMetrics?.state,
        newState: state,
        metrics,
      });

      // Trigger auto-actions if enabled
      if (zone.config?.autoMode) {
        await this.triggerAutoActions(zone, metrics, previousMetrics?.state);
      }
    }

    return metrics;
  }

  /**
   * Calculate market state from ratio
   */
  private calculateState(ratio: number, availableProviders: number): string {
    if (availableProviders === 0) return 'dead';
    if (ratio < 0.5) return 'surplus';
    if (ratio < 1.0) return 'balanced';
    if (ratio < 2.0) return 'busy';
    if (ratio < 3.0) return 'surge';
    return 'critical';
  }

  /**
   * Calculate surge multiplier
   */
  private calculateSurge(ratio: number, baseSurge: number): number {
    if (ratio <= 1.0) return baseSurge;
    if (ratio <= 2.0) return baseSurge * (1 + (ratio - 1) * 0.25);
    if (ratio <= 3.0) return baseSurge * (1.25 + (ratio - 2) * 0.5);
    return Math.min(baseSurge * 2.5, 2.5);
  }

  /**
   * Trigger automatic actions based on zone state
   */
  private async triggerAutoActions(
    zone: any, 
    metrics: any, 
    previousState: string | undefined
  ): Promise<void> {
    const { state, ratio, surgeMultiplier } = metrics;

    // State escalation actions
    if (state === 'critical' && previousState !== 'critical') {
      // Critical: expand radius, notify offline providers
      await this.logAction(zone, 'radius_expand', {
        previousValue: zone.radiusKm,
        newValue: zone.radiusKm * 1.5,
        reason: 'Auto-expand due to critical demand',
        triggeredBy: 'auto',
      });

      await this.logAction(zone, 'push_notification', {
        newValue: { message: `High demand in ${zone.name}! Go online now.` },
        reason: 'Critical demand notification',
        triggeredBy: 'auto',
      });
    }

    if (state === 'surge' && previousState === 'busy') {
      // Entering surge: adjust pricing
      await this.logAction(zone, 'surge_adjust', {
        previousValue: 1.0,
        newValue: surgeMultiplier,
        reason: 'Auto-surge pricing activated',
        triggeredBy: 'auto',
      });
    }

    if (state === 'dead' && previousState !== 'dead') {
      // Dead zone: alert operators
      await this.logAction(zone, 'push_notification', {
        newValue: { message: `⚠️ DEAD ZONE: ${zone.name} has no providers!` },
        reason: 'Dead zone alert',
        triggeredBy: 'auto',
      });
    }
  }

  /**
   * Log a zone action
   */
  async logAction(zone: any, actionType: string, data: any): Promise<void> {
    await this.actionModel.create({
      zoneId: zone._id,
      zoneCode: zone.code,
      actionType,
      ...data,
    });
  }

  // ========== PUBLIC API ==========

  /**
   * Get all zones with current metrics
   */
  async getAllZonesWithMetrics(): Promise<any[]> {
    const zones = await this.zoneModel.find({ 
      status: { $in: ['active', 'monitoring'] }
    }).lean();

    const metrics = await this.metricsModel.find({
      zoneId: { $in: zones.map(z => z._id) }
    }).lean();

    const metricsMap = new Map(metrics.map(m => [String((m as any).zoneId), m]));

    return zones.map(zone => ({
      ...zone,
      _id: String(zone._id),
      metrics: metricsMap.get(String(zone._id)) || null,
    }));
  }

  /**
   * Get zone by ID with metrics
   */
  async getZoneById(zoneId: string): Promise<any> {
    const zone = await this.zoneModel.findById(zoneId).lean();
    if (!zone) return null;

    const metrics = await this.metricsModel.findOne({ zoneId }).lean();
    const recentActions = await this.actionModel.find({ zoneId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return {
      ...(zone as any),
      _id: String((zone as any)._id),
      metrics,
      recentActions,
    };
  }

  /**
   * Get heatmap data for all zones
   */
  async getZoneHeatmap(): Promise<any[]> {
    const zonesWithMetrics = await this.getAllZonesWithMetrics();
    
    return zonesWithMetrics.map(z => ({
      id: z._id,
      code: z.code,
      name: z.name,
      center: z.center.coordinates,
      radiusKm: z.radiusKm,
      state: z.metrics?.state || 'balanced',
      ratio: z.metrics?.ratio || 0,
      surgeMultiplier: z.metrics?.surgeMultiplier || 1.0,
      onlineProviders: z.metrics?.onlineProviders || 0,
      activeRequests: z.metrics?.activeRequests || 0,
      intensity: Math.min((z.metrics?.ratio || 0) / 3, 1), // 0-1 for heatmap
    }));
  }

  /**
   * Get critical/surge zones
   */
  async getHotZones(): Promise<any[]> {
    const metrics = await this.metricsModel.find({
      state: { $in: ['surge', 'critical', 'dead'] }
    }).lean();

    const zoneIds = metrics.map(m => (m as any).zoneId);
    const zones = await this.zoneModel.find({ _id: { $in: zoneIds } }).lean();
    const zonesMap = new Map(zones.map(z => [String(z._id), z]));

    return metrics.map(m => ({
      zone: zonesMap.get(String((m as any).zoneId)),
      metrics: m,
    })).filter(x => x.zone);
  }

  /**
   * Get dead zones (no providers)
   */
  async getDeadZones(): Promise<any[]> {
    return this.metricsModel.find({ state: 'dead' })
      .populate('zoneId')
      .lean();
  }

  /**
   * Perform manual action on zone
   */
  async performZoneAction(
    zoneId: string, 
    actionType: string, 
    data: any,
    operatorId?: string
  ): Promise<any> {
    const zone = await this.zoneModel.findById(zoneId);
    if (!zone) throw new Error('Zone not found');

    const actionData: any = {
      ...data,
      triggeredBy: 'manual',
      operatorId: operatorId ? new Types.ObjectId(operatorId) : undefined,
    };

    // Execute action based on type
    switch (actionType) {
      case 'surge_adjust':
        // Update zone config
        await this.zoneModel.updateOne(
          { _id: zoneId },
          { $set: { 'config.baseSurge': data.newValue } }
        );
        break;

      case 'supply_boost':
        // Mark providers in zone for boost
        // This would integrate with visibility engine
        break;

      case 'auto_mode_toggle':
        await this.zoneModel.updateOne(
          { _id: zoneId },
          { $set: { 'config.autoMode': data.newValue } }
        );
        break;

      case 'status_change':
        await this.zoneModel.updateOne(
          { _id: zoneId },
          { $set: { status: data.newValue } }
        );
        break;
    }

    await this.logAction(zone.toObject(), actionType, actionData);

    // Force metrics update
    const updatedZone = await this.zoneModel.findById(zoneId).lean();
    await this.updateZoneMetrics(updatedZone);

    return this.getZoneById(zoneId);
  }

  /**
   * Create a new zone
   */
  async createZone(data: any): Promise<any> {
    const zone = await this.zoneModel.create(data);
    await this.updateZoneMetrics(zone.toObject());
    return this.getZoneById(String(zone._id));
  }

  /**
   * Get city-level KPIs
   */
  async getCityKPIs(cityId?: string): Promise<any> {
    const filter = cityId ? { cityId: new Types.ObjectId(cityId) } : {};
    
    const allMetrics = await this.metricsModel.find().lean();
    
    const totalZones = allMetrics.length;
    const healthyZones = allMetrics.filter(m => 
      ['surplus', 'balanced'].includes((m as any).state)
    ).length;
    const criticalZones = allMetrics.filter(m => 
      ['surge', 'critical', 'dead'].includes((m as any).state)
    ).length;

    const totalProviders = allMetrics.reduce((sum, m) => sum + ((m as any).onlineProviders || 0), 0);
    const totalRequests = allMetrics.reduce((sum, m) => sum + ((m as any).activeRequests || 0), 0);
    const avgRatio = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + ((m as any).ratio || 0), 0) / allMetrics.length
      : 0;
    const avgSurge = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + ((m as any).surgeMultiplier || 1), 0) / allMetrics.length
      : 1;
    const avgResponseTime = allMetrics.length > 0
      ? allMetrics.reduce((sum, m) => sum + ((m as any).avgResponseTime || 0), 0) / allMetrics.length
      : 0;

    return {
      totalZones,
      healthyZones,
      criticalZones,
      totalProviders,
      totalRequests,
      avgRatio: Math.round(avgRatio * 100) / 100,
      avgSurge: Math.round(avgSurge * 100) / 100,
      avgResponseTime: Math.round(avgResponseTime),
      avgETA: Math.round(avgResponseTime / 60), // Convert to minutes
      cityHealth: healthyZones / Math.max(totalZones, 1) * 100,
    };
  }

  /**
   * Find providers to pull from nearby zones
   */
  async findProvidersForSupplyPull(zoneId: string, limit: number = 5): Promise<any[]> {
    const zone = await this.zoneModel.findById(zoneId).lean() as any;
    if (!zone) return [];

    // Find nearby zones with surplus
    const nearbyZones = await this.zoneModel.find({
      _id: { $ne: zoneId },
      status: 'active',
      center: {
        $nearSphere: {
          $geometry: zone.center,
          $maxDistance: 10000, // 10km
        }
      }
    }).lean() as any[];

    const nearbyMetrics = await this.metricsModel.find({
      zoneId: { $in: nearbyZones.map(z => z._id) },
      state: 'surplus',
    }).lean();

    // Get providers from surplus zones
    const providers: any[] = [];
    for (const metrics of nearbyMetrics) {
      if (providers.length >= limit) break;

      const zoneProviders = await this.organizationModel.find({
        isOnline: true,
        status: 'active',
        // Not busy
        currentBookingId: { $exists: false },
      }).limit(limit - providers.length).lean();

      providers.push(...zoneProviders.map(p => ({
        ...p,
        sourceZoneId: (metrics as any).zoneId,
      })));
    }

    return providers;
  }
}
