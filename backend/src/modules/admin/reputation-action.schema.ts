import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ReputationActionDocument = ReputationAction & Document;

@Schema({ timestamps: true, collection: 'reputation_actions' })
export class ReputationAction {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true })
  providerId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  performedBy: Types.ObjectId;

  @Prop({ required: true })
  actionType: string; // rating_adjust, review_hide, trust_flag, penalize, boost

  @Prop({ type: Object })
  oldValue?: Record<string, any>;

  @Prop({ type: Object })
  newValue?: Record<string, any>;

  @Prop()
  reason?: string;

  @Prop()
  reviewId?: string;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ReputationActionSchema = SchemaFactory.createForClass(ReputationAction);
