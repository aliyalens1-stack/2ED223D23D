import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ProviderServicesService } from './provider-services.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@Controller('provider-services')
export class ProviderServicesController {
  constructor(private readonly psService: ProviderServicesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @Post()
  create(@Req() req: any, @Body() dto: any) {
    return this.psService.create(req.user.sub, dto);
  }

  @Get('organization/:orgId')
  getByOrganization(
    @Param('orgId') orgId: string,
    @Query('branchId') branchId?: string,
  ) {
    return this.psService.getByOrganization(orgId, branchId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Req() req: any, @Body() dto: any) {
    return this.psService.update(id, req.user.sub, dto);
  }
}
