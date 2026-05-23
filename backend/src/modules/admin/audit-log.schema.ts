import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type AuditLogDocument = AuditLog & Document;

@Schema({ timestamps: true, collection: 'audit_logs' })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  userId?: Types.ObjectId;

  @Prop({ required: true })
  actor: string; // ADMIN, SYSTEM, PROVIDER, CUSTOMER

  @Prop()
  actorEmail?: string;

  @Prop({ required: true })
  action: string; // e.g., 'boost_provider', 'apply_surge', 'accept_request'

  @Prop({ required: true })
  entityType: string; // provider, booking, rule, zone, quote

  @Prop({ type: Types.ObjectId })
  entityId?: Types.ObjectId;

  @Prop({ type: Object })
  oldValue?: Record<string, any>;

  @Prop({ type: Object })
  newValue?: Record<string, any>;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop()
  description?: string;

  @Prop()
  ipAddress?: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

// Indexes
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actor: 1 });
AuditLogSchema.index({ entityType: 1 });
AuditLogSchema.index({ action: 1 });
AuditLogSchema.index({ userId: 1 });
