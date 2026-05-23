import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AssignmentService } from './assignment.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Assignment')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AssignmentController {
  constructor(private readonly assignmentService: AssignmentService) {}

  // ==================== MAP ENDPOINTS ====================

  /**
   * GET /api/map/requests/live
   * Get live requests for map display
   */
  @Get('map/requests/live')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'Get live requests for map' })
  @ApiQuery({ name: 'lat', required: false })
  @ApiQuery({ name: 'lng', required: false })
  @ApiQuery({ name: 'radius', required: false })
  @ApiQuery({ name: 'limit', required: false })
  getLiveRequests(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('radius') radius?: string,
    @Query('limit') limit?: string,
  ) {
    return this.assignmentService.getLiveRequestsForMap({
      lat: lat ? parseFloat(lat) : undefined,
      lng: lng ? parseFloat(lng) : undefined,
      radius: radius ? parseInt(radius) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  /**
   * GET /api/map/requests/:id/matching
   * Get matching providers for a specific request
   */
  @Get('map/requests/:id/matching')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT, UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Get matching providers for request' })
  async getMatchingProviders(@Param('id') requestId: string) {
    try {
      return await this.assignmentService.getMatchingProvidersForRequest(requestId);
    } catch (error) {
      console.error('Controller error in getMatchingProviders:', error);
      throw error;
    }
  }

  // ==================== MATCHING ENDPOINTS ====================

  /**
   * GET /api/requests/:id/matching
   * Get matching candidates for a request
   */
  @Get('requests/:id/matching')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT, UserRole.CUSTOMER)
  @ApiOperation({ summary: 'Get matching candidates' })
  @ApiQuery({ name: 'limit', required: false })
  async getMatchingCandidates(
    @Param('id') requestId: string,
    @Query('limit') limit?: string,
  ) {
    try {
      return await this.assignmentService.findMatchingCandidates(
        requestId,
        limit ? parseInt(limit) : 10,
      );
    } catch (error) {
      console.error('Controller error in getMatchingCandidates:', error);
      throw error;
    }
  }

  // ==================== DISTRIBUTION ENDPOINTS ====================

  /**
   * POST /api/requests/:id/distribute
   * Distribute request to providers
   */
  @Post('requests/:id/distribute')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'Distribute request to providers' })
  distributeRequest(
    @Param('id') requestId: string,
    @Body() dto: { providerIds: string[] },
    @Req() req: any,
  ) {
    return this.assignmentService.distributeRequest(
      requestId,
      dto.providerIds,
      req.user.sub,
      'operator',
    );
  }

  /**
   * POST /api/requests/:id/distribute/auto
   * Auto-distribute to top matching providers
   */
  @Post('requests/:id/distribute/auto')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'Auto-distribute to top providers' })
  @ApiQuery({ name: 'count', required: false })
  async autoDistribute(
    @Param('id') requestId: string,
    @Query('count') count?: string,
  ) {
    const topCount = count ? parseInt(count) : 5;
    const candidates = await this.assignmentService.findMatchingCandidates(requestId, topCount);
    const providerIds = candidates.map(c => c.providerId);
    return this.assignmentService.distributeRequest(requestId, providerIds, undefined, 'auto');
  }

  /**
   * GET /api/requests/:id/distributions
   * Get distribution logs for a request
   */
  @Get('requests/:id/distributions')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'Get distribution logs' })
  getDistributions(@Param('id') requestId: string) {
    return this.assignmentService.getDistributionLogs(requestId);
  }

  // ==================== ASSIGNMENT ENDPOINTS ====================

  /**
   * POST /api/requests/:id/assign
   * Select provider and create booking from request
   */
  @Post('requests/:id/assign')
  @Roles(UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({ summary: 'Assign provider and create booking' })
  assignProvider(
    @Param('id') requestId: string,
    @Body() dto: {
      providerId: string;
      price?: number;
      slotId?: string;
      notes?: string;
    },
    @Req() req: any,
  ) {
    return this.assignmentService.selectProviderAndCreateBooking(
      requestId,
      dto.providerId,
      req.user.sub,
      {
        price: dto.price,
        slotId: dto.slotId,
        notes: dto.notes,
      },
    );
  }

  /**
   * POST /api/bookings/create-from-request
   * Create booking from request (customer flow)
   */
  @Post('bookings/create-from-request')
  @Roles(UserRole.CUSTOMER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Create booking from request' })
  createBookingFromRequest(
    @Body() dto: {
      requestId: string;
      providerId: string;
      price?: number;
      slotId?: string;
    },
    @Req() req: any,
  ) {
    return this.assignmentService.selectProviderAndCreateBooking(
      dto.requestId,
      dto.providerId,
      undefined,
      {
        price: dto.price,
        slotId: dto.slotId,
      },
    );
  }

  // ==================== PROVIDER RESPONSE ENDPOINTS ====================

  /**
   * POST /api/distributions/:id/respond
   * Provider responds to a distribution
   */
  @Post('distributions/:id/respond')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @ApiOperation({ summary: 'Respond to distribution' })
  respondToDistribution(
    @Param('id') distributionId: string,
    @Body() dto: {
      price?: number;
      eta?: number;
      message?: string;
    },
  ) {
    return this.assignmentService.respondToDistribution(distributionId, dto);
  }

  /**
   * POST /api/distributions/:id/view
   * Mark distribution as viewed
   */
  @Post('distributions/:id/view')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @ApiOperation({ summary: 'Mark distribution as viewed' })
  markViewed(@Param('id') distributionId: string) {
    return this.assignmentService.markViewed(distributionId);
  }
}
