import { Controller, Get, Param, Query } from '@nestjs/common';
import { GeoService } from './geo.service';

@Controller('geo')
export class GeoController {
  constructor(private readonly geoService: GeoService) {}

  @Get('countries')
  getCountries() {
    return this.geoService.getCountries();
  }

  @Get('regions/:countryId')
  getRegions(@Param('countryId') countryId: string) {
    return this.geoService.getRegions(countryId);
  }

  @Get('cities')
  getCities(
    @Query('regionId') regionId?: string,
    @Query('search') search?: string,
  ) {
    return this.geoService.getCities({ regionId, search });
  }
}
