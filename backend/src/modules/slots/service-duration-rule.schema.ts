import { Schema } from 'mongoose';

/**
 * Duration rule for a specific provider service
 * Overrides the default duration from ProviderService
 */
export const ServiceDurationRuleSchema = new Schema(
  {
    providerServiceId: { type: Schema.Types.ObjectId, ref: 'ProviderService', required: true, index: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    durationMinutes: { type: Number, required: true, min: 15 },
    bufferBefore: { type: Number, default: 0, min: 0 }, // minutes
    bufferAfter: { type: Number, default: 15, min: 0 },  // minutes
  },
  { timestamps: true },
);

ServiceDurationRuleSchema.index({ providerServiceId: 1, branchId: 1 }, { unique: true });
