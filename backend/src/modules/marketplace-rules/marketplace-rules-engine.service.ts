import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel, InjectConnection } from '@nestjs/mongoose';
import { Model, Connection, Types } from 'mongoose';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * MarketplaceRulesEngine - Self-Balancing Marketplace System
 * 
 * The brain that automates marketplace management:
 * - Evaluates rules against current state
 * - Executes actions when conditions are met
 * - Logs all decisions for transparency
 * 
 * Pipeline: events → metrics → rules → actions → state update
 * 
 * Rule Categories:
 * - DEMAND: surge pricing based on ratio
 * - DISTRIBUTION: distribution size based on demand
 * - SUPPLY: activate offline providers
 * - PROVIDER: visibility based on performance
 * - PRICING: dynamic commission
 */
@Injectable()
export class MarketplaceRulesEngine implements OnModuleInit {
  private readonly logger = new Logger(MarketplaceRulesEngine.name);
  private readonly TICK_INTERVAL_MS = 5000; // 5 seconds
  private intervalHandle: NodeJS.Timeout | null = null;
  
  // Auto mode flag (can be toggled by admin)
  private autoModeEnabled: boolean = true;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('MarketplaceRule') private readonly ruleModel: Model<any>,
    @InjectModel('RuleExecution') private readonly executionModel: Model<any>,
    @InjectModel('MarketplaceConfig') private readonly configModel: Model<any>,
    @InjectModel('GeoZone') private readonly zoneModel: Model<any>,
    @InjectModel('ZoneMetrics') private readonly zoneMetricsModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    private readonly eventBus: EventBus,
  ) {}

  async onModuleInit() {
    await this.loadConfig();
    await this.seedDefaultRules();
    this.startEngine();
    this.subscribeToEvents();
    this.logger.log('🤖 Marketplace Rules Engine started (auto-balancing active)');
  }

  /**
   * Load configuration from database
   */
  private async loadConfig() {
    const autoMode = await this.configModel.findOne({ key: 'auto_mode_enabled' }).lean() as any;
    this.autoModeEnabled = autoMode?.value !== false;
    this.logger.log(`Auto mode: ${this.autoModeEnabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Subscribe to marketplace events
   */
  private subscribeToEvents() {
    // Listen for zone state changes
    this.eventBus.on('ZONE_STATE_CHANGED' as PlatformEvent, async (data: any) => {
      if (this.autoModeEnabled) {
        await this.evaluateZoneRules(data.zoneId, 'event');
      }
    });

    // Listen for new requests
    this.eventBus.on('QUOTE_CREATED' as PlatformEvent, async (data: any) => {
      if (this.autoModeEnabled && data.zoneId) {
        await this.evaluateZoneRules(data.zoneId, 'event');
      }
    });
  }

  /**
   * Start the rules engine tick
   */
  private startEngine() {
    // Initial evaluation
    this.tick().catch(err => this.logger.error('Initial tick error:', err));

    this.intervalHandle = setInterval(() => {
      if (this.autoModeEnabled) {
        this.tick().catch(err => this.logger.error('Tick error:', err));
      }
    }, this.TICK_INTERVAL_MS);
  }

  /**
   * Main tick - evaluate all zone rules
   */
  private async tick() {
    const zones = await this.zoneModel.find({ status: 'active' }).lean() as any[];
    
    for (const zone of zones) {
      await this.evaluateZoneRules(String(zone._id), 'auto');
    }

    // Also evaluate global provider rules
    await this.evaluateProviderRules();
  }

  /**
   * Evaluate rules for a specific zone
   */
  async evaluateZoneRules(zoneId: string, trigger: string = 'auto'): Promise<void> {
    const startTime = Date.now();
    
    // Get zone metrics
    const metrics = await this.zoneMetricsModel.findOne({ 
      zoneId: new Types.ObjectId(zoneId) 
    }).lean() as any;
    
    if (!metrics) return;

    // Get enabled rules for zones
    const rules = await this.ruleModel.find({
      isEnabled: true,
      scope: { $in: ['zone', 'global'] },
      $or: [
        { targetZoneIds: { $size: 0 } },
        { targetZoneIds: { $exists: false } },
        { targetZoneIds: new Types.ObjectId(zoneId) },
      ],
    }).sort({ priority: -1 }).lean() as any[];

    for (const rule of rules) {
      // Check cooldown
      if (rule.lastFiredAt) {
        const cooldownMs = (rule.cooldownSeconds || 60) * 1000;
        if (Date.now() - new Date(rule.lastFiredAt).getTime() < cooldownMs) {
          continue;
        }
      }

      // Evaluate condition
      const fieldValue = this.getFieldValue(rule.condition.field, { zone: metrics, metrics });
      const conditionMet = this.evaluateCondition(rule.condition, fieldValue);

      if (conditionMet) {
        await this.executeActions(rule, {
          zoneId,
          zoneCode: metrics.zoneCode,
          fieldValue,
          trigger,
        });
      }
    }
  }

  /**
   * Evaluate provider-level rules
   */
  async evaluateProviderRules(): Promise<void> {
    // Get enabled provider rules
    const rules = await this.ruleModel.find({
      isEnabled: true,
      scope: 'provider',
    }).sort({ priority: -1 }).lean() as any[];

    if (rules.length === 0) return;

    // Get all active providers
    const providers = await this.organizationModel.find({
      status: 'active',
    }).lean() as any[];

    for (const provider of providers) {
      for (const rule of rules) {
        const fieldValue = this.getFieldValue(rule.condition.field, { provider });
        const conditionMet = this.evaluateCondition(rule.condition, fieldValue);

        if (conditionMet) {
          await this.executeActions(rule, {
            providerId: String(provider._id),
            providerName: provider.name,
            fieldValue,
            trigger: 'auto',
          });
        }
      }
    }
  }

  /**
   * Get field value from context
   */
  private getFieldValue(field: string, context: any): any {
    const parts = field.split('.');
    let value = context;
    
    for (const part of parts) {
      if (value === undefined || value === null) return undefined;
      value = value[part];
    }
    
    return value;
  }

  /**
   * Evaluate a condition
   */
  private evaluateCondition(condition: any, fieldValue: any): boolean {
    const { operator, value, value2 } = condition;
    
    if (fieldValue === undefined || fieldValue === null) return false;

    switch (operator) {
      case 'gt': return fieldValue > value;
      case 'lt': return fieldValue < value;
      case 'gte': return fieldValue >= value;
      case 'lte': return fieldValue <= value;
      case 'eq': return fieldValue === value;
      case 'neq': return fieldValue !== value;
      case 'in': return Array.isArray(value) && value.includes(fieldValue);
      case 'between': return fieldValue >= value && fieldValue <= value2;
      default: return false;
    }
  }

  /**
   * Execute actions for a rule
   * Now with Learning Engine integration for feedback loop
   */
  private async executeActions(rule: any, context: any): Promise<void> {
    const actionsExecuted: any[] = [];
    const startTime = Date.now();

    for (const action of rule.actions) {
      try {
        const result = await this.executeAction(action, context);
        actionsExecuted.push({
          type: action.type,
          params: action.params,
          ...result,
          success: true,
        });
      } catch (err: any) {
        actionsExecuted.push({
          type: action.type,
          params: action.params,
          success: false,
          error: err.message,
        });
      }
    }

    // Log execution with placeholder for KPIs (Learning Engine will fill these)
    const execution = await this.executionModel.create({
      ruleId: rule._id,
      ruleCode: rule.code,
      context,
      actionsExecuted,
      trigger: context.trigger,
      success: actionsExecuted.every(a => a.success),
      duration: Date.now() - startTime,
    });

    // Update last fired
    await this.ruleModel.updateOne(
      { _id: rule._id },
      { $set: { lastFiredAt: new Date() } }
    );

    this.logger.log(`[Rule ${rule.code}] Fired for ${context.zoneCode || context.providerId}`);

    // 🧠 Emit event for Learning Engine to track KPIs
    await this.eventBus.emit('RULE_EXECUTED' as PlatformEvent, {
      executionId: String(execution._id),
      ruleId: String(rule._id),
      ruleCode: rule.code,
      zoneId: context.zoneId,
      trigger: context.trigger,
    });
  }

  /**
   * Execute a single action
   */
  private async executeAction(action: any, context: any): Promise<{ previousValue?: any; newValue?: any }> {
    const { type, params } = action;

    switch (type) {
      case 'set_surge': {
        const zone = await this.zoneModel.findById(context.zoneId);
        const previousValue = zone?.config?.baseSurge || 1.0;
        const newValue = Math.min(params.value || 1.5, params.max || 2.5);
        
        await this.zoneModel.updateOne(
          { _id: context.zoneId },
          { $set: { 'config.baseSurge': newValue } }
        );
        
        await this.eventBus.emit('SURGE_UPDATED' as PlatformEvent, {
          zoneId: context.zoneId,
          previousValue,
          newValue,
          reason: 'auto_rule',
        });
        
        return { previousValue, newValue };
      }

      case 'set_distribution_size': {
        // Update distribution config
        const newValue = Math.min(params.value || 5, params.max || 7);
        await this.configModel.findOneAndUpdate(
          { key: `distribution_size_${context.zoneId}` },
          { $set: { value: newValue, category: 'distribution' } },
          { upsert: true }
        );
        return { newValue };
      }

      case 'set_ttl': {
        // Update TTL config
        const newValue = Math.max(params.value || 30, params.min || 15);
        await this.configModel.findOneAndUpdate(
          { key: `ttl_${context.zoneId}` },
          { $set: { value: newValue, category: 'distribution' } },
          { upsert: true }
        );
        return { newValue };
      }

      case 'set_visibility': {
        if (context.providerId) {
          const provider = await this.organizationModel.findById(context.providerId);
          const previousValue = provider?.visibilityState || 'normal';
          const newValue = params.state || 'limited';
          
          await this.organizationModel.updateOne(
            { _id: context.providerId },
            { $set: { visibilityState: newValue } }
          );
          
          return { previousValue, newValue };
        }
        return {};
      }

      case 'set_commission': {
        if (context.providerId) {
          const provider = await this.organizationModel.findById(context.providerId);
          const previousValue = provider?.commissionOverride;
          const newValue = params.rate;
          
          await this.organizationModel.updateOne(
            { _id: context.providerId },
            { $set: { commissionOverride: newValue } }
          );
          
          return { previousValue, newValue };
        }
        return {};
      }

      case 'send_push': {
        await this.eventBus.emit('SEND_PUSH_NOTIFICATION' as PlatformEvent, {
          zoneId: context.zoneId,
          message: params.message || 'High demand in your area!',
          targetType: params.targetType || 'offline_providers',
        });
        return { newValue: params.message };
      }

      case 'expand_radius': {
        const zone = await this.zoneModel.findById(context.zoneId);
        const previousValue = zone?.radiusKm || 3;
        const newValue = previousValue * (params.factor || 1.5);
        
        await this.zoneModel.updateOne(
          { _id: context.zoneId },
          { $set: { radiusKm: Math.min(newValue, params.max || 10) } }
        );
        
        return { previousValue, newValue };
      }

      case 'boost_providers': {
        // Boost all providers in zone
        const result = await this.organizationModel.updateMany(
          { status: 'active', isOnline: true },
          { $set: { visibilityState: 'boosted' } }
        );
        return { newValue: `${result.modifiedCount} providers boosted` };
      }

      case 'limit_providers': {
        // Limit low-performing providers
        const result = await this.organizationModel.updateMany(
          { behavioralScore: { $lt: params.threshold || 30 } },
          { $set: { visibilityState: 'limited' } }
        );
        return { newValue: `${result.modifiedCount} providers limited` };
      }

      case 'log_alert': {
        this.logger.warn(`[ALERT] ${params.message} | Zone: ${context.zoneCode}`);
        await this.eventBus.emit('MARKETPLACE_ALERT' as PlatformEvent, {
          zoneId: context.zoneId,
          message: params.message,
          severity: params.severity || 'warning',
        });
        return { newValue: params.message };
      }

      default:
        throw new Error(`Unknown action type: ${type}`);
    }
  }

  /**
   * Seed default rules if none exist
   */
  private async seedDefaultRules() {
    const count = await this.ruleModel.countDocuments();
    if (count > 0) return;

    const defaultRules = [
      // DEMAND RULES
      {
        name: 'Surge on High Demand',
        code: 'surge_high_demand',
        description: 'Increase surge multiplier when ratio > 2',
        category: 'demand',
        priority: 100,
        condition: { field: 'zone.ratio', operator: 'gt', value: 2 },
        actions: [
          { type: 'set_surge', params: { value: 1.5, max: 2.5 } },
          { type: 'log_alert', params: { message: 'High demand - surge activated', severity: 'info' } },
        ],
        scope: 'zone',
        cooldownSeconds: 60,
        isEnabled: true,
      },
      {
        name: 'Critical Demand Response',
        code: 'critical_demand',
        description: 'Maximum response when ratio > 3',
        category: 'demand',
        priority: 200,
        condition: { field: 'zone.ratio', operator: 'gt', value: 3 },
        actions: [
          { type: 'set_surge', params: { value: 2.0, max: 2.5 } },
          { type: 'set_distribution_size', params: { value: 7, max: 7 } },
          { type: 'set_ttl', params: { value: 15, min: 10 } },
          { type: 'send_push', params: { message: 'Critical demand! Go online now!', targetType: 'offline_providers' } },
        ],
        scope: 'zone',
        cooldownSeconds: 120,
        isEnabled: true,
      },
      {
        name: 'Reset Surge on Balance',
        code: 'reset_surge_balanced',
        description: 'Reset surge when market is balanced',
        category: 'demand',
        priority: 50,
        condition: { field: 'zone.ratio', operator: 'lt', value: 1 },
        actions: [
          { type: 'set_surge', params: { value: 1.0, max: 2.5 } },
        ],
        scope: 'zone',
        cooldownSeconds: 120,
        isEnabled: true,
      },

      // DISTRIBUTION RULES
      {
        name: 'Expand Distribution on Busy',
        code: 'expand_distribution_busy',
        description: 'Increase distribution size when busy',
        category: 'distribution',
        priority: 80,
        condition: { field: 'zone.ratio', operator: 'gt', value: 1.5 },
        actions: [
          { type: 'set_distribution_size', params: { value: 5, max: 7 } },
        ],
        scope: 'zone',
        cooldownSeconds: 60,
        isEnabled: true,
      },

      // SUPPLY RULES
      {
        name: 'Activate Supply on Surge',
        code: 'activate_supply_surge',
        description: 'Push offline providers when surge is active',
        category: 'supply',
        priority: 90,
        condition: { field: 'zone.state', operator: 'eq', value: 'surge' },
        actions: [
          { type: 'send_push', params: { message: 'High demand in your area! Surge pricing active.', targetType: 'offline_providers' } },
        ],
        scope: 'zone',
        cooldownSeconds: 300, // 5 minutes
        isEnabled: true,
      },

      // PROVIDER RULES
      {
        name: 'Limit Low Performers',
        code: 'limit_low_performers',
        description: 'Reduce visibility for providers with low score',
        category: 'provider',
        priority: 70,
        condition: { field: 'provider.behavioralScore', operator: 'lt', value: 30 },
        actions: [
          { type: 'set_visibility', params: { state: 'limited' } },
        ],
        scope: 'provider',
        cooldownSeconds: 3600, // 1 hour
        isEnabled: true,
      },
      {
        name: 'Boost Top Performers',
        code: 'boost_top_performers',
        description: 'Increase visibility for high-performing providers',
        category: 'provider',
        priority: 60,
        condition: { field: 'provider.behavioralScore', operator: 'gt', value: 80 },
        actions: [
          { type: 'set_visibility', params: { state: 'boosted' } },
        ],
        scope: 'provider',
        cooldownSeconds: 3600, // 1 hour
        isEnabled: true,
      },
      {
        name: 'Reduce Commission for Top Performers',
        code: 'reduce_commission_top',
        description: 'Lower commission for high performers',
        category: 'provider',
        priority: 55,
        condition: { field: 'provider.behavioralScore', operator: 'gt', value: 85 },
        actions: [
          { type: 'set_commission', params: { rate: 8 } },
        ],
        scope: 'provider',
        cooldownSeconds: 86400, // 24 hours
        isEnabled: true,
      },
    ];

    await this.ruleModel.insertMany(defaultRules);
    this.logger.log(`Seeded ${defaultRules.length} default marketplace rules`);
  }

  // ========== PUBLIC API ==========

  /**
   * Get all rules
   */
  async getAllRules(): Promise<any[]> {
    return this.ruleModel.find().sort({ category: 1, priority: -1 }).lean();
  }

  /**
   * Get rule by ID
   */
  async getRuleById(id: string): Promise<any> {
    return this.ruleModel.findById(id).lean();
  }

  /**
   * Create a new rule
   */
  async createRule(data: any): Promise<any> {
    return this.ruleModel.create(data);
  }

  /**
   * Update a rule
   */
  async updateRule(id: string, data: any): Promise<any> {
    return this.ruleModel.findByIdAndUpdate(id, { $set: data }, { new: true });
  }

  /**
   * Toggle rule enabled status
   */
  async toggleRule(id: string): Promise<any> {
    const rule = await this.ruleModel.findById(id);
    if (!rule) throw new Error('Rule not found');
    
    rule.isEnabled = !rule.isEnabled;
    await rule.save();
    return rule;
  }

  /**
   * Delete a rule
   */
  async deleteRule(id: string): Promise<void> {
    await this.ruleModel.findByIdAndDelete(id);
  }

  /**
   * Get rule executions (audit log)
   */
  async getExecutions(params: { ruleId?: string; zoneId?: string; limit?: number }): Promise<any[]> {
    const filter: any = {};
    if (params.ruleId) filter.ruleId = new Types.ObjectId(params.ruleId);
    if (params.zoneId) filter['context.zoneId'] = new Types.ObjectId(params.zoneId);
    
    return this.executionModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(params.limit || 50)
      .lean();
  }

  /**
   * Get/set auto mode
   */
  async getAutoMode(): Promise<boolean> {
    return this.autoModeEnabled;
  }

  async setAutoMode(enabled: boolean): Promise<void> {
    this.autoModeEnabled = enabled;
    await this.configModel.findOneAndUpdate(
      { key: 'auto_mode_enabled' },
      { $set: { value: enabled, category: 'auto_mode' } },
      { upsert: true }
    );
    this.logger.warn(`Auto mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  /**
   * Get marketplace stats
   */
  async getStats(): Promise<any> {
    const totalRules = await this.ruleModel.countDocuments();
    const enabledRules = await this.ruleModel.countDocuments({ isEnabled: true });
    const recentExecutions = await this.executionModel.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) }, // Last hour
    });
    const successfulExecutions = await this.executionModel.countDocuments({
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
      success: true,
    });

    return {
      autoModeEnabled: this.autoModeEnabled,
      totalRules,
      enabledRules,
      executionsLastHour: recentExecutions,
      successRate: recentExecutions > 0 
        ? Math.round((successfulExecutions / recentExecutions) * 100) 
        : 100,
    };
  }

  /**
   * Manual trigger for testing
   */
  async manualTrigger(zoneId: string): Promise<void> {
    await this.evaluateZoneRules(zoneId, 'manual');
  }
}
