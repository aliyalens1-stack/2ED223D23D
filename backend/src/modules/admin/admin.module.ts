import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { UserSchema } from '../users/user.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { PaymentSchema } from '../payments/payment.schema';
import { DisputeSchema } from '../disputes/dispute.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { ReviewSchema } from '../reviews/review.schema';
import { PlatformConfigSchema } from '../platform-config/platform-config.schema';
import { AuditLogSchema } from './audit-log.schema';
import { NotificationTemplateSchema } from './notification-template.schema';
import { BulkNotificationSchema } from './bulk-notification.schema';
import { ServiceSchema } from '../services/service.schema';
import { FeatureFlagSchema } from './feature-flag.schema';
import { ExperimentSchema } from './experiment.schema';
import { ReputationActionSchema } from './reputation-action.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'Payment', schema: PaymentSchema },
      { name: 'Dispute', schema: DisputeSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Review', schema: ReviewSchema },
      { name: 'PlatformConfig', schema: PlatformConfigSchema },
      { name: 'AuditLog', schema: AuditLogSchema },
      { name: 'NotificationTemplate', schema: NotificationTemplateSchema },
      { name: 'BulkNotification', schema: BulkNotificationSchema },
      { name: 'Service', schema: ServiceSchema },
      { name: 'FeatureFlag', schema: FeatureFlagSchema },
      { name: 'Experiment', schema: ExperimentSchema },
      { name: 'ReputationAction', schema: ReputationActionSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
