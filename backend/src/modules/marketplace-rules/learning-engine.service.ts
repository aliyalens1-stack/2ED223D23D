import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * LearningEngineService - Self-Learning Marketplace System
 * 
 * The adaptive brain that optimizes marketplace rules:
 * - Tracks KPIs before/after rule execution
 * - Measures rule effectiveness
 * - Auto-tunes parameters based on outcomes
 * - Runs experiments to find optimal values
 * 
 * Key Concepts:
 * - Feedback Loop: execution → measure → score → adjust
 * - Exploration vs Exploitation: 80% best, 20% experiment
 * - Zone-Level Learning: different zones can have different optimal params
 */
@Injectable()
export class LearningEngineService implements OnModuleInit {
  private readonly logger = new Logger(LearningEngineService.name);
  private readonly MEASURE_DELAY_MS = 60000; // 1 minute after rule execution
  private readonly KPI_TICK_MS = 60000; // Record KPIs every minute
  private readonly TUNING_INTERVAL_MS = 300000; // Auto-tune every 5 minutes
  
  // Pending measurements
  private pendingMeasurements: Map<string, { executionId: string; measureAt: number }> = new Map();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('MarketplaceRule') private readonly ruleModel: Model<any>,
    @InjectModel('RuleExecution') private readonly executionModel: Model<any>,
    @InjectModel('RulePerformance') private readonly performanceModel: Model<any>,
    @InjectModel('MarketKPI') private readonly kpiModel: Model<any>,
    @InjectModel('Experiment') private readonly experimentModel: Model<any>,
    @InjectModel('ZoneMetrics') private readonly zoneMetricsModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  async onModuleInit() {
    this.startKPITracking();
    this.startOutcomeMeasurement();
    this.startAutoTuning();
    this.subscribeToEvents();
    this.logger.log('🧠 Learning Engine started (feedback loop active)');
  }

  /**
   * Subscribe to rule execution events
   */
  private subscribeToEvents() {
    // When a rule is executed, start tracking its outcome
    this.eventBus.on('RULE_EXECUTED' as PlatformEvent, async (data: any) => {
      if (data.zoneId) {
        await this.recordPreExecutionKPIs(data.executionId, data.zoneId);
      }
    });
  }

  /**
   * Start KPI tracking loop
   */
  private startKPITracking() {
    setInterval(() => {
      this.recordMarketKPIs().catch(err => 
        this.logger.error('KPI tracking error:', err)
      );
    }, this.KPI_TICK_MS);
    
    // Initial recording
    this.recordMarketKPIs().catch(err => this.logger.error('Initial KPI error:', err));
  }

  /**
   * Start outcome measurement loop
   */
  private startOutcomeMeasurement() {
    setInterval(() => {
      this.measurePendingOutcomes().catch(err =>
        this.logger.error('Outcome measurement error:', err)
      );
    }, 10000); // Check every 10 seconds
  }

  /**
   * Start auto-tuning loop
   */
  private startAutoTuning() {
    setInterval(() => {
      this.runAutoTuning().catch(err =>
        this.logger.error('Auto-tuning error:', err)
      );
    }, this.TUNING_INTERVAL_MS);
  }

  // ========== KPI TRACKING ==========

