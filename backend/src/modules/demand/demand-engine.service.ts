import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * DemandEngineService - Dynamic marketplace balancing
 * 
 * This is the brain that manages:
 * - Supply-Demand ratio calculation
 * - Surge pricing (dynamic multiplier)
 * - Smart distribution sizing
 * - TTL scaling based on demand
 * - Provider activation pushes
 * 
 * Key metrics:
 * - ratio < 0.5: Provider surplus (quiet market)
 * - ratio 0.5-1: Balanced market
 * - ratio 1-2: High demand (busy market)
 * - ratio > 2: Surge territory (critical demand)
 */
@Injectable()
export class DemandEngineService implements OnModuleInit {
  private readonly logger = new Logger(DemandEngineService.name);
  private readonly UPDATE_INTERVAL_MS = 10000; // 10 seconds
  private intervalHandle: NodeJS.Timeout | null = null;

  // Surge configuration
  private readonly MIN_SURGE = 1.0;
  private readonly MAX_SURGE = 2.5;
  private readonly SURGE_THRESHOLD_RATIO = 1.0;

  // Distribution size configuration
  private readonly BASE_DISTRIBUTION_SIZE = 3;
  private readonly MAX_DISTRIBUTION_SIZE = 7;
  private readonly DISTRIBUTION_INCREASE_RATIO = 1.5;

  // TTL configuration (in seconds)
  private readonly BASE_TTL: Record<string, number> = {
    critical: 20,
    high: 30,
    normal: 60,
    low: 120,
  };

  // Current metrics cache
  private currentMetrics: DemandMetrics | null = null;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('DemandMetrics') private readonly demandMetricsModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit() {
    this.startEngine();
    this.logger.log('🔥 Demand Engine started (tick every 10s)');
  }

  private startEngine() {
    // Initial calculation
    this.calculateMetrics().catch(err => this.logger.error('Initial metrics error:', err));

    this.intervalHandle = setInterval(() => {
      this.calculateMetrics().catch(err => this.logger.error('Metrics calculation error:', err));
    }, this.UPDATE_INTERVAL_MS);
  }

  /**
   * Calculate and store current demand metrics
   */
  async calculateMetrics(cityId?: string): Promise<DemandMetrics> {
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Count active requests (pending quotes in last 5 minutes)
    const activeRequests = await this.quoteModel.countDocuments({
      status: { $in: ['pending', 'awaiting_responses'] },
      createdAt: { $gte: fiveMinutesAgo },
      ...(cityId ? { cityId } : {}),
    });

    // Count online providers
    const activeProviders = await this.organizationModel.countDocuments({
      isOnline: true,
      status: 'active',
      ...(cityId ? { cityId } : {}),
    });

    // Calculate ratio (avoid division by zero)
    const ratio = activeProviders > 0 ? activeRequests / activeProviders : activeRequests > 0 ? 10 : 0;

    // Calculate surge multiplier
    const surgeMultiplier = this.calculateSurge(ratio);

    // Calculate recommended distribution size
    const distributionSize = this.calculateDistributionSize(ratio);

    // Calculate adjusted TTL
    const ttlMultiplier = this.calculateTTLMultiplier(ratio);

    // Determine market state
    const marketState = this.getMarketState(ratio);

    const metrics: DemandMetrics = {
      cityId: cityId || 'all',
      activeRequests,
      activeProviders,
      ratio: Math.round(ratio * 100) / 100,
      surgeMultiplier,
      distributionSize,
      ttlMultiplier,
      marketState,
      updatedAt: now,
    };

    // Store metrics
    await this.demandMetricsModel.findOneAndUpdate(
      { cityId: metrics.cityId },
      { $set: metrics },
      { upsert: true }
    );

    this.currentMetrics = metrics;

    // Emit metrics update event
    await this.eventBus.emit('DEMAND_METRICS_UPDATED' as PlatformEvent, metrics);

    // Log significant changes
    if (metrics.marketState === 'surge' || metrics.marketState === 'critical') {
      this.logger.warn(`[DemandEngine] ${metrics.marketState.toUpperCase()}: ratio=${metrics.ratio}, surge=${metrics.surgeMultiplier}x`);
    }

    return metrics;
  }

