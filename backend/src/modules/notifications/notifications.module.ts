// Notifications Module
import { Module, Global } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { NotificationSchema } from './notification.schema';
import { UserDeviceSchema } from './entities/user-device.schema';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsGateway } from './notifications.gateway';
import { EventBus } from '../../shared/events';

@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Notification', schema: NotificationSchema },
      { name: 'UserDevice', schema: UserDeviceSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [NotificationsController],
  providers: [
    EventBus,
    NotificationsGateway,
    NotificationsService,
  ],
  exports: [EventBus, NotificationsService, NotificationsGateway],
})
export class NotificationsModule {}
