import { Schema } from 'mongoose';

export const MatchingLogSchema = new Schema(
  {
    customerId: { type: String, index: true },
    serviceId: { type: String },
    lat: { type: Number },
    lng: { type: Number },
    results: [{
      providerId: { type: String },
      score: { type: Number },
      reasons: [{ type: String }],
    }],
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false },
);

MatchingLogSchema.index({ customerId: 1, createdAt: -1 });
