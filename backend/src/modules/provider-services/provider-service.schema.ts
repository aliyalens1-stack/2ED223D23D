import { Schema } from 'mongoose';
import { GeoStatus } from '../../shared/enums';

export const ProviderServiceSchema = new Schema(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
      index: true,
    },
    serviceId: {
      type: Schema.Types.ObjectId,
      ref: 'Service',
      required: true,
      index: true,
    },
    price: { type: Number, required: true },
    priceFrom: { type: Number, default: 0 },
    priceTo: { type: Number, default: 0 },
    duration: { type: Number, default: 60 },
    warrantyDays: { type: Number, default: 0 },
    description: { type: String, default: '' },
    brandsSupported: [{ type: String }],
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE, index: true },
  },
  { timestamps: true },
);

ProviderServiceSchema.index({ organizationId: 1, serviceId: 1, branchId: 1 });