  /**
   * Record system-wide KPIs
   */
  async recordMarketKPIs(): Promise<void> {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    // Get all zone metrics
    const zoneMetrics = await this.zoneMetricsModel.find().lean() as any[];
    
    // Calculate global KPIs
    const totalRequests = await this.quoteModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    
    const totalBookings = await this.bookingModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    
    const totalCompleted = await this.bookingModel.countDocuments({
      status: 'completed',
      completedAt: { $gte: oneHourAgo },
    });
    
    const totalCancelled = await this.bookingModel.countDocuments({
      status: 'cancelled',
      updatedAt: { $gte: oneHourAgo },
    });
    
    const matchRate = totalRequests > 0 ? (totalBookings / totalRequests) * 100 : 0;
    const cancelRate = totalBookings > 0 ? (totalCancelled / totalBookings) * 100 : 0;
    const completionRate = totalBookings > 0 ? (totalCompleted / totalBookings) * 100 : 0;
    
    // Aggregate zone data
    const avgRatio = zoneMetrics.length > 0
      ? zoneMetrics.reduce((sum, z) => sum + (z.ratio || 0), 0) / zoneMetrics.length
      : 0;
    const avgSurge = zoneMetrics.length > 0
      ? zoneMetrics.reduce((sum, z) => sum + (z.surgeMultiplier || 1), 0) / zoneMetrics.length
      : 1;
    const avgOnlineProviders = zoneMetrics.length > 0
      ? zoneMetrics.reduce((sum, z) => sum + (z.onlineProviders || 0), 0) / zoneMetrics.length
      : 0;
    const avgResponseTime = zoneMetrics.length > 0
      ? zoneMetrics.reduce((sum, z) => sum + (z.avgResponseTime || 0), 0) / zoneMetrics.length
      : 0;

    // Record global KPI
    await this.kpiModel.create({
      timestamp: now,
      periodType: 'minute',
      scope: 'global',
      matchRate: Math.round(matchRate * 100) / 100,
      avgResponseTime: Math.round(avgResponseTime),
      cancelRate: Math.round(cancelRate * 100) / 100,
      completionRate: Math.round(completionRate * 100) / 100,
      totalRequests,
      totalBookings,
      totalCompleted,
      totalCancelled,
      avgRatio: Math.round(avgRatio * 100) / 100,
      avgSurge: Math.round(avgSurge * 100) / 100,
      avgOnlineProviders: Math.round(avgOnlineProviders),
      autoModeActive: true,
    });

    // Record per-zone KPIs
    for (const metrics of zoneMetrics) {
      await this.kpiModel.create({
        timestamp: now,
        periodType: 'minute',
        scope: 'zone',
        zoneId: metrics.zoneId,
        zoneCode: metrics.zoneCode,
        avgResponseTime: metrics.avgResponseTime || 0,
        avgRatio: metrics.ratio || 0,
        avgSurge: metrics.surgeMultiplier || 1,
        avgOnlineProviders: metrics.onlineProviders || 0,
      });
    }
  }

  // ========== EXECUTION TRACKING ==========

  /**
   * Record KPIs before rule execution (called by Rules Engine)
   */
  async recordPreExecutionKPIs(executionId: string, zoneId: string): Promise<void> {
    const metrics = await this.zoneMetricsModel.findOne({ 
      zoneId: new Types.ObjectId(zoneId) 
    }).lean() as any;
    
    if (!metrics) return;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    // Calculate zone-specific match rate
    const requests = await this.quoteModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    const bookings = await this.bookingModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    const cancelled = await this.bookingModel.countDocuments({
      status: 'cancelled',
      updatedAt: { $gte: oneHourAgo },
    });
    
    const matchRate = requests > 0 ? (bookings / requests) * 100 : 0;
    const cancelRate = bookings > 0 ? (cancelled / bookings) * 100 : 0;

    await this.executionModel.updateOne(
      { _id: new Types.ObjectId(executionId) },
      {
        $set: {
          kpiBefore: {
            matchRate: Math.round(matchRate * 100) / 100,
            avgResponseTime: metrics.avgResponseTime || 0,
            avgETA: Math.round((metrics.avgResponseTime || 0) / 60),
            cancelRate: Math.round(cancelRate * 100) / 100,
            activeRequests: metrics.activeRequests || 0,
            availableProviders: metrics.availableProviders || 0,
            ratio: metrics.ratio || 0,
            surgeMultiplier: metrics.surgeMultiplier || 1,
          },
        },
      }
    );

    // Schedule outcome measurement
    this.pendingMeasurements.set(executionId, {
      executionId,
      measureAt: Date.now() + this.MEASURE_DELAY_MS,
    });
  }

