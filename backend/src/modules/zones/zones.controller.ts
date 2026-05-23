import { 
  Controller, Get, Post, Put, Param, Body, Query, 
  UseGuards, Request, HttpException, HttpStatus 
} from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { ZoneEngineService } from './zone-engine.service';

// DTOs - defined before usage
class CreateZoneDto {
  name: string;
  code: string;
  cityId?: string;
  cityName?: string;
  center: { type: 'Point'; coordinates: [number, number] };
  radiusKm?: number;
  zoneType?: 'district' | 'grid' | 'custom' | 'hotspot';
  config?: {
    baseSurge?: number;
    maxSurge?: number;
    autoMode?: boolean;
    priority?: number;
  };
}

class ZoneActionDto {
  actionType: 
    | 'surge_adjust'
    | 'supply_boost'
    | 'supply_pull'
    | 'push_notification'
    | 'radius_expand'
    | 'auto_mode_toggle'
    | 'status_change'
    | 'manual_override';
  data: {
    previousValue?: any;
    newValue?: any;
    reason?: string;
    expiresAt?: Date;
  };
}

/**
 * Zones Controller - City-Level Control API
 * 
 * Endpoints for zone management and monitoring:
 * - GET /api/admin/zones - List all zones with metrics
 * - GET /api/admin/zones/heatmap - Heatmap data
 * - GET /api/admin/zones/hot - Critical/surge zones
 * - GET /api/admin/zones/dead - Dead zones
 * - GET /api/admin/zones/kpis - City-level KPIs
 * - GET /api/admin/zones/:id - Zone details
 * - POST /api/admin/zones - Create zone
 * - POST /api/admin/zones/:id/action - Perform action on zone
 */
@Controller('admin/zones')
@UseGuards(JwtAuthGuard)
export class ZonesController {
  constructor(private readonly zoneEngine: ZoneEngineService) {}

  /**
   * Get all zones with current metrics
   */
  @Get()
  async getAllZones() {
    return this.zoneEngine.getAllZonesWithMetrics();
  }

  /**
   * Get heatmap data for map visualization
   */
  @Get('heatmap')
  async getHeatmap() {
    return this.zoneEngine.getZoneHeatmap();
  }

  /**
   * Get hot zones (surge/critical/dead)
   */
  @Get('hot')
  async getHotZones() {
    return this.zoneEngine.getHotZones();
  }

  /**
   * Get dead zones (no providers)
   */
  @Get('dead')
  async getDeadZones() {
    return this.zoneEngine.getDeadZones();
  }

  /**
   * Get city-level KPIs
   */
  @Get('kpis')
  async getCityKPIs(@Query('cityId') cityId?: string) {
    return this.zoneEngine.getCityKPIs(cityId);
  }

  /**
   * Get zone by ID with metrics and recent actions
   */
  @Get(':id')
  async getZone(@Param('id') id: string) {
    const zone = await this.zoneEngine.getZoneById(id);
    if (!zone) {
      throw new HttpException('Zone not found', HttpStatus.NOT_FOUND);
    }
    return zone;
  }

  /**
   * Create a new zone
   */
  @Post()
  async createZone(@Body() body: CreateZoneDto) {
    return this.zoneEngine.createZone(body);
  }

  /**
   * Perform action on zone
   */
  @Post(':id/action')
  async performAction(
    @Param('id') id: string,
    @Body() body: ZoneActionDto,
    @Request() req: any,
  ) {
    return this.zoneEngine.performZoneAction(
      id, 
      body.actionType, 
      body.data,
      req.user?.sub
    );
  }

  /**
   * Find providers for supply pull
   */
  @Get(':id/supply-pull')
  async findSupplyPull(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.zoneEngine.findProvidersForSupplyPull(id, parseInt(limit || '5'));
  }
}
