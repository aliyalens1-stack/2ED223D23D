import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ExperimentDocument = Experiment & Document;

@Schema({ timestamps: true, collection: 'experiments' })
export class Experiment {
  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  featureFlagKey: string;

  @Prop({ type: [Object], required: true })
  variants: {
    id: string;
    name: string;
    config: Record<string, any>;
    weight: number; // traffic %
  }[];

  @Prop({ required: true })
  metric: string; // conversion_rate, gmv, response_time, etc.

  @Prop({ default: 'draft' })
  status: string; // draft, active, paused, completed

  @Prop({ type: Object })
  results?: {
    variantId: string;
    sampleSize: number;
    metricValue: number;
    confidence?: number;
  }[];

  @Prop({ type: Object })
  conditions?: {
    cities?: string[];
    tiers?: string[];
  };

  @Prop()
  startDate?: Date;

  @Prop()
  endDate?: Date;

  @Prop({ type: Types.ObjectId, ref: 'User' })
  createdBy?: Types.ObjectId;

  @Prop({ default: Date.now })
  createdAt: Date;
}

export const ExperimentSchema = SchemaFactory.createForClass(Experiment);
