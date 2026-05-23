import { Schema } from 'mongoose';

/**
 * Blocked time periods (holidays, vacations, breaks)
 */
export const ProviderBlockedTimeSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    reason: { type: String, default: '' },
  },
  { timestamps: true },
);

ProviderBlockedTimeSchema.index({ branchId: 1, startAt: 1, endAt: 1 });
