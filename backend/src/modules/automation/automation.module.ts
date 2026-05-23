import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { ExecutionEngineService } from './execution-engine.service';
import {
  AutoActionRuleSchema, ActionChainSchema, ActionExecutionSchema,
  ChainExecutionSchema, AutomationConfigSchema, AutomationFeedbackSchema,
  FailsafeRuleSchema, FailsafeIncidentSchema, MarketStateSnapshotSchema, ReplaySessionSchema,
} from './schemas/automation.schemas';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'AutoActionRule', schema: AutoActionRuleSchema },
      { name: 'ActionChain', schema: ActionChainSchema },
      { name: 'ActionExecution', schema: ActionExecutionSchema },
      { name: 'ChainExecution', schema: ChainExecutionSchema },
      { name: 'AutomationConfig', schema: AutomationConfigSchema },
      { name: 'AutomationFeedback', schema: AutomationFeedbackSchema },
      { name: 'FailsafeRule', schema: FailsafeRuleSchema },
      { name: 'FailsafeIncident', schema: FailsafeIncidentSchema },
      { name: 'MarketStateSnapshot', schema: MarketStateSnapshotSchema },
      { name: 'ReplaySession', schema: ReplaySessionSchema },
    ]),
  ],
  controllers: [AutomationController],
  providers: [AutomationService, ExecutionEngineService],
  exports: [AutomationService, ExecutionEngineService],
})
export class AutomationModule {}
