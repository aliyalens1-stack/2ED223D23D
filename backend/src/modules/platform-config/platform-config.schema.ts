import { Schema } from 'mongoose';

export const PlatformConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, default: '' },
    isSecret: { type: Boolean, default: false },
  },
  { timestamps: true },
);
