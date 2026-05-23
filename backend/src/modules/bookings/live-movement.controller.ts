import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { LiveMovementService } from './live-movement.service';

/**
 * Live Movement Controller - Real-time tracking API
 * 
 * Provider endpoints:
 * - POST /api/live/location - Update location with heading/speed
 * - POST /api/live/presence - Set online/offline status
 * 
 * Customer endpoints:
 * - GET /api/live/booking/:id - Live booking view with provider location
 * 
 * Admin endpoints:
 * - GET /api/live/providers - All online providers for map
 */
@Controller('live')
@UseGuards(JwtAuthGuard)
export class LiveMovementController {
  constructor(
    private readonly liveMovement: LiveMovementService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ==================== PROVIDER ENDPOINTS ====================

  /**
   * Update provider location during active booking
   * POST /api/live/location
   * 
   * Called every 5 seconds from provider app while on_route
   */
  @Post('location')
  async updateLocation(
    @Request() req: any,
    @Body() body: {
      bookingId: string;
      lat: number;
      lng: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
    }
  ) {
    // Get provider organization ID from user
    const UserModel = this.connection.model('User');
    const user = await UserModel.findById(req.user.sub).lean() as any;
    const providerId = user?.organizationId ? String(user.organizationId) : req.user.sub;

    return this.liveMovement.updateLocation(providerId, body.bookingId, {
      lat: body.lat,
      lng: body.lng,
      heading: body.heading,
      speed: body.speed,
      accuracy: body.accuracy,
    });
  }

  /**
   * Set provider online/offline status
   * POST /api/live/presence
   */
  @Post('presence')
  async setPresence(
    @Request() req: any,
    @Body() body: {
      isOnline: boolean;
      lat?: number;
      lng?: number;
    }
  ) {
    const providerId = req.user.organizationId || req.user.sub;

    await this.liveMovement.setProviderOnlineStatus(
      providerId,
      body.isOnline,
      body.lat && body.lng ? { lat: body.lat, lng: body.lng } : undefined
    );

    return { success: true, isOnline: body.isOnline };
  }

  // ==================== CUSTOMER ENDPOINTS ====================

  /**
   * Get live booking view for customer
   * GET /api/live/booking/:id
   * 
   * Polling endpoint for customer to track provider movement
   */
  @Get('booking/:id')
  async getCustomerLiveView(
    @Request() req: any,
    @Param('id') bookingId: string
  ) {
    return this.liveMovement.getCustomerLiveView(bookingId, req.user.sub);
  }

  // ==================== ADMIN ENDPOINTS ====================

  /**
   * Get all online providers for admin map
   * GET /api/live/providers
   */
  @Get('providers')
  async getOnlineProviders(
    @Query('minLat') minLat?: string,
    @Query('maxLat') maxLat?: string,
    @Query('minLng') minLng?: string,
    @Query('maxLng') maxLng?: string
  ) {
    const bounds = minLat && maxLat && minLng && maxLng ? {
      minLat: parseFloat(minLat),
      maxLat: parseFloat(maxLat),
      minLng: parseFloat(minLng),
      maxLng: parseFloat(maxLng),
    } : undefined;

    return this.liveMovement.getOnlineProviders(bounds);
  }
}
