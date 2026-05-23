import { Schema } from 'mongoose';

/**
 * RequestDistribution - лог распределения заявки мастерам
 * Это одна из самых важных сущностей для operator mode
 */
export const RequestDistributionSchema = new Schema(
  {
    requestId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Quote', 
      required: true, 
      index: true 
    },
    providerId: { 
      type: Schema.Types.ObjectId, 
      ref: 'Organization', 
      required: true, 
      index: true 
    },
    // Matching scores at distribution time
    matchingScore: { type: Number, default: 0 },
    visibilityScoreSnapshot: { type: Number, default: 0 },
    behavioralScoreSnapshot: { type: Number, default: 0 },
    // Geo data
    distanceKm: { type: Number, default: 0 },
    etaMinutes: { type: Number, default: 0 },
    // Matching reasons (explainability)
    reasons: [{ type: String }],
    // Distribution status lifecycle
    distributionStatus: {
      type: String,
      enum: [
        'sent',       // Отправлено мастеру
        'viewed',     // Мастер просмотрел
        'responded',  // Мастер ответил (предложил цену)
        'ignored',    // Мастер проигнорировал
        'expired',    // Время вышло
        'selected',   // Клиент/оператор выбрал этого мастера
        'rejected',   // Отклонён
      ],
      default: 'sent',
      index: true,
    },
    // Urgency level for TTL calculation
    urgency: {
      type: String,
      enum: ['critical', 'high', 'normal', 'low'],
      default: 'normal',
    },
    // Expiration time (calculated from urgency)
    expiresAt: { type: Date, required: true, index: true },
    // Re-distribution attempt number
    attemptNumber: { type: Number, default: 1 },
    // Timestamps для аналитики
    sentAt: { type: Date, default: Date.now },
    viewedAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    selectedAt: { type: Date, default: null },
    // Response data if responded
    responsePrice: { type: Number, default: null },
    responseEta: { type: Number, default: null },
    responseMessage: { type: String, default: '' },
    // Source of distribution
    distributedBy: {
      type: String,
      enum: ['auto', 'operator', 'system'],
      default: 'auto',
    },
    operatorId: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      default: null 
    },
  },
  { timestamps: true },
);

// Compound indexes for performance
RequestDistributionSchema.index({ requestId: 1, providerId: 1 }, { unique: true });
RequestDistributionSchema.index({ distributionStatus: 1, sentAt: -1 });
RequestDistributionSchema.index({ providerId: 1, distributionStatus: 1 });
RequestDistributionSchema.index({ expiresAt: 1, distributionStatus: 1 });  // For expire engine
RequestDistributionSchema.index({ requestId: 1, attemptNumber: 1 });  // For re-distribution
