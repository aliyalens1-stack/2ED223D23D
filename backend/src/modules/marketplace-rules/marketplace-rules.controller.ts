import { 
  Controller, Get, Post, Put, Delete, Param, Body, Query,
  UseGuards, Request, HttpException, HttpStatus 
} from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { MarketplaceRulesEngine } from './marketplace-rules-engine.service';
import { LearningEngineService } from './learning-engine.service';

// DTOs - defined before usage
class CreateRuleDto {
  name: string;
  code: string;
  description?: string;
  category: 'demand' | 'distribution' | 'supply' | 'provider' | 'pricing' | 'visibility';
  priority?: number;
  condition: {
    field: string;
    operator: 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq' | 'in' | 'between';
    value: any;
    value2?: any;
  };
  actions: Array<{
    type: string;
    params?: any;
    tunable?: boolean;
    paramRange?: { min: number; max: number; step?: number };
  }>;
  scope?: 'global' | 'zone' | 'provider' | 'city';
  targetZoneIds?: string[];
  cooldownSeconds?: number;
  isEnabled?: boolean;
  learning?: {
    enabled?: boolean;
    experimentMode?: boolean;
    explorationRate?: number;
  };
}

class UpdateRuleDto {
  name?: string;
  description?: string;
  priority?: number;
  condition?: any;
  actions?: any[];
  cooldownSeconds?: number;
  isEnabled?: boolean;
  learning?: any;
}

/**
 * Marketplace Rules Controller - Automated Marketplace API
 * 
 * Now with Self-Learning endpoints:
 * - GET /api/admin/market/learning/stats - Learning stats
 * - GET /api/admin/market/learning/performance - Rule performance
 * - GET /api/admin/market/learning/kpis - Market KPIs
 * - GET /api/admin/market/learning/experiments - Experiments
 * - POST /api/admin/market/learning/experiments - Create experiment
 */
@Controller('admin/market')
@UseGuards(JwtAuthGuard)
export class MarketplaceRulesController {
  constructor(
    private readonly rulesEngine: MarketplaceRulesEngine,
    private readonly learningEngine: LearningEngineService,
  ) {}

  /**
   * Get all marketplace rules
   */
  @Get('rules')
  async getAllRules() {
    return this.rulesEngine.getAllRules();
  }

  /**
   * Get rule by ID
   */
  @Get('rules/:id')
  async getRule(@Param('id') id: string) {
    const rule = await this.rulesEngine.getRuleById(id);
    if (!rule) {
      throw new HttpException('Rule not found', HttpStatus.NOT_FOUND);
    }
    return rule;
  }

  /**
   * Create a new rule
   */
  @Post('rules')
  async createRule(@Body() body: CreateRuleDto) {
    return this.rulesEngine.createRule(body);
  }

  /**
   * Update a rule
   */
  @Put('rules/:id')
  async updateRule(@Param('id') id: string, @Body() body: UpdateRuleDto) {
    return this.rulesEngine.updateRule(id, body);
  }

  /**
   * Toggle rule enabled/disabled
   */
  @Post('rules/:id/toggle')
  async toggleRule(@Param('id') id: string) {
    return this.rulesEngine.toggleRule(id);
  }

  /**
   * Delete a rule
   */
  @Delete('rules/:id')
  async deleteRule(@Param('id') id: string) {
    await this.rulesEngine.deleteRule(id);
    return { success: true };
  }

  /**
   * Get marketplace stats
   */
  @Get('stats')
  async getStats() {
    return this.rulesEngine.getStats();
  }

  /**
   * Get auto mode status
   */
  @Get('auto-mode')
  async getAutoMode() {
    return {
      enabled: await this.rulesEngine.getAutoMode(),
    };
  }

  /**
   * Set auto mode
   */
  @Post('auto-mode')
  async setAutoMode(@Body() body: { enabled: boolean }) {
    await this.rulesEngine.setAutoMode(body.enabled);
    return {
      enabled: body.enabled,
      message: `Auto mode ${body.enabled ? 'enabled' : 'disabled'}`,
    };
  }

  /**
   * Get rule executions (audit log)
   */
  @Get('executions')
  async getExecutions(
    @Query('ruleId') ruleId?: string,
    @Query('zoneId') zoneId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rulesEngine.getExecutions({
      ruleId,
      zoneId,
      limit: limit ? parseInt(limit) : 50,
    });
  }

  /**
   * Manual trigger for testing
   */
  @Post('trigger/:zoneId')
  async manualTrigger(@Param('zoneId') zoneId: string) {
    await this.rulesEngine.manualTrigger(zoneId);
    return { success: true, message: 'Rules evaluated' };
  }

  // ========== LEARNING ENGINE ENDPOINTS ==========

  /**
   * Get learning stats
   */
  @Get('learning/stats')
  async getLearningStats() {
    return this.learningEngine.getLearningStats();
  }

  /**
   * Get rule performance data
   */
  @Get('learning/performance')
  async getRulePerformance(@Query('ruleId') ruleId?: string) {
    return this.learningEngine.getRulePerformance(ruleId);
  }

  /**
   * Get market KPIs
   */
  @Get('learning/kpis')
  async getMarketKPIs(
    @Query('scope') scope?: string,
    @Query('zoneId') zoneId?: string,
    @Query('periodType') periodType?: string,
    @Query('limit') limit?: string,
  ) {
    return this.learningEngine.getMarketKPIs({
      scope,
      zoneId,
      periodType,
      limit: limit ? parseInt(limit) : 60,
    });
  }

  /**
   * Get experiments
   */
  @Get('learning/experiments')
  async getExperiments(@Query('status') status?: string) {
    return this.learningEngine.getExperiments(status);
  }

  /**
   * Create experiment
   */
  @Post('learning/experiments')
  async createExperiment(@Body() body: any) {
    return this.learningEngine.createExperiment(body);
  }

  /**
   * Start experiment
   */
  @Post('learning/experiments/:id/start')
  async startExperiment(@Param('id') id: string) {
    return this.learningEngine.startExperiment(id);
  }

  /**
   * Force outcome measurement (for testing)
   */
  @Post('learning/measure/:executionId')
  async forceMeasurement(@Param('executionId') executionId: string) {
    await this.learningEngine.forceOutcomeMeasurement(executionId);
    return { success: true, message: 'Outcome measured' };
  }
}
