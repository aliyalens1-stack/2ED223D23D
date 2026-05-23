import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { DemandEngineService, DemandMetrics } from './demand-engine.service';

/**
 * Demand Engine Controller
 * 
 * Admin endpoints for demand monitoring:
 * - GET /api/admin/demand/metrics - Current metrics
 * - GET /api/admin/demand/heatmap - Geo heatmap data
 * - GET /api/admin/demand/hot-areas - Areas needing providers
 * - GET /api/admin/demand/surge - Surge status
 */
@Controller('admin/demand')
@UseGuards(JwtAuthGuard)
export class DemandController {
  constructor(private readonly demandEngine: DemandEngineService) {}

  /**
   * Get current demand metrics
   */
  @Get('metrics')
  async getMetrics(@Query('cityId') cityId?: string) {
    if (cityId) {
      const metrics = await this.demandEngine.getMetricsForCity(cityId);
      return metrics || await this.demandEngine.calculateMetrics(cityId);
    }
    
    const current = this.demandEngine.getCurrentMetrics();
    if (!current) {
      return this.demandEngine.calculateMetrics();
    }
    return current;
  }

  /**
   * Get heatmap data for admin map visualization
   */
  @Get('heatmap')
  async getHeatmap() {
    return this.demandEngine.getHeatmapData();
  }

  /**
   * Get areas that need more providers
   */
  @Get('hot-areas')
  async getHotAreas() {
    return this.demandEngine.getProviderNeededAreas();
  }

  /**
   * Get current surge status
   */
  @Get('surge')
  async getSurgeStatus() {
    const metrics = this.demandEngine.getCurrentMetrics();
    return {
      isSurgeActive: this.demandEngine.isSurgeActive(),
      surgeMultiplier: this.demandEngine.getSurgeMultiplier(),
      marketState: metrics?.marketState || 'unknown',
      ratio: metrics?.ratio || 0,
      distributionSize: this.demandEngine.getDistributionSize(),
    };
  }

  /**
   * Force recalculate metrics (for testing)
   */
  @Get('recalculate')
  async recalculate(@Query('cityId') cityId?: string) {
    return this.demandEngine.calculateMetrics(cityId);
  }
}
