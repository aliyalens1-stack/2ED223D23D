import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@Controller('vehicles')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CUSTOMER)
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Post()
  create(@Req() req: any, @Body() dto: any) {
    return this.vehiclesService.create(req.user.sub, dto);
  }

  @Get('my')
  myVehicles(@Req() req: any) {
    return this.vehiclesService.myVehicles(req.user.sub);
  }

  @Get(':id')
  getById(@Param('id') id: string, @Req() req: any) {
    return this.vehiclesService.getById(id, req.user.sub);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Req() req: any, @Body() dto: any) {
    return this.vehiclesService.update(id, req.user.sub, dto);
  }

  @Delete(':id')
  archive(@Param('id') id: string, @Req() req: any) {
    return this.vehiclesService.archive(id, req.user.sub);
  }
}
