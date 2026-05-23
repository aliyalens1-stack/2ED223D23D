import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { PaymentSchema } from './payment.schema';
import { PaymentTransactionSchema } from './payment-transaction.schema';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { StripeService } from './stripe.service';
import { BookingSchema } from '../bookings/booking.schema';
import { UserSchema } from '../users/user.schema';
// 🔥 Commission Engine
import { CommissionEngineService } from './commission-engine.service';
import { CommissionLogSchema } from './commission-log.schema';
import { OrganizationSchema } from '../organizations/organization.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Payment', schema: PaymentSchema },
      { name: 'PaymentTransaction', schema: PaymentTransactionSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'User', schema: UserSchema },
      // 🔥 For Commission Engine
      { name: 'CommissionLog', schema: CommissionLogSchema },
      { name: 'Organization', schema: OrganizationSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService, 
    StripeService,
    // 🔥 Commission Engine
    CommissionEngineService,
  ],
  exports: [PaymentsService, StripeService, CommissionEngineService],
})
export class PaymentsModule {}