  /**
   * Get current metrics (cached)
   */
  getCurrentMetrics(): DemandMetrics | null {
    return this.currentMetrics;
  }

  /**
   * Get metrics for specific city
   */
  async getMetricsForCity(cityId: string): Promise<DemandMetrics | null> {
    const doc = await this.demandMetricsModel.findOne({ cityId }).lean() as any;
    return doc || null;
  }

  /**
   * Calculate surge multiplier based on ratio
   * Formula: surge = clamp(1, 2.5, ratio * 1.25) for ratio > 1
   */
  private calculateSurge(ratio: number): number {
    if (ratio <= this.SURGE_THRESHOLD_RATIO) {
      return this.MIN_SURGE;
    }

    // Linear surge increase above threshold
    const surge = 1 + (ratio - this.SURGE_THRESHOLD_RATIO) * 0.5;
    return Math.min(Math.max(surge, this.MIN_SURGE), this.MAX_SURGE);
  }

  /**
   * Calculate optimal distribution size based on demand
   */
  private calculateDistributionSize(ratio: number): number {
    if (ratio <= this.DISTRIBUTION_INCREASE_RATIO) {
      return this.BASE_DISTRIBUTION_SIZE;
    }

    // Increase distribution size for high demand
    const size = Math.ceil(this.BASE_DISTRIBUTION_SIZE + (ratio - this.DISTRIBUTION_INCREASE_RATIO) * 2);
    return Math.min(size, this.MAX_DISTRIBUTION_SIZE);
  }

  /**
   * Calculate TTL multiplier (lower = faster market)
   */
  private calculateTTLMultiplier(ratio: number): number {
    if (ratio <= 1) {
      return 1.0; // Normal TTL
    }
    if (ratio <= 2) {
      return 0.75; // 25% faster
    }
    return 0.5; // 50% faster for surge
  }

  /**
   * Get market state description
   */
  private getMarketState(ratio: number): string {
    if (ratio < 0.5) return 'surplus';    // Too many providers
    if (ratio < 1.0) return 'balanced';   // Good balance
    if (ratio < 1.5) return 'busy';       // Getting busy
    if (ratio < 2.0) return 'high_demand';// High demand
    if (ratio < 3.0) return 'surge';      // Surge pricing active
    return 'critical';                     // Critical demand
  }

  /**
   * Get adjusted TTL for a request based on urgency and demand
   */
  getAdjustedTTL(urgency: string): number {
    const baseTTL = this.BASE_TTL[urgency] || this.BASE_TTL.normal;
    const multiplier = this.currentMetrics?.ttlMultiplier || 1.0;
    return Math.round(baseTTL * multiplier);
  }

  /**
   * Get current distribution size
   */
  getDistributionSize(): number {
    return this.currentMetrics?.distributionSize || this.BASE_DISTRIBUTION_SIZE;
  }

  /**
   * Get current surge multiplier
   */
  getSurgeMultiplier(): number {
    return this.currentMetrics?.surgeMultiplier || this.MIN_SURGE;
  }

  /**
   * Calculate final price with surge
   */
  calculateSurgePrice(basePrice: number): number {
    const surge = this.getSurgeMultiplier();
    return Math.round(basePrice * surge);
  }

  /**
   * Check if surge is active
   */
  isSurgeActive(): boolean {
    return (this.currentMetrics?.surgeMultiplier || 1) > 1.0;
  }