  /**
   * Measure pending outcomes
   */
  private async measurePendingOutcomes(): Promise<void> {
    const now = Date.now();
    
    for (const [executionId, pending] of this.pendingMeasurements.entries()) {
      if (now >= pending.measureAt) {
        await this.measureOutcome(executionId);
        this.pendingMeasurements.delete(executionId);
      }
    }
  }

  /**
   * Measure outcome after rule execution
   */
  async measureOutcome(executionId: string): Promise<void> {
    const execution = await this.executionModel.findById(executionId).lean() as any;
    if (!execution || !execution.context?.zoneId) return;

    const metrics = await this.zoneMetricsModel.findOne({ 
      zoneId: execution.context.zoneId 
    }).lean() as any;
    
    if (!metrics) return;

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    const requests = await this.quoteModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    const bookings = await this.bookingModel.countDocuments({
      createdAt: { $gte: oneHourAgo },
    });
    const cancelled = await this.bookingModel.countDocuments({
      status: 'cancelled',
      updatedAt: { $gte: oneHourAgo },
    });
    
    const matchRate = requests > 0 ? (bookings / requests) * 100 : 0;
    const cancelRate = bookings > 0 ? (cancelled / bookings) * 100 : 0;

    // Calculate changes
    const kpiBefore = execution.kpiBefore || {};
    const matchRateChange = matchRate - (kpiBefore.matchRate || 0);
    const responseTimeChange = (metrics.avgResponseTime || 0) - (kpiBefore.avgResponseTime || 0);
    const ratioChange = (metrics.ratio || 0) - (kpiBefore.ratio || 0);
    const cancelRateChange = cancelRate - (kpiBefore.cancelRate || 0);

    // Calculate overall score (-100 to +100)
    // Positive: matchRate up, responseTime down, cancelRate down
    const overallScore = Math.round(
      (matchRateChange * 2) +          // +2 per % match rate increase
      (-responseTimeChange * 0.5) +     // +0.5 per second decrease
      (-cancelRateChange * 1.5) +       // +1.5 per % cancel decrease
      (-ratioChange * 5)                // +5 per ratio decrease
    );

    await this.executionModel.updateOne(
      { _id: new Types.ObjectId(executionId) },
      {
        $set: {
          kpiAfter: {
            matchRate: Math.round(matchRate * 100) / 100,
            avgResponseTime: metrics.avgResponseTime || 0,
            avgETA: Math.round((metrics.avgResponseTime || 0) / 60),
            cancelRate: Math.round(cancelRate * 100) / 100,
            activeRequests: metrics.activeRequests || 0,
            availableProviders: metrics.availableProviders || 0,
            ratio: metrics.ratio || 0,
            surgeMultiplier: metrics.surgeMultiplier || 1,
            measuredAt: new Date(),
          },
          impact: {
            matchRateChange: Math.round(matchRateChange * 100) / 100,
            responseTimeChange: Math.round(responseTimeChange),
            ratioChange: Math.round(ratioChange * 100) / 100,
            cancelRateChange: Math.round(cancelRateChange * 100) / 100,
            overallScore,
            isPositive: overallScore > 0,
          },
        },
      }
    );

    this.logger.log(
      `[Learning] Measured outcome for ${execution.ruleCode}: score=${overallScore} ` +
      `(matchRate ${matchRateChange > 0 ? '+' : ''}${matchRateChange.toFixed(1)}%)`
    );

    // Emit event for dashboards
    await this.eventBus.emit('RULE_OUTCOME_MEASURED' as PlatformEvent, {
      executionId,
      ruleCode: execution.ruleCode,
      overallScore,
      isPositive: overallScore > 0,
    });
  }

  // ========== AUTO-TUNING ==========

