import { Schema } from 'mongoose';
import { GeoStatus } from '../../shared/enums';

export const ServiceCategorySchema = new Schema(
  {
    parentId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', default: null },
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    icon: { type: String, default: '' },
    sortOrder: { type: Number, default: 0 },
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE },
  },
  { timestamps: true },
);

export const ServiceSchema = new Schema(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: 'ServiceCategory', required: true, index: true },
    name: { type: String, required: true, index: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '' },
    durationMin: { type: Number, default: 30 },
    durationMax: { type: Number, default: 60 },
    priceMin: { type: Number, default: 0 },
    priceMax: { type: Number, default: 0 },
    requiresDiagnostics: { type: Boolean, default: false },
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE, index: true },
  },
  { timestamps: true },
);

ServiceSchema.index({ name: 'text', description: 'text' });
