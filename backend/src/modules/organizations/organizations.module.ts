import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { OrganizationSchema } from './organization.schema';
import { OrganizationMembershipSchema } from './organization-membership.schema';
import { AuditSchema } from '../audit/audit.schema';
import { OrganizationsService } from './organizations.service';
import { OrganizationsController } from './organizations.controller';
import { RankingService } from './ranking.service';
// 🔴 P2: Suspicious Detection & Dynamic Commission
import { SuspiciousDetectionService } from './suspicious-detection.service';
import { DynamicCommissionService } from './dynamic-commission.service';
import { ProviderStatsService } from './provider-stats.service';
import { BookingSchema } from '../bookings/booking.schema';
import { QuoteResponseSchema } from '../quotes/quote-response.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { BranchSchema } from '../branches/branch.schema';
// P0.c — admin governance
import { OrgAuditSchema } from './org-audit.schema';
import { PaymentSchema } from '../payments/payment.schema';
import { OrgAdminService } from './org-admin.service';
import { OrgAdminController } from './org-admin.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'OrganizationMembership', schema: OrganizationMembershipSchema },
      { name: 'Audit', schema: AuditSchema },
      { name: 'Booking', schema: BookingSchema },
      { name: 'QuoteResponse', schema: QuoteResponseSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Branch', schema: BranchSchema },
      // P0.c
      { name: 'OrgAudit', schema: OrgAuditSchema },
      { name: 'Payment', schema: PaymentSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [OrganizationsController, OrgAdminController],
  providers: [
    OrganizationsService,
    RankingService,
    // 🔴 P2 Services
    SuspiciousDetectionService,
    DynamicCommissionService,
    ProviderStatsService,
    // P0.c
    OrgAdminService,
  ],
  exports: [
    OrganizationsService,
    RankingService,
    SuspiciousDetectionService,
    DynamicCommissionService,
    ProviderStatsService,
    OrgAdminService,
  ],
})
export class OrganizationsModule {}
