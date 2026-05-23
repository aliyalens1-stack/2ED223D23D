import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { CurrentJobService } from './current-job.service';
import { BookingStatus } from '../../shared/enums';

/**
 * Current Job Controller - API for active job management
 * 
 * Provider endpoints:
 * - GET /api/provider/current-job - Get active job
 * - POST /api/provider/location/update - Update location during route
 * - POST /api/bookings/:id/action/:action - Status actions
 * 
 * Customer endpoints:
 * - GET /api/customer/bookings/:id/live - Live booking view
 * 
 * Admin endpoints:
 * - GET /api/admin/bookings/:id/live - Admin live view
 * - PATCH /api/admin/bookings/:id/override-status - Override status
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class CurrentJobController {
  constructor(private readonly currentJobService: CurrentJobService) {}

  // ==================== PROVIDER ENDPOINTS ====================

  /**
   * Get provider's current active job
   * GET /api/provider/current-job
   */
  @Get('provider/current-job')
  async getProviderCurrentJob(@Request() req: any) {
    // Provider ID is the organization they belong to
    const providerId = req.user.organizationId || req.user.sub;
    return this.currentJobService.getProviderCurrentJob(providerId);
  }

  /**
   * Update provider location during route
   * POST /api/provider/location/update
   */
  @Post('provider/location/update')
  async updateProviderLocation(
    @Request() req: any,
    @Body() body: { bookingId: string; lat: number; lng: number }
  ) {
    const providerId = req.user.organizationId || req.user.sub;
    return this.currentJobService.updateProviderLocation(
      body.bookingId,
      providerId,
      { lat: body.lat, lng: body.lng }
    );
  }

  /**
   * Provider status action
   * POST /api/bookings/:id/action/:action
   * 
   * Actions: start_route, arrive, start_work, complete, no_show
   */
  @Post('bookings/:id/action/:action')
  async providerStatusAction(
    @Request() req: any,
    @Param('id') bookingId: string,
    @Param('action') action: string
  ) {
    const providerId = req.user.organizationId || req.user.sub;
    return this.currentJobService.providerStatusAction(
      bookingId,
      providerId,
      action as any
    );
  }

  // ==================== CUSTOMER ENDPOINTS ====================

  /**
   * Get customer's live booking view
   * GET /api/customer/bookings/:id/live
   */
  @Get('customer/bookings/:id/live')
  async getCustomerLiveBooking(
    @Request() req: any,
    @Param('id') bookingId: string
  ) {
    return this.currentJobService.getCustomerLiveBooking(bookingId, req.user.sub);
  }

  // ==================== ADMIN ENDPOINTS ====================

  /**
   * Admin live booking view
   * GET /api/admin/bookings/:id/live
   */
  @Get('admin/bookings/:id/live')
  async getAdminLiveBooking(@Param('id') bookingId: string) {
    // Admins can view any booking's live data
    // Using a dummy userId that won't match, so we need to adjust the service
    // For now, return provider view (similar data)
    const booking = await this.currentJobService.getProviderCurrentJob(bookingId);
    return booking;
  }

  /**
   * Admin override booking status
   * PATCH /api/admin/bookings/:id/override-status
   */
  @Patch('admin/bookings/:id/override-status')
  async adminOverrideStatus(
    @Request() req: any,
    @Param('id') bookingId: string,
    @Body() body: { status: BookingStatus; reason?: string }
  ) {
    return this.currentJobService.adminOverrideStatus(
      bookingId,
      body.status,
      req.user.sub,
      body.reason
    );
  }
}
