import { Schema } from 'mongoose';
import { GeoStatus } from '../../shared/enums';

export const CountrySchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true },
    name: { type: String, required: true },
    nameLocal: { type: String, default: '' },
    currency: { type: String, default: 'RUB' },
    timezone: { type: String, default: 'Europe/Moscow' },
    phoneCode: { type: String, required: true },
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE },
  },
  { timestamps: true },
);

export const RegionSchema = new Schema(
  {
    countryId: { type: Schema.Types.ObjectId, ref: 'Country', required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    nameLocal: { type: String, default: '' },
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE },
  },
  { timestamps: true },
);

export const CitySchema = new Schema(
  {
    regionId: { type: Schema.Types.ObjectId, ref: 'Region', required: true, index: true },
    name: { type: String, required: true },
    nameLocal: { type: String, default: '' },
    slug: { type: String, required: true, index: true },
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 },
    population: { type: Number, default: 0 },
    timezone: { type: String, default: '' },
    status: { type: String, enum: Object.values(GeoStatus), default: GeoStatus.ACTIVE },
  },
  { timestamps: true },
);

CitySchema.index({ name: 'text', nameLocal: 'text' });
