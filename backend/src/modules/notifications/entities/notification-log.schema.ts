import { Schema } from 'mongoose';

export const NotificationLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
    deliveredCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

NotificationLogSchema.index({ userId: 1, createdAt: -1 });
