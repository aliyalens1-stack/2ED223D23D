import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { BranchSchema } from './branch.schema';
import { OrganizationMembershipSchema } from '../organizations/organization-membership.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { AuditSchema } from '../audit/audit.schema';
import { BranchesService } from './branches.service';
import { BranchesController } from './branches.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Branch', schema: BranchSchema },
      { name: 'OrganizationMembership', schema: OrganizationMembershipSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Audit', schema: AuditSchema },
    ]),
    JwtModule.register({}),
  ],
  controllers: [BranchesController],
  providers: [BranchesService],
  exports: [BranchesService],
})
export class BranchesModule {}
