import { Schema } from 'mongoose';

export const UserDeviceSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceToken: { type: String, required: true },
    platform: { type: String, enum: ['ios', 'android', 'expo', 'web'], default: 'expo' },
    isActive: { type: Boolean, default: true },
    lastSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

UserDeviceSchema.index({ deviceToken: 1 }, { unique: true });
UserDeviceSchema.index({ userId: 1, isActive: 1 });
