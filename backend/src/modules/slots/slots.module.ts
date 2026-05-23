import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ProviderAvailabilitySchema } from './provider-availability.schema';
import { ProviderBlockedTimeSchema } from './provider-blocked-time.schema';
import { BookingSlotSchema } from './booking-slot.schema';
import { ServiceDurationRuleSchema } from './service-duration-rule.schema';
import { ProviderServiceSchema } from '../provider-services/provider-service.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { BranchSchema } from '../branches/branch.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { UserSchema } from '../users/user.schema';
import { SlotsService } from './slots.service';
import { SlotsController } from './slots.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'ProviderAvailability', schema: ProviderAvailabilitySchema },
      { name: 'ProviderBlockedTime', schema: ProviderBlockedTimeSchema },
      { name: 'BookingSlot', schema: BookingSlotSchema },
      { name: 'ServiceDurationRule', schema: ServiceDurationRuleSchema },
      { name: 'ProviderService', schema: ProviderServiceSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Branch', schema: BranchSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'User', schema: UserSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [SlotsController],
  providers: [SlotsService],
  exports: [SlotsService],
})
export class SlotsModule {}