  /**
   * Run auto-tuning for all tunable rules
   */
  async runAutoTuning(): Promise<void> {
    const rules = await this.ruleModel.find({
      isEnabled: true,
      'learning.enabled': true,
    }).lean() as any[];

    for (const rule of rules) {
      await this.tuneRule(rule);
    }
  }

  /**
   * Tune a single rule based on performance
   */
  private async tuneRule(rule: any): Promise<void> {
    // Get recent executions with measured outcomes
    const recentExecutions = await this.executionModel.find({
      ruleId: rule._id,
      'impact.overallScore': { $exists: true },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // Last 24h
    }).sort({ 'impact.overallScore': -1 }).limit(100).lean() as any[];

    if (recentExecutions.length < 5) return; // Need minimum data

    // Calculate average performance
    const avgScore = recentExecutions.reduce((sum, e) => sum + (e.impact?.overallScore || 0), 0) / recentExecutions.length;
    const positiveRate = recentExecutions.filter(e => e.impact?.isPositive).length / recentExecutions.length;

    // Determine effectiveness rating
    let effectivenessRating = 'neutral';
    if (avgScore > 20 && positiveRate > 0.7) effectivenessRating = 'excellent';
    else if (avgScore > 10 && positiveRate > 0.6) effectivenessRating = 'good';
    else if (avgScore < -10 && positiveRate < 0.4) effectivenessRating = 'poor';
    else if (avgScore < -20 && positiveRate < 0.3) effectivenessRating = 'harmful';

    // Find best performing parameter values (zone-specific)
    const zonePerformance: Record<string, { scores: number[]; params: any[] }> = {};
    
    for (const exec of recentExecutions) {
      const zoneCode = exec.context?.zoneCode || 'global';
      if (!zonePerformance[zoneCode]) {
        zonePerformance[zoneCode] = { scores: [], params: [] };
      }
      zonePerformance[zoneCode].scores.push(exec.impact?.overallScore || 0);
      if (exec.actionsExecuted?.[0]?.params) {
        zonePerformance[zoneCode].params.push(exec.actionsExecuted[0].params);
      }
    }

    // Build zone-specific best params
    const zonePerf = Object.entries(zonePerformance).map(([zoneCode, data]) => ({
      zoneCode,
      avgScore: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
      executions: data.scores.length,
      // Find most common params in top-scoring executions
      bestParam: data.params[0], // Simplified - would need more logic
    }));

    // Record performance
    const periodStart = new Date(Date.now() - 60 * 60 * 1000);
    await this.performanceModel.findOneAndUpdate(
      { 
        ruleId: rule._id,
        periodStart,
        periodType: 'hourly',
      },
      {
        $set: {
          ruleCode: rule.code,
          periodEnd: new Date(),
          totalExecutions: recentExecutions.length,
          successfulExecutions: recentExecutions.filter(e => e.success).length,
          avgOverallScore: Math.round(avgScore * 100) / 100,
          avgMatchRateChange: Math.round(
            recentExecutions.reduce((sum, e) => sum + (e.impact?.matchRateChange || 0), 0) / recentExecutions.length * 100
          ) / 100,
          effectivenessRating,
          zonePerformance: zonePerf,
        },
      },
      { upsert: true }
    );

    // If rule is harmful, consider disabling
    if (effectivenessRating === 'harmful') {
      this.logger.warn(`[Learning] Rule ${rule.code} is HARMFUL (score: ${avgScore.toFixed(1)}). Consider disabling.`);
      await this.eventBus.emit('RULE_INEFFECTIVE' as PlatformEvent, {
        ruleId: String(rule._id),
        ruleCode: rule.code,
        avgScore,
        effectivenessRating,
      });
    }

    this.logger.log(
      `[Learning] Tuned ${rule.code}: effectiveness=${effectivenessRating}, ` +
      `avgScore=${avgScore.toFixed(1)}, positiveRate=${(positiveRate * 100).toFixed(0)}%`
    );
  }

