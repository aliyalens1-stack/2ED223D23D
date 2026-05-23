import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AssignmentService } from './assignment.service';
import { AssignmentController } from './assignment.controller';
import { RequestDistributionSchema } from './request-distribution.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BranchSchema } from '../branches/branch.schema';
import { ProviderServiceSchema } from '../provider-services/provider-service.schema';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule, // Import to get JwtService
    MongooseModule.forFeature([
      { name: 'RequestDistribution', schema: RequestDistributionSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Branch', schema: BranchSchema },
      { name: 'ProviderService', schema: ProviderServiceSchema },
    ]),
  ],
  controllers: [AssignmentController],
  providers: [AssignmentService],
  exports: [AssignmentService, MongooseModule],
})
export class AssignmentModule {}
