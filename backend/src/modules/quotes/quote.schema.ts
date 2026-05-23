import { Schema } from 'mongoose';
import { QuoteStatus } from '../../shared/enums';

export const QuoteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null, index: true },
    requestedServiceId: {
      type: Schema.Types.ObjectId,
      ref: 'Service',
      default: null,
      index: true,
    },
    description: { type: String, default: '' },
    city: { type: String, default: '', index: true },
    status: {
      type: String,
      enum: Object.values(QuoteStatus),
      default: QuoteStatus.PENDING,
      index: true,
    },
    responsesCount: { type: Number, default: 0 },
    expiresAt: { type: Date, default: null },
    // === GEO LOCATION (NEW) ===
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: null }, // [lng, lat]
    },
    locationSource: {
      type: String,
      enum: ['gps', 'manual_pin', 'address_geocoded', 'operator'],
      default: 'gps',
    },
    // === URGENCY ===
    urgency: {
      type: String,
      enum: ['low', 'normal', 'high', 'critical'],
      default: 'normal',
    },
    // === ASSIGNMENT ===
    source: {
      type: String,
      enum: ['quick', 'detailed', 'operator_manual'],
      default: 'detailed',
    },
    selectedProviderId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    assignedOperatorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // === OPERATOR NOTES ===
    operatorNotes: { type: String, default: '' },
  },
  { timestamps: true },
);

// Add 2dsphere index for geo queries
QuoteSchema.index({ location: '2dsphere' });
QuoteSchema.index({ status: 1, urgency: 1, createdAt: -1 });