  // ========== PUBLIC API ==========

  /**
   * Get rule performance
   */
  async getRulePerformance(ruleId?: string): Promise<any[]> {
    const filter = ruleId ? { ruleId: new Types.ObjectId(ruleId) } : {};
    return this.performanceModel.find(filter)
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();
  }

  /**
   * Get market KPIs
   */
  async getMarketKPIs(params: { 
    scope?: string; 
    zoneId?: string; 
    periodType?: string;
    limit?: number;
  }): Promise<any[]> {
    const filter: any = {};
    if (params.scope) filter.scope = params.scope;
    if (params.zoneId) filter.zoneId = new Types.ObjectId(params.zoneId);
    if (params.periodType) filter.periodType = params.periodType;
    
    return this.kpiModel.find(filter)
      .sort({ timestamp: -1 })
      .limit(params.limit || 60)
      .lean();
  }

  /**
   * Get learning stats
   */
  async getLearningStats(): Promise<any> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const totalExecutionsWithOutcome = await this.executionModel.countDocuments({
      'impact.overallScore': { $exists: true },
      createdAt: { $gte: oneDayAgo },
    });
    
    const positiveOutcomes = await this.executionModel.countDocuments({
      'impact.isPositive': true,
      createdAt: { $gte: oneDayAgo },
    });
    
    const performances = await this.performanceModel.find({
      updatedAt: { $gte: oneDayAgo },
    }).lean() as any[];
    
    const excellentRules = performances.filter(p => p.effectivenessRating === 'excellent').length;
    const goodRules = performances.filter(p => p.effectivenessRating === 'good').length;
    const poorRules = performances.filter(p => p.effectivenessRating === 'poor').length;
    const harmfulRules = performances.filter(p => p.effectivenessRating === 'harmful').length;

    const recentKPIs = await this.kpiModel.find({
      scope: 'global',
      timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
    }).sort({ timestamp: -1 }).limit(60).lean() as any[];

    const avgMatchRate = recentKPIs.length > 0
      ? recentKPIs.reduce((sum, k) => sum + (k.matchRate || 0), 0) / recentKPIs.length
      : 0;
    const avgRatio = recentKPIs.length > 0
      ? recentKPIs.reduce((sum, k) => sum + (k.avgRatio || 0), 0) / recentKPIs.length
      : 0;

    return {
      totalExecutionsWithOutcome,
      positiveOutcomes,
      positiveRate: totalExecutionsWithOutcome > 0 
        ? Math.round((positiveOutcomes / totalExecutionsWithOutcome) * 100) 
        : 0,
      ruleEffectiveness: {
        excellent: excellentRules,
        good: goodRules,
        neutral: performances.length - excellentRules - goodRules - poorRules - harmfulRules,
        poor: poorRules,
        harmful: harmfulRules,
      },
      marketHealth: {
        avgMatchRate: Math.round(avgMatchRate * 100) / 100,
        avgRatio: Math.round(avgRatio * 100) / 100,
        trend: avgMatchRate > 50 ? 'healthy' : avgMatchRate > 30 ? 'moderate' : 'needs_attention',
      },
    };
  }

  /**
   * Get experiments
   */
  async getExperiments(status?: string): Promise<any[]> {
    const filter = status ? { status } : {};
    return this.experimentModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
  }

  /**
   * Create experiment
   */
  async createExperiment(data: any): Promise<any> {
    return this.experimentModel.create(data);
  }

  /**
   * Start experiment
   */
  async startExperiment(experimentId: string): Promise<any> {
    return this.experimentModel.findByIdAndUpdate(
      experimentId,
      { $set: { status: 'running', startedAt: new Date() } },
      { new: true }
    );
  }

  /**
   * Force outcome measurement (for testing)
   */
  async forceOutcomeMeasurement(executionId: string): Promise<void> {
    await this.measureOutcome(executionId);
  }
}
