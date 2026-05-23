import { Schema } from 'mongoose';

/**
 * Demand Metrics Schema
 * Stores real-time market balance snapshots
 */
export const DemandMetricsSchema = new Schema(
  {
    cityId: { type: String, required: true, unique: true, index: true },
    activeRequests: { type: Number, default: 0 },
    activeProviders: { type: Number, default: 0 },
    ratio: { type: Number, default: 0 },
    surgeMultiplier: { type: Number, default: 1.0 },
    distributionSize: { type: Number, default: 3 },
    ttlMultiplier: { type: Number, default: 1.0 },
    marketState: { 
      type: String, 
      enum: ['surplus', 'balanced', 'busy', 'high_demand', 'surge', 'critical'],
      default: 'balanced' 
    },
    // Historical snapshots (last 24 hours)
    hourlySnapshots: [{
      hour: Number,
      ratio: Number,
      surgeMultiplier: Number,
      activeRequests: Number,
      activeProviders: Number,
      timestamp: Date,
    }],
  },
  { timestamps: true }
);

// TTL index - auto-delete old metrics after 7 days
DemandMetricsSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });
