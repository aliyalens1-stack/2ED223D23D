import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProviderInboxService, InboxItem, PressureSummary } from './provider-inbox.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Provider Inbox')
@Controller('provider')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ProviderInboxController {
  constructor(private readonly inboxService: ProviderInboxService) {}

  /**
   * GET /api/provider/requests/inbox
   * Get provider's incoming requests (like Uber driver inbox)
   */
  @Get('requests/inbox')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get provider inbox - incoming requests' })
  async getInbox(@Req() req: any) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      // For admin testing, get first organization
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      return this.inboxService.getInbox(String(org?._id));
    }
    return this.inboxService.getInbox(providerId);
  }

  /**
   * GET /api/provider/pressure-summary
   * Get pressure metrics (missed requests, lost revenue, etc)
   */
  @Get('pressure-summary')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get pressure summary for provider' })
  async getPressureSummary(@Req() req: any) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      return this.inboxService.getPressureSummary(String(org?._id));
    }
    return this.inboxService.getPressureSummary(providerId);
  }

  /**
   * GET /api/provider/requests/missed
   * Get missed/expired requests for today
   */
  @Get('requests/missed')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Get missed requests' })
  async getMissedRequests(@Req() req: any) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      return this.inboxService.getMissedRequests(String(org?._id));
    }
    return this.inboxService.getMissedRequests(providerId);
  }

  /**
   * POST /api/provider/requests/:id/accept
   * Accept a request (first come first served)
   */
  @Post('requests/:id/accept')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Accept a request' })
  async acceptRequest(@Param('id') distributionId: string, @Req() req: any) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      return this.inboxService.acceptRequest(String(org?._id), distributionId);
    }
    return this.inboxService.acceptRequest(providerId, distributionId);
  }

  /**
   * POST /api/provider/requests/:id/reject
   * Reject/skip a request
   */
  @Post('requests/:id/reject')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Reject/skip a request' })
  async rejectRequest(
    @Param('id') distributionId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      return this.inboxService.rejectRequest(String(org?._id), distributionId, body.reason);
    }
    return this.inboxService.rejectRequest(providerId, distributionId, body.reason);
  }

  /**
   * POST /api/provider/requests/:id/view
   * Mark distribution as viewed
   */
  @Post('requests/:id/view')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Mark request as viewed' })
  async markViewed(@Param('id') distributionId: string, @Req() req: any) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      await this.inboxService.markViewed(String(org?._id), distributionId);
    } else {
      await this.inboxService.markViewed(providerId, distributionId);
    }
    return { success: true };
  }

  /**
   * POST /api/provider/presence/update
   * Update online status
   */
  @Post('presence/update')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @ApiOperation({ summary: 'Update provider presence/online status' })
  async updatePresence(
    @Body() body: { isOnline: boolean; acceptsQuickRequests?: boolean },
    @Req() req: any,
  ) {
    const providerId = req.user.organizationId || req.query.providerId;
    if (!providerId) {
      const db = (this.inboxService as any).connection.db;
      const org = await db.collection('organizations').findOne({});
      await this.inboxService.updatePresence(String(org?._id), body.isOnline, body.acceptsQuickRequests);
    } else {
      await this.inboxService.updatePresence(providerId, body.isOnline, body.acceptsQuickRequests);
    }
    return { success: true, isOnline: body.isOnline };
  }
}
