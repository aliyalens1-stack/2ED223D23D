import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ProviderServiceSchema } from './provider-service.schema';
import { OrganizationMembershipSchema } from '../organizations/organization-membership.schema';
import { ServiceSchema } from '../services/service.schema';
import { ProviderServicesService } from './provider-services.service';
import { ProviderServicesController } from './provider-services.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'ProviderService', schema: ProviderServiceSchema },
      { name: 'OrganizationMembership', schema: OrganizationMembershipSchema },
      { name: 'Service', schema: ServiceSchema },
    ]),
    JwtModule.register({}),
  ],
  controllers: [ProviderServicesController],
  providers: [ProviderServicesService],
})
export class ProviderServicesModule {}
