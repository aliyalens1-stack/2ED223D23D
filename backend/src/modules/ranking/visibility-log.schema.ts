import { Schema } from 'mongoose';

/**
 * Visibility Log Schema
 * Зберігає історію змін visibility score для аналітики
 */
export const VisibilityLogSchema = new Schema(
  {
    providerId: { type: String, required: true, index: true },
    oldScore: { type: Number, required: true },
    newScore: { type: Number, required: true },
    reason: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

// Index for quick queries
VisibilityLogSchema.index({ providerId: 1, createdAt: -1 });
