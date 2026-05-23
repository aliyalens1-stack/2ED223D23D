import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

/**
 * 🔥 QUOTE DISTRIBUTION — Track how quotes are distributed to providers
 * 
 * This is CRITICAL for:
 * 1. Response tracking (who responded, who didn't)
 * 2. Behavioral scoring (fast response = higher rank)
 * 3. Market health metrics
 */

export enum DistributionStatus {
  SENT = 'sent',           // Отправлено мастеру
  VIEWED = 'viewed',       // Мастер открыл
  RESPONDED = 'responded', // Мастер ответил (any response)
  ACCEPTED = 'accepted',   // Мастер принял заявку
  REJECTED = 'rejected',   // Мастер отказался
  IGNORED = 'ignored',     // Мастер не ответил (expired)
  EXPIRED = 'expired',     // Время истекло
}

@Schema({ timestamps: true, collection: 'quote_distributions' })
export class QuoteDistribution extends Document {
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Quote', required: true, index: true })
  quoteId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Organization', required: true, index: true })
  organizationId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Branch' })
  branchId?: Types.ObjectId;

  @Prop({ type: String, enum: DistributionStatus, default: DistributionStatus.SENT, index: true })
  status: DistributionStatus;

  // Timestamps for tracking
  @Prop({ type: Date, default: Date.now })
  sentAt: Date;

  @Prop({ type: Date })
  viewedAt?: Date;

  @Prop({ type: Date })
  respondedAt?: Date;

  // Response time in seconds (key metric!)
  @Prop({ type: Number })
  responseTimeSeconds?: number;

  // Priority at time of distribution (for analysis)
  @Prop({ type: Number, default: 0 })
  priorityAtSend: number;

  // Was this provider boosted when sent?
  @Prop({ type: Boolean, default: false })
  wasBoosted: boolean;

  // Distance from customer (km)
  @Prop({ type: Number })
  distanceKm?: number;

  // Expiration (usually 30 min for quick requests)
  @Prop({ type: Date })
  expiresAt?: Date;

  // Notes (for manual operations)
  @Prop({ type: String })
  notes?: string;
}

export const QuoteDistributionSchema = SchemaFactory.createForClass(QuoteDistribution);

// Indexes for fast queries
QuoteDistributionSchema.index({ quoteId: 1, organizationId: 1 }, { unique: true });
QuoteDistributionSchema.index({ organizationId: 1, status: 1 });
QuoteDistributionSchema.index({ status: 1, expiresAt: 1 });
QuoteDistributionSchema.index({ sentAt: -1 });
