import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MarketplaceRulesController } from './marketplace-rules.controller';
import { MarketplaceRulesEngine } from './marketplace-rules-engine.service';
import { LearningEngineService } from './learning-engine.service';
import { 
  MarketplaceRuleSchema, 
  RuleExecutionSchema, 
  MarketplaceConfigSchema,
  RulePerformanceSchema,
  MarketKPISchema,
  ExperimentSchema,
} from './marketplace-rules.schema';
import { GeoZoneSchema, ZoneMetricsSchema } from '../zones/zone.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'MarketplaceRule', schema: MarketplaceRuleSchema },
      { name: 'RuleExecution', schema: RuleExecutionSchema },
      { name: 'MarketplaceConfig', schema: MarketplaceConfigSchema },
      { name: 'RulePerformance', schema: RulePerformanceSchema },
      { name: 'MarketKPI', schema: MarketKPISchema },
      { name: 'Experiment', schema: ExperimentSchema },
      { name: 'GeoZone', schema: GeoZoneSchema },
      { name: 'ZoneMetrics', schema: ZoneMetricsSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Quote', schema: QuoteSchema },
    ]),
    NotificationsModule,
    AuthModule,
  ],
  controllers: [MarketplaceRulesController],
  providers: [MarketplaceRulesEngine, LearningEngineService],
  exports: [MarketplaceRulesEngine, LearningEngineService],
})
export class MarketplaceRulesModule {}
