import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ timestamps: true, collection: 'auto_action_rules' })
export class AutoActionRule extends Document {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ default: true }) isEnabled: boolean;
  @Prop({ default: 'active' }) mode: string;
  @Prop({ default: 'zone' }) triggerType: string;
  @Prop({ type: Object, default: {} }) conditionJson: Record<string, any>;
  @Prop({ default: 'set_surge' }) actionType: string;
  @Prop({ type: Object, default: {} }) actionPayload: Record<string, any>;
  @Prop({ default: 300 }) cooldownSeconds: number;
  @Prop({ default: 5 }) priority: number;
}
export const AutoActionRuleSchema = SchemaFactory.createForClass(AutoActionRule);

@Schema({ timestamps: true, collection: 'action_chains' })
export class ActionChain extends Document {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop({ default: true }) isEnabled: boolean;
  @Prop({ default: 'zone_state' }) triggerType: string;
  @Prop({ type: Object, default: {} }) triggerConditionJson: Record<string, any>;
  @Prop({ type: [Object], default: [] }) steps: Array<{ order: number; actionType: string; payload: Record<string, any>; delaySeconds: number }>;
}
export const ActionChainSchema = SchemaFactory.createForClass(ActionChain);

@Schema({ timestamps: true, collection: 'auto_action_executions' })
export class ActionExecution extends Document {
  @Prop({ required: true }) id: string;
  @Prop() ruleId: string;
  @Prop() ruleName: string;
  @Prop() entityType: string;
  @Prop() entityId: string;
  @Prop({ type: Object }) triggerSnapshot: Record<string, any>;
  @Prop() actionType: string;
  @Prop({ type: Object }) actionPayload: Record<string, any>;
  @Prop({ default: 'executed' }) status: string;
  @Prop({ default: false }) isDryRun: boolean;
  @Prop({ default: false }) isShadow: boolean;
  @Prop({ default: 0 }) affectedEntities: number;
  @Prop({ type: Object }) metricsAfter: Record<string, any>;
  @Prop({ default: 0 }) cost: number;
  @Prop({ default: 0 }) revenueImpact: number;
  @Prop() createdAt: string;
}
export const ActionExecutionSchema = SchemaFactory.createForClass(ActionExecution);

@Schema({ timestamps: true, collection: 'action_chain_executions' })
export class ChainExecution extends Document {
  @Prop({ required: true }) id: string;
  @Prop() chainId: string;
  @Prop({ default: 'completed' }) status: string;
  @Prop({ default: false }) isDryRun: boolean;
  @Prop({ type: [Object], default: [] }) stepsResults: Array<Record<string, any>>;
  @Prop() createdAt: string;
}
export const ChainExecutionSchema = SchemaFactory.createForClass(ChainExecution);

@Schema({ timestamps: true, collection: 'automation_config' })
export class AutomationConfig extends Document {
  @Prop({ default: 'global' }) type: string;
  @Prop({ default: true }) autoDistribution: boolean;
  @Prop({ default: true }) autoSurge: boolean;
  @Prop({ default: true }) autoVisibility: boolean;
  @Prop({ default: true }) autoNotifications: boolean;
  @Prop({ default: false }) autoChains: boolean;
  @Prop({ default: false }) dryRunMode: boolean;
  @Prop({ default: true }) requireOperatorApprovalForCritical: boolean;
  @Prop() updatedAt: string;
}
export const AutomationConfigSchema = SchemaFactory.createForClass(AutomationConfig);

@Schema({ timestamps: true, collection: 'failsafe_rules' })
export class FailsafeRule extends Document {
  @Prop({ required: true }) id: string;
  @Prop({ required: true }) name: string;
  @Prop() metric: string;
  @Prop() condition: string;
  @Prop() rollbackActionType: string;
  @Prop({ type: Object, default: {} }) rollbackPayload: Record<string, any>;
  @Prop({ default: true }) isEnabled: boolean;
}
export const FailsafeRuleSchema = SchemaFactory.createForClass(FailsafeRule);

@Schema({ timestamps: true, collection: 'failsafe_incidents' })
export class FailsafeIncident extends Document {
  @Prop({ required: true }) id: string;
  @Prop() ruleId: string;
  @Prop() ruleName: string;
  @Prop() detectedAt: string;
  @Prop() affectedEntityType: string;
  @Prop() affectedEntityId: string;
  @Prop({ type: Object }) metricSnapshot: Record<string, any>;
  @Prop() actionTaken: string;
  @Prop({ default: 'open' }) status: string;
  @Prop() resolvedAt: string;
}
export const FailsafeIncidentSchema = SchemaFactory.createForClass(FailsafeIncident);

@Schema({ timestamps: true, collection: 'automation_feedback' })
export class AutomationFeedback extends Document {
  @Prop({ required: true }) id: string;
  @Prop() ruleId: string;
  @Prop() executionId: string;
  @Prop({ type: Object }) metricBefore: Record<string, any>;
  @Prop({ type: Object }) metricAfter: Record<string, any>;
  @Prop() impactType: string;
  @Prop({ default: 0 }) impactScore: number;
  @Prop() createdAt: string;
}
export const AutomationFeedbackSchema = SchemaFactory.createForClass(AutomationFeedback);

@Schema({ timestamps: true, collection: 'market_state_snapshots' })
export class MarketStateSnapshot extends Document {
  @Prop({ required: true }) id: string;
  @Prop({ default: 'global' }) scopeType: string;
  @Prop({ default: 'all' }) scopeId: string;
  @Prop() zoneName: string;
  @Prop({ default: 0 }) demandCount: number;
  @Prop({ default: 0 }) supplyCount: number;
  @Prop({ default: 1.0 }) ratio: number;
  @Prop({ default: 0 }) avgEtaMinutes: number;
  @Prop({ default: 0 }) avgResponseSeconds: number;
  @Prop({ default: 0 }) conversionRate: number;
  @Prop({ default: 'balanced' }) state: string;
  @Prop({ default: false }) syncedFromZones: boolean;
  @Prop() zonesCount: number;
  @Prop() createdAt: string;
}
export const MarketStateSnapshotSchema = SchemaFactory.createForClass(MarketStateSnapshot);

@Schema({ timestamps: true, collection: 'replay_sessions' })
export class ReplaySession extends Document {
  @Prop({ required: true }) id: string;
  @Prop() timeRangeHours: number;
  @Prop() snapshotsAnalyzed: number;
  @Prop({ type: Object }) rulesetA: Record<string, any>;
  @Prop({ type: Object }) rulesetB: Record<string, any>;
  @Prop({ type: Object }) comparison: Record<string, any>;
  @Prop() winner: string;
  @Prop({ type: [String] }) rulesetAIds: string[];
  @Prop({ type: Object }) rulesetBMods: Record<string, any>;
  @Prop() createdAt: string;
}
export const ReplaySessionSchema = SchemaFactory.createForClass(ReplaySession);
