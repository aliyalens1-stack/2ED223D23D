import { Schema } from 'mongoose';

/**
 * Provider Live Location Schema
 * Tracks real-time movement of providers during active bookings
 * 
 * Used for:
 * - Live map visualization (Uber-like)
 * - ETA recalculation
 * - Anomaly detection (stuck, wrong direction)
 * - Auto-arrived trigger
 */
export const ProviderLiveLocationSchema = new Schema(
  {
    providerId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
    
    // Current location
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: [Number], // [lng, lat]
    },
    
    // Movement data for smooth animation
    heading: { type: Number, default: 0 },  // Direction 0-360 degrees
    speed: { type: Number, default: 0 },     // km/h
    accuracy: { type: Number, default: 0 },  // GPS accuracy in meters
    
    // State
    isOnline: { type: Boolean, default: false, index: true },
    lastActivity: { type: Date, default: Date.now },
    
    // Movement history (last 10 points for direction analysis)
    recentLocations: [{
      lat: Number,
      lng: Number,
      timestamp: Date,
    }],
    
    // Anomaly flags
    isStuck: { type: Boolean, default: false },       // No movement > 5 min
    isMovingAway: { type: Boolean, default: false },  // Distance increasing
    stuckSince: { type: Date, default: null },
    
    // Stats for this session
    totalDistanceKm: { type: Number, default: 0 },
    averageSpeedKmh: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Geo index for location queries
ProviderLiveLocationSchema.index({ location: '2dsphere' });
ProviderLiveLocationSchema.index({ providerId: 1, isOnline: 1 });
ProviderLiveLocationSchema.index({ bookingId: 1 });
