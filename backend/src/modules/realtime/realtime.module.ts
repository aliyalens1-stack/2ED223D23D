import { Module, Global } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RealtimeGateway } from './realtime.gateway';
import { EventBusService } from './event-bus.service';
import { RealtimeController } from './realtime.controller';

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_ACCESS_SECRET || 'auto_service_jwt_secret_key_2025_very_secure',
    }),
  ],
  controllers: [RealtimeController],
  providers: [RealtimeGateway, EventBusService],
  exports: [RealtimeGateway, EventBusService],
})
export class RealtimeModule {}
