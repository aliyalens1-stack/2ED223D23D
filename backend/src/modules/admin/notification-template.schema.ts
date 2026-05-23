import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type NotificationTemplateDocument = NotificationTemplate & Document;

@Schema({ timestamps: true, collection: 'notification_templates' })
export class NotificationTemplate {
  @Prop({ required: true, unique: true })
  code: string; // e.g., 'urgent_request_nearby', 'low_acceptance_warning'

  @Prop({ required: true })
  title: string;

  @Prop({ required: true })
  message: string;

  @Prop()
  category: string; // supply, demand, system, promo

  @Prop({ type: [String], default: [] })
  channels: string[]; // push, sms, email

  @Prop({ type: Object })
  variables?: Record<string, string>; // placeholder descriptions

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: Date.now })
  createdAt: Date;

  @Prop()
  updatedAt?: Date;
}

export const NotificationTemplateSchema = SchemaFactory.createForClass(NotificationTemplate);
