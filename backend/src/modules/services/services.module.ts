import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { ServiceCategorySchema, ServiceSchema } from './service.schema';
import { ServicesService } from './services.service';
import { ServicesController } from './services.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'ServiceCategory', schema: ServiceCategorySchema },
      { name: 'Service', schema: ServiceSchema },
    ]),
    JwtModule.register({}),
  ],
  controllers: [ServicesController],
  providers: [ServicesService],
})
export class ServicesModule {}
