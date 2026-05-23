import { Schema } from 'mongoose';
import { BookingStatus } from '../../shared/enums';

export const BookingSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null, index: true },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    providerServiceId: {
      type: Schema.Types.ObjectId,
      ref: 'ProviderService',
      required: true,
      index: true,
    },
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', default: null, index: true },
    quoteResponseId: {
      type: Schema.Types.ObjectId,
      ref: 'QuoteResponse',
      default: null,
      index: true,
    },
    slotId: { type: Schema.Types.ObjectId, ref: 'BookingSlot', default: null, index: true },
    scheduledAt: { type: Date, default: null, index: true },
    
    // ========== CURRENT JOB FIELDS ==========
    // Customer location (from quote or manual)
    customerLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: [Number], // [lng, lat]
    },
    // Provider live location (updated during on_route)
    providerLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: [Number], // [lng, lat]
    },
    providerLocationUpdatedAt: { type: Date, default: null },
    // Estimated values
    estimatedEtaMinutes: { type: Number, default: null },
    estimatedDistanceKm: { type: Number, default: null },
    // Actual route tracking
    routeStartedAt: { type: Date, default: null },
    arrivedAt: { type: Date, default: null },
    workStartedAt: { type: Date, default: null },
    // Route snapshot
    routeSnapshot: {
      fromCoordinates: [Number],
      toCoordinates: [Number],
      distanceMeters: { type: Number, default: null },
      durationSeconds: { type: Number, default: null },
      source: { type: String, default: 'estimated' }, // 'google', 'mapbox', 'osrm', 'estimated'
    },
    // ========== END CURRENT JOB FIELDS ==========
    
    // Payment status tracking
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'payment_pending', 'paid', 'refund_pending', 'refunded'],
      default: 'unpaid',
    },
    isPaid: { type: Boolean, default: false },
    status: {
      type: String,
      enum: Object.values(BookingStatus),
      default: BookingStatus.DRAFT,
      index: true,
    },
    snapshot: {
      orgName: { type: String, default: '' },
      branchName: { type: String, default: '' },
      branchAddress: { type: String, default: '' },
      serviceName: { type: String, default: '' },
      price: { type: Number, default: 0 },
      customerName: { type: String, default: '' },
      customerPhone: { type: String, default: '' },
      vehicleBrand: { type: String, default: '' },
      vehicleModel: { type: String, default: '' },
    },
    customerNotes: { type: String, default: '' },
    providerNotes: { type: String, default: '' },
    cancellationReason: { type: String, default: '' },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    cancelledAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    noShow: { type: Boolean, default: false },
    
    // Risk flags for anomaly detection
    riskFlags: [{
      type: { type: String }, // 'stuck_route', 'no_movement', 'arrival_mismatch', 'long_job'
      severity: { type: String, enum: ['low', 'medium', 'high'] },
      detectedAt: { type: Date },
      resolvedAt: { type: Date, default: null },
      notes: { type: String, default: '' },
    }],
  },
  { timestamps: true },
);

// Geo indexes - only for customerLocation (always has coordinates)
// providerLocation index removed - often null/incomplete during job lifecycle
BookingSchema.index({ customerLocation: '2dsphere' });

BookingSchema.index({ userId: 1, status: 1 });
BookingSchema.index({ organizationId: 1, status: 1 });
BookingSchema.index({ branchId: 1, scheduledAt: 1 });
// For active current job lookups
BookingSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
