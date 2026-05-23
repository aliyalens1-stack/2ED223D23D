import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GeoStatus } from '../../shared/enums';

@Injectable()
export class GeoService {
  constructor(
    @InjectModel('Country') private readonly countryModel: Model<any>,
    @InjectModel('Region') private readonly regionModel: Model<any>,
    @InjectModel('City') private readonly cityModel: Model<any>,
  ) {}

  async getCountries() {
    return this.countryModel.find({ status: GeoStatus.ACTIVE }).sort({ name: 1 }).lean();
  }

  async getRegions(countryId: string) {
    return this.regionModel.find({ countryId }).sort({ name: 1 }).lean();
  }

  async getCities(query: { regionId?: string; search?: string }) {
    const filter: any = { status: GeoStatus.ACTIVE };
    if (query.regionId) filter.regionId = query.regionId;
    if (query.search && query.search.length >= 2) {
      filter.$or = [
        { name: { $regex: query.search, $options: 'i' } },
        { nameLocal: { $regex: query.search, $options: 'i' } },
      ];
    }
    return this.cityModel.find(filter).sort({ name: 1 }).limit(100).lean();
  }
}
