import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ZonesController } from './zones.controller';
import { ZoneEngineService } from './zone-engine.service';
import { GeoZoneSchema, ZoneMetricsSchema, ZoneActionSchema } from './zone.schema';
import { QuoteSchema } from '../quotes/quote.schema';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BookingSchema } from '../bookings/booking.schema';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'GeoZone', schema: GeoZoneSchema },
      { name: 'ZoneMetrics', schema: ZoneMetricsSchema },
      { name: 'ZoneAction', schema: ZoneActionSchema },
      { name: 'Quote', schema: QuoteSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Booking', schema: BookingSchema },
    ]),
    NotificationsModule,
    AuthModule,
  ],
  controllers: [ZonesController],
  providers: [ZoneEngineService],
  exports: [ZoneEngineService],
})
export class ZonesModule {}
