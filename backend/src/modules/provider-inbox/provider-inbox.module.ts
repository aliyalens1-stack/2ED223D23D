import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProviderInboxService } from './provider-inbox.service';
import { ProviderInboxController } from './provider-inbox.controller';
import { AutoDistributionService } from './auto-distribution.service';
import { ExpireEngineService } from './expire-engine.service';
import { RequestDistributionSchema } from '../assignment/request-distribution.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BranchSchema } from '../branches/branch.schema';
import { ProviderServiceSchema } from '../provider-services/provider-service.schema';
import { AuthModule } from '../auth/auth.module';
import { AssignmentModule } from '../assignment/assignment.module';

@Module({
  imports: [
    AuthModule,
    forwardRef(() => AssignmentModule),
    MongooseModule.forFeature([
      { name: 'RequestDistribution', schema: RequestDistributionSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Branch', schema: BranchSchema },
      { name: 'ProviderService', schema: ProviderServiceSchema },
    ]),
  ],
  controllers: [ProviderInboxController],
  providers: [ProviderInboxService, AutoDistributionService, ExpireEngineService],
  exports: [ProviderInboxService, AutoDistributionService, ExpireEngineService],
})
export class ProviderInboxModule {}
