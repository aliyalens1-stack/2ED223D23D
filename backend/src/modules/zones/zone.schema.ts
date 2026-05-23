import { Schema } from 'mongoose';

/**
 * GeoZone Schema - Operational zones for city-level control
 * 
 * Each zone represents a geographical area within a city
 * Used for: demand tracking, supply management, surge pricing
 */
export const GeoZoneSchema = new Schema(
  {
    // Zone identification
    name: { type: String, required: true },
    nameLocal: { type: String, default: '' },
    code: { type: String, required: true, unique: true },
    
    // Geography
    cityId: { type: Schema.Types.ObjectId, ref: 'City', index: true },
    cityName: { type: String, default: '' },
    center: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
    radiusKm: { type: Number, default: 3 },
    
    // Zone type
    zoneType: { 
      type: String, 
      enum: ['district', 'grid', 'custom', 'hotspot'],
      default: 'district'
    },
    
    // Polygon for custom zones
    polygon: {
      type: { type: String, enum: ['Polygon'] },
      coordinates: { type: [[[Number]]] }, // Array of rings
    },
    
    // Configuration
    config: {
      baseSurge: { type: Number, default: 1.0 },
      maxSurge: { type: Number, default: 2.5 },
      autoMode: { type: Boolean, default: true },
      priority: { type: Number, default: 0 }, // Higher = more important
    },
    
    // Status
    status: { 
      type: String, 
      enum: ['active', 'inactive', 'monitoring'],
      default: 'active'
    },
    
    // Parent zone (for hierarchical zones)
    parentZoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone', index: true },
    
    // Metadata
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

// Create 2dsphere index for geo queries
GeoZoneSchema.index({ center: '2dsphere' });
GeoZoneSchema.index({ polygon: '2dsphere' });
GeoZoneSchema.index({ code: 1 }, { unique: true });

/**
 * ZoneMetrics Schema - Real-time metrics for each zone
 * 
 * Updated every 5-10 seconds by the Zone Engine
 */
export const ZoneMetricsSchema = new Schema(
  {
    zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone', required: true, index: true },
    zoneCode: { type: String, required: true, index: true },
    
    // Supply metrics
    totalProviders: { type: Number, default: 0 },
    onlineProviders: { type: Number, default: 0 },
    busyProviders: { type: Number, default: 0 },
    availableProviders: { type: Number, default: 0 },
    
    // Provider quality
    avgProviderRating: { type: Number, default: 0 },
    avgProviderScore: { type: Number, default: 0 },
    strongProviders: { type: Number, default: 0 }, // Score > 70
    weakProviders: { type: Number, default: 0 },   // Score < 30
    
    // Demand metrics
    activeRequests: { type: Number, default: 0 },
    pendingRequests: { type: Number, default: 0 },
    urgentRequests: { type: Number, default: 0 },
    
    // Performance metrics
    avgResponseTime: { type: Number, default: 0 }, // seconds
    avgETA: { type: Number, default: 0 },          // minutes
    completionRate: { type: Number, default: 0 },  // percentage
    cancellationRate: { type: Number, default: 0 },
    
    // Balance metrics
    ratio: { type: Number, default: 0 }, // requests / available providers
    surgeMultiplier: { type: Number, default: 1.0 },
    
    // Market state
    state: {
      type: String,
      enum: ['surplus', 'balanced', 'busy', 'surge', 'critical', 'dead'],
      default: 'balanced'
    },
    stateChangedAt: { type: Date },
    
    // Historical (last hour)
    requestsLastHour: { type: Number, default: 0 },
    completedLastHour: { type: Number, default: 0 },
    missedLastHour: { type: Number, default: 0 },
    avgWaitTimeLastHour: { type: Number, default: 0 },
    
    // Predictions
    predictedDemand15m: { type: Number, default: 0 },
    predictedDemand1h: { type: Number, default: 0 },
    
    // Timestamp
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ZoneMetricsSchema.index({ zoneId: 1, updatedAt: -1 });
ZoneMetricsSchema.index({ state: 1 });

/**
 * ZoneAction Schema - Log of actions taken on zones
 */
export const ZoneActionSchema = new Schema(
  {
    zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone', required: true, index: true },
    zoneCode: { type: String, required: true },
    
    // Action details
    actionType: {
      type: String,
      enum: [
        'surge_adjust',
        'supply_boost',
        'supply_pull',
        'push_notification',
        'radius_expand',
        'auto_mode_toggle',
        'status_change',
        'manual_override'
      ],
      required: true
    },
    
    // Action data
    previousValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    reason: { type: String },
    
    // Trigger
    triggeredBy: {
      type: String,
      enum: ['auto', 'manual', 'schedule'],
      default: 'manual'
    },
    operatorId: { type: Schema.Types.ObjectId, ref: 'User' },
    
    // Result
    success: { type: Boolean, default: true },
    affectedProviders: { type: Number, default: 0 },
    
    // Expiry (for temporary actions)
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

ZoneActionSchema.index({ zoneId: 1, createdAt: -1 });
ZoneActionSchema.index({ actionType: 1, createdAt: -1 });
