import { Schema } from 'mongoose';
import { VehicleStatus } from '../../shared/enums';

export const VehicleSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    vin: { type: String, default: null },
    licensePlate: { type: String, default: '' },
    engineType: { type: String, default: '' },
    transmission: { type: String, default: '' },
    color: { type: String, default: '' },
    mileage: { type: Number, default: 0 },
    status: { type: String, enum: Object.values(VehicleStatus), default: VehicleStatus.ACTIVE, index: true },
  },
  { timestamps: true },
);

VehicleSchema.index({ vin: 1 }, { unique: true, sparse: true });
