import { Schema } from 'mongoose';

/**
 * MarketplaceRule Schema - Configurable automation rules
 * 
 * Rules define: IF condition THEN action
 * Categories: demand, distribution, supply, provider
 * 
 * NOW WITH: Parameter ranges for auto-tuning
 */
export const MarketplaceRuleSchema = new Schema(
  {
    // Rule identification
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true },
    description: { type: String },
    
    // Rule category
    category: {
      type: String,
      enum: ['demand', 'distribution', 'supply', 'provider', 'pricing', 'visibility'],
      required: true,
    },
    
    // Priority (higher = runs first)
    priority: { type: Number, default: 0 },
    
    // Condition (JSON logic format)
    condition: {
      // Field to check
      field: { type: String, required: true }, // e.g., "zone.ratio", "provider.score"
      // Operator
      operator: { 
        type: String, 
        enum: ['gt', 'lt', 'gte', 'lte', 'eq', 'neq', 'in', 'between'],
        required: true 
      },
      // Value to compare
      value: { type: Schema.Types.Mixed, required: true },
      // Optional second value for 'between'
      value2: { type: Schema.Types.Mixed },
    },
    
    // Actions to execute when condition is true
    actions: [{
      type: {
        type: String,
        enum: [
          'set_surge',
          'set_distribution_size',
          'set_ttl',
          'set_visibility',
          'set_commission',
          'send_push',
          'expand_radius',
          'pull_supply',
          'boost_providers',
          'limit_providers',
          'log_alert',
        ],
        required: true,
      },
      // Action parameters
      params: { type: Schema.Types.Mixed },
      // 🔥 NEW: Parameter range for auto-tuning
      tunable: { type: Boolean, default: false },
      paramRange: {
        min: { type: Number },
        max: { type: Number },
        step: { type: Number, default: 0.1 },
      },
      // Current best parameter (learned)
      bestParam: { type: Schema.Types.Mixed },
    }],
    
    // Scope
    scope: {
      type: String,
      enum: ['global', 'zone', 'provider', 'city'],
      default: 'zone',
    },
    
    // Target zone IDs (if scope is 'zone')
    targetZoneIds: [{ type: Schema.Types.ObjectId, ref: 'GeoZone' }],
    
    // Cooldown (prevent rule from firing too often)
    cooldownSeconds: { type: Number, default: 60 },
    lastFiredAt: { type: Date },
    
    // Status
    isEnabled: { type: Boolean, default: true },
    
    // 🔥 NEW: Zone-level parameter overrides
    zoneOverrides: [{
      zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone' },
      zoneCode: { type: String },
      params: { type: Schema.Types.Mixed }, // Override parameters for this zone
    }],
    
    // 🔥 NEW: Learning metadata
    learning: {
      enabled: { type: Boolean, default: true },
      experimentMode: { type: Boolean, default: false },
      explorationRate: { type: Number, default: 0.2 }, // 20% exploration
      lastTunedAt: { type: Date },
    },
    
    // Metadata
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

MarketplaceRuleSchema.index({ category: 1, isEnabled: 1 });
MarketplaceRuleSchema.index({ priority: -1 });

/**
 * RuleExecution Schema - Log of rule executions
 * 
 * NOW WITH: Outcome tracking for feedback loop
 */
export const RuleExecutionSchema = new Schema(
  {
    ruleId: { type: Schema.Types.ObjectId, ref: 'MarketplaceRule', required: true, index: true },
    ruleCode: { type: String, required: true },
    
    // Context when rule fired
    context: {
      zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone' },
      zoneCode: { type: String },
      providerId: { type: Schema.Types.ObjectId, ref: 'Organization' },
      fieldValue: { type: Schema.Types.Mixed },
      conditionMet: { type: Boolean, default: true },
    },
    
    // Actions executed
    actionsExecuted: [{
      type: { type: String },
      params: { type: Schema.Types.Mixed },
      previousValue: { type: Schema.Types.Mixed },
      newValue: { type: Schema.Types.Mixed },
      success: { type: Boolean, default: true },
      error: { type: String },
    }],
    
    // Trigger
    trigger: {
      type: String,
      enum: ['auto', 'event', 'schedule', 'manual', 'experiment'],
      default: 'auto',
    },
    
    // Result
    success: { type: Boolean, default: true },
    duration: { type: Number }, // milliseconds
    
    // 🔥 NEW: KPIs BEFORE rule applied
    kpiBefore: {
      matchRate: { type: Number },       // % requests → bookings
      avgResponseTime: { type: Number }, // seconds
      avgETA: { type: Number },          // minutes
      cancelRate: { type: Number },      // %
      activeRequests: { type: Number },
      availableProviders: { type: Number },
      ratio: { type: Number },
      surgeMultiplier: { type: Number },
    },
    
    // 🔥 NEW: KPIs AFTER rule applied (measured after cooldown period)
    kpiAfter: {
      matchRate: { type: Number },
      avgResponseTime: { type: Number },
      avgETA: { type: Number },
      cancelRate: { type: Number },
      activeRequests: { type: Number },
      availableProviders: { type: Number },
      ratio: { type: Number },
      surgeMultiplier: { type: Number },
      measuredAt: { type: Date },
    },
    
    // 🔥 NEW: Calculated impact
    impact: {
      matchRateChange: { type: Number },    // +/- %
      responseTimeChange: { type: Number }, // +/- seconds
      etaChange: { type: Number },          // +/- minutes
      cancelRateChange: { type: Number },   // +/- %
      ratioChange: { type: Number },
      overallScore: { type: Number },       // Composite score -100 to +100
      isPositive: { type: Boolean },
    },
    
    // 🔥 NEW: Was this an experiment?
    experiment: {
      isExperiment: { type: Boolean, default: false },
      variant: { type: String },
      paramTested: { type: Schema.Types.Mixed },
    },
  },
  { timestamps: true }
);

RuleExecutionSchema.index({ ruleId: 1, createdAt: -1 });
RuleExecutionSchema.index({ 'context.zoneId': 1, createdAt: -1 });
RuleExecutionSchema.index({ 'impact.overallScore': -1 });

/**
 * 🔥 NEW: RulePerformance Schema - Aggregated rule effectiveness
 */
export const RulePerformanceSchema = new Schema(
  {
    ruleId: { type: Schema.Types.ObjectId, ref: 'MarketplaceRule', required: true },
    ruleCode: { type: String, required: true },
    
    // Time period
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    periodType: { 
      type: String, 
      enum: ['hourly', 'daily', 'weekly'],
      default: 'hourly'
    },
    
    // Execution stats
    totalExecutions: { type: Number, default: 0 },
    successfulExecutions: { type: Number, default: 0 },
    
    // Impact stats
    avgMatchRateChange: { type: Number, default: 0 },
    avgResponseTimeChange: { type: Number, default: 0 },
    avgETAChange: { type: Number, default: 0 },
    avgOverallScore: { type: Number, default: 0 },
    
    // Effectiveness rating
    effectivenessRating: {
      type: String,
      enum: ['excellent', 'good', 'neutral', 'poor', 'harmful'],
      default: 'neutral',
    },
    
    // Best parameters found
    bestParameters: { type: Schema.Types.Mixed },
    
    // Zone-specific performance
    zonePerformance: [{
      zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone' },
      zoneCode: { type: String },
      avgScore: { type: Number },
      executions: { type: Number },
      bestParam: { type: Schema.Types.Mixed },
    }],
  },
  { timestamps: true }
);

RulePerformanceSchema.index({ ruleId: 1, periodStart: -1 });
RulePerformanceSchema.index({ ruleCode: 1, periodType: 1 });

/**
 * 🔥 NEW: MarketKPI Schema - System-wide KPI tracking
 */
export const MarketKPISchema = new Schema(
  {
    // Time
    timestamp: { type: Date, required: true, index: true },
    periodType: {
      type: String,
      enum: ['minute', 'hourly', 'daily'],
      default: 'minute',
    },
    
    // Scope
    scope: {
      type: String,
      enum: ['global', 'city', 'zone'],
      default: 'global',
    },
    zoneId: { type: Schema.Types.ObjectId, ref: 'GeoZone', index: true },
    zoneCode: { type: String },
    cityId: { type: Schema.Types.ObjectId },
    
    // Core KPIs
    matchRate: { type: Number, default: 0 },         // requests → bookings %
    avgResponseTime: { type: Number, default: 0 },   // seconds
    avgETA: { type: Number, default: 0 },            // minutes
    cancelRate: { type: Number, default: 0 },        // %
    completionRate: { type: Number, default: 0 },    // %
    
    // Volume
    totalRequests: { type: Number, default: 0 },
    totalBookings: { type: Number, default: 0 },
    totalCompleted: { type: Number, default: 0 },
    totalCancelled: { type: Number, default: 0 },
    
    // Supply/Demand
    avgRatio: { type: Number, default: 0 },
    avgSurge: { type: Number, default: 1.0 },
    avgOnlineProviders: { type: Number, default: 0 },
    
    // Revenue (if tracked)
    totalRevenue: { type: Number, default: 0 },
    avgRevenuePerRequest: { type: Number, default: 0 },
    
    // System health
    autoModeActive: { type: Boolean, default: true },
    rulesExecuted: { type: Number, default: 0 },
    systemHealth: { type: Number, default: 100 }, // 0-100
  },
  { timestamps: true }
);

MarketKPISchema.index({ timestamp: -1, periodType: 1 });
MarketKPISchema.index({ zoneId: 1, timestamp: -1 });

/**
 * 🔥 NEW: Experiment Schema - A/B testing for parameters
 */
export const ExperimentSchema = new Schema(
  {
    name: { type: String, required: true },
    ruleId: { type: Schema.Types.ObjectId, ref: 'MarketplaceRule', required: true },
    ruleCode: { type: String, required: true },
    
    // What we're testing
    parameter: { type: String, required: true }, // e.g., "surge", "distribution_size"
    
    // Variants
    variants: [{
      id: { type: String, required: true }, // e.g., "A", "B", "C"
      value: { type: Schema.Types.Mixed, required: true },
      weight: { type: Number, default: 1 }, // Traffic allocation weight
    }],
    
    // Results per variant
    results: [{
      variantId: { type: String },
      executions: { type: Number, default: 0 },
      avgMatchRateChange: { type: Number, default: 0 },
      avgScoreChange: { type: Number, default: 0 },
      confidence: { type: Number, default: 0 }, // Statistical confidence %
    }],
    
    // Status
    status: {
      type: String,
      enum: ['draft', 'running', 'paused', 'completed', 'winner_selected'],
      default: 'draft',
    },
    
    // Winner
    winningVariant: { type: String },
    appliedToProduction: { type: Boolean, default: false },
    
    // Timeline
    startedAt: { type: Date },
    endedAt: { type: Date },
    minSampleSize: { type: Number, default: 100 },
    minConfidence: { type: Number, default: 95 },
    
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

ExperimentSchema.index({ ruleId: 1, status: 1 });

/**
 * MarketplaceConfig Schema - Global marketplace settings
 */
export const MarketplaceConfigSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String },
    category: {
      type: String,
      enum: ['auto_mode', 'surge', 'distribution', 'visibility', 'commission', 'push', 'learning'],
      default: 'auto_mode',
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
