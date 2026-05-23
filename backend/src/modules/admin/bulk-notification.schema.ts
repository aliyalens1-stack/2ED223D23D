import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type BulkNotificationDocument = BulkNotification & Document;

@Schema({ timestamps: true, collection: 'bulk_notifications' })
export class BulkNotification {
  @Prop({ type: Types.ObjectId, ref: 'User' })
  sentBy: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  message: string;

  @Prop()
  templateCode?: string;

  @Prop({ type: Object })
  filters: {
    zones?: string[];
    tiers?: string[];
    minScore?: number;
    maxScore?: number;
    isOnline?: boolean;
    roles?: string[];
  };

  @Prop({ type: [String], default: ['push'] })
  channels: string[];

  @Prop({ default: 0 })
  recipientCount: number;

  @Prop({ default: 0 })
  deliveredCount: number;

  @Prop({ default: 0 })
  failedCount: number;

  @Prop({ default: 'pending' })
  status: string; // pending, sending, completed, failed

  @Prop({ default: Date.now })
  createdAt: Date;

  @Prop()
  completedAt?: Date;
}

export const BulkNotificationSchema = SchemaFactory.createForClass(BulkNotification);
