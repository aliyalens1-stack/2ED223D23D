import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type FeatureFlagDocument = FeatureFlag & Document;

@Schema({ timestamps: true, collection: 'feature_flags' })
export class FeatureFlag {
  @Prop({ required: true, unique: true })
  key: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop({ default: false })
  enabled: boolean;

  @Prop({ default: 100, min: 0, max: 100 })
  rollout: number; // % of users affected

  @Prop({ type: Object })
  conditions?: {
    cities?: string[];
    tiers?: string[];
    minScore?: number;
    userIds?: string[];
    providerIds?: string[];
  };

  @Prop({ default: 'release' })
  type: string; // release, experiment, ops

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop({ default: Date.now })
  createdAt: Date;

  @Prop()
  updatedAt?: Date;
}

export const FeatureFlagSchema = SchemaFactory.createForClass(FeatureFlag);
