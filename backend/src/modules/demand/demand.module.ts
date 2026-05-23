import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { DemandEngineService } from './demand-engine.service';
import { DemandController } from './demand.controller';
import { DemandMetricsSchema } from './demand-metrics.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { ProviderLiveLocationSchema } from '../bookings/provider-live-location.schema';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: 'DemandMetrics', schema: DemandMetricsSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'ProviderLiveLocation', schema: ProviderLiveLocationSchema },
    ]),
    JwtModule.register({}),
  ],
  controllers: [DemandController],
  providers: [DemandEngineService],
  exports: [DemandEngineService],
})
export class DemandModule {}
