import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { VehicleSchema } from './vehicle.schema';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: 'Vehicle', schema: VehicleSchema }]),
    JwtModule.register({}),
  ],
  controllers: [VehiclesController],
  providers: [VehiclesService],
})
export class VehiclesModule {}