  /**
   * Get heatmap data for admin (geo-based demand visualization)
   */
  async getHeatmapData(): Promise<any[]> {
    const now = new Date();
    const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

    // Aggregate requests by location grid
    const requestHeatmap = await this.quoteModel.aggregate([
      {
        $match: {
          createdAt: { $gte: thirtyMinutesAgo },
          'location.coordinates': { $exists: true },
        },
      },
      {
        $project: {
          // Round to ~1km grid cells
          gridLat: { $round: [{ $arrayElemAt: ['$location.coordinates', 1] }, 2] },
          gridLng: { $round: [{ $arrayElemAt: ['$location.coordinates', 0] }, 2] },
          status: 1,
        },
      },
      {
        $group: {
          _id: { lat: '$gridLat', lng: '$gridLng' },
          totalRequests: { $sum: 1 },
          pendingRequests: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'awaiting_responses']] }, 1, 0] },
          },
        },
      },
    ]);

    // Get provider locations
    const providerLocations = await this.connection.model('ProviderLiveLocation').aggregate([
      {
        $match: { isOnline: true },
      },
      {
        $project: {
          gridLat: { $round: [{ $arrayElemAt: ['$location.coordinates', 1] }, 2] },
          gridLng: { $round: [{ $arrayElemAt: ['$location.coordinates', 0] }, 2] },
        },
      },
      {
        $group: {
          _id: { lat: '$gridLat', lng: '$gridLng' },
          providerCount: { $sum: 1 },
        },
      },
    ]);

    // Combine into heatmap cells
    const cellMap = new Map<string, any>();

    for (const req of requestHeatmap) {
      const key = `${req._id.lat},${req._id.lng}`;
      cellMap.set(key, {
        lat: req._id.lat,
        lng: req._id.lng,
        requests: req.totalRequests,
        pendingRequests: req.pendingRequests,
        providers: 0,
        ratio: 0,
        intensity: 0,
      });
    }

    for (const prov of providerLocations) {
      const key = `${prov._id.lat},${prov._id.lng}`;
      if (cellMap.has(key)) {
        cellMap.get(key).providers = prov.providerCount;
      } else {
        cellMap.set(key, {
          lat: prov._id.lat,
          lng: prov._id.lng,
          requests: 0,
          pendingRequests: 0,
          providers: prov.providerCount,
          ratio: 0,
          intensity: 0,
        });
      }
    }

    // Calculate ratios and intensity
    const cells = Array.from(cellMap.values()).map(cell => {
      cell.ratio = cell.providers > 0 ? cell.requests / cell.providers : cell.requests * 10;
      cell.intensity = Math.min(cell.ratio / 3, 1); // Normalize 0-1 for heatmap
      return cell;
    });

    return cells.filter(c => c.requests > 0 || c.providers > 0);
  }

  /**
   * Get areas needing more providers
   */
  async getProviderNeededAreas(): Promise<any[]> {
    const heatmap = await this.getHeatmapData();
    return heatmap
      .filter(cell => cell.ratio > 1.5 && cell.pendingRequests > 0)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 10);
  }

  /**
   * Notify offline providers in high-demand areas
   */
  async notifyProvidersInHighDemandAreas(): Promise<number> {
    const hotAreas = await this.getProviderNeededAreas();
    if (hotAreas.length === 0) return 0;

    let notifiedCount = 0;

    for (const area of hotAreas) {
      // Find offline providers near this area
      const nearbyProviders = await this.organizationModel.find({
        isOnline: false,
        status: 'active',
        // Last seen within 24 hours
        lastOnlineAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).limit(10);

      for (const provider of nearbyProviders) {
        // Emit notification event
        await this.eventBus.emit('PROVIDER_HIGH_DEMAND_NOTIFICATION' as PlatformEvent, {
          providerId: String(provider._id),
          areaLat: area.lat,
          areaLng: area.lng,
          pendingRequests: area.pendingRequests,
        });
        notifiedCount++;
      }
    }

    return notifiedCount;
  }
}

// Type definitions - exported for controller
export interface DemandMetrics {
  cityId: string;
  activeRequests: number;
  activeProviders: number;
  ratio: number;
  surgeMultiplier: number;
  distributionSize: number;
  ttlMultiplier: number;
  marketState: string;
  updatedAt: Date;
}
