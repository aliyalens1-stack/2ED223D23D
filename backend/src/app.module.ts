import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { AuthModule } from './modules/auth/auth.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { BranchesModule } from './modules/branches/branches.module';
import { ServicesModule } from './modules/services/services.module';
import { ProviderServicesModule } from './modules/provider-services/provider-services.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { GeoModule } from './modules/geo/geo.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { FavoritesModule } from './modules/favorites/favorites.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { AdminModule } from './modules/admin/admin.module';
import { PlatformConfigModule } from './modules/platform-config/platform-config.module';
import { SlotsModule } from './modules/slots/slots.module';
// 🧠 V5: Smart Matching Engine
import { MatchingModule } from './modules/matching/matching.module';
// 🗺️ V5: Map Decision Layer
import { MapModule } from './modules/map/map.module';
// Admin Panel (serves static React app)
import { AdminPanelModule } from './modules/admin-panel/admin-panel.module';
// 🚀 Real-time WebSocket Module
import { RealtimeModule } from './modules/realtime/realtime.module';
// 🎯 Assignment Engine
import { AssignmentModule } from './modules/assignment/assignment.module';
// 📥 Provider Inbox + Auto-Distribution
import { ProviderInboxModule } from './modules/provider-inbox/provider-inbox.module';
// 🔥 Demand Engine (Surge, Distribution, TTL)
import { DemandModule } from './modules/demand/demand.module';
// 🌍 Zone Engine (City-Level Control)
import { ZonesModule } from './modules/zones/zones.module';
// 🤖 Marketplace Rules Engine (Self-Balancing System)
import { MarketplaceRulesModule } from './modules/marketplace-rules/marketplace-rules.module';
// 🔧 Automation Engine (AUTO1 Integration)
import { AutomationModule } from './modules/automation/automation.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGO_URL, {
      dbName: process.env.DB_NAME || 'auto_platform',
    }),
    // Serve admin panel static files at /admin
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'admin', 'dist'),
      serveRoot: '/admin',
      exclude: ['/api/*'],
    }),
    PlatformConfigModule, // Global module — settings & secrets
    NotificationsModule, // Global module — EventBus
    AuthModule,
    OrganizationsModule,
    BranchesModule,
    ServicesModule,
    ProviderServicesModule,
    VehiclesModule,
    QuotesModule,
    BookingsModule,
    GeoModule,
    ReviewsModule,
    FavoritesModule,
    PaymentsModule,
    DisputesModule,
    AdminModule,
    SlotsModule,
    // 🧠 V5: Smart Matching
    MatchingModule,
    // 🗺️ V5: Map Decision Layer
    MapModule,
    // Admin Panel (serves static React app)
    AdminPanelModule,
    // 🚀 Real-time WebSocket
    RealtimeModule,
    // 🎯 Assignment Engine
    AssignmentModule,
    // 📥 Provider Inbox + Auto-Distribution
    ProviderInboxModule,
    // 🔥 Demand Engine
    DemandModule,
    // 🌍 Zone Engine (City-Level Control)
    ZonesModule,
    // 🤖 Marketplace Rules Engine (Self-Balancing System)
    MarketplaceRulesModule,
    // 🔧 Automation Engine (AUTO1 Integration)
    AutomationModule,
  ],
})
export class AppModule {}
