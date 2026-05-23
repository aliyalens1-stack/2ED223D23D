import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CountrySchema, RegionSchema, CitySchema } from './geo.schema';
import { GeoService } from './geo.service';
import { GeoController } from './geo.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Country', schema: CountrySchema },
      { name: 'Region', schema: RegionSchema },
      { name: 'City', schema: CitySchema },
    ]),
  ],
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
