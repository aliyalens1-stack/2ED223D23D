import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { SmartMatchingService } from './smart-matching.service';
import { MatchingController } from './matching.controller';
import { MatchingLogSchema } from './matching-log.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { ServiceSchema } from '../services/service.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'MatchingLog', schema: MatchingLogSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Service', schema: ServiceSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [MatchingController],
  providers: [SmartMatchingService],
  exports: [SmartMatchingService],
})
export class MatchingModule {}
