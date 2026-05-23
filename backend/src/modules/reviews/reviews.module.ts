import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ReviewSchema } from './review.schema';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { BookingSchema } from '../bookings/booking.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { UserSchema } from '../users/user.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Review', schema: ReviewSchema },
      { name: 'Booking', schema: BookingSchema },
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
  controllers: [ReviewsController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}
