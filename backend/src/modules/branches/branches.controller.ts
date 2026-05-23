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
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { BranchesService } from './branches.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Branches')
@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @Post()
  create(@Req() req: any, @Body() dto: any) {
    return this.branchesService.create(req.user.sub, dto);
  }

  @Get('nearby')
  @ApiOperation({ summary: 'Find nearby branches (geo-search)' })
  @ApiQuery({ name: 'lat', required: false, type: Number })
  @ApiQuery({ name: 'lng', required: false, type: Number })
  @ApiQuery({ name: 'radius', required: false, type: Number })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findNearby(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('radius') radius?: string,
    @Query('city') city?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchesService.findNearby({
      lat: lat ? parseFloat(lat) : 0,
      lng: lng ? parseFloat(lng) : 0,
      radius: radius ? parseFloat(radius) : 10,
      city: city || undefined,
      limit: limit ? parseInt(limit, 10) : 50,
    });
  }

  @Get('search')
  @ApiOperation({ summary: 'Search branches by text' })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiQuery({ name: 'city', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  search(
    @Query('q') query: string,
    @Query('city') city?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchesService.search(query || '', {
      city: city || undefined,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get('organization/:orgId')
  getByOrganization(@Param('orgId') orgId: string) {
    return this.branchesService.getByOrganization(orgId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.branchesService.getById(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Req() req: any, @Body() dto: any) {
    return this.branchesService.update(id, req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post(':id/activate')
  activate(@Param('id') id: string, @Req() req: any) {
    return this.branchesService.activate(id, req.user.sub);
  }
}
