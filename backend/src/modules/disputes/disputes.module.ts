import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { DisputeSchema } from './dispute.schema';
import { DisputeAuditSchema } from './dispute-audit.schema';
import { DisputesService } from './disputes.service';
import { DisputesController } from './disputes.controller';
import { DisputesAdminService } from './disputes-admin.service';
import { DisputesAdminController } from './disputes-admin.controller';
import { BookingSchema } from '../bookings/booking.schema';
import { PaymentSchema } from '../payments/payment.schema';
import { UserSchema } from '../users/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Dispute', schema: DisputeSchema },
      { name: 'DisputeAudit', schema: DisputeAuditSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Payment', schema: PaymentSchema },
      { name: 'User', schema: UserSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [DisputesController, DisputesAdminController],
  providers: [DisputesService, DisputesAdminService],
  exports: [DisputesService, DisputesAdminService],
})
export class DisputesModule {}
