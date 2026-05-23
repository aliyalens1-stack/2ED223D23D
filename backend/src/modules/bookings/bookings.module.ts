import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { BookingSchema } from './booking.schema';
import { AuditSchema } from '../audit/audit.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BookingSlotSchema } from '../slots/booking-slot.schema';
import { BranchSchema } from '../branches/branch.schema';
import { ProviderLiveLocationSchema } from './provider-live-location.schema';
import { BookingsService } from './bookings.service';
import { BookingsController } from './bookings.controller';
import { CurrentJobService } from './current-job.service';
import { CurrentJobController } from './current-job.controller';
import { LiveMovementService } from './live-movement.service';
import { LiveMovementController } from './live-movement.controller';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Booking', schema: BookingSchema },
      { name: 'Audit', schema: AuditSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'BookingSlot', schema: BookingSlotSchema },
      { name: 'Branch', schema: BranchSchema },
      { name: 'ProviderLiveLocation', schema: ProviderLiveLocationSchema },
    ]),
    JwtModule.register({}),
    OrganizationsModule,
  ],
  controllers: [BookingsController, CurrentJobController, LiveMovementController],
  providers: [BookingsService, CurrentJobService, LiveMovementService],
  exports: [BookingsService, CurrentJobService, LiveMovementService],
})
export class BookingsModule {}
