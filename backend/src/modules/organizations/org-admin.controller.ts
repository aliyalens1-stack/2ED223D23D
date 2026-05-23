// P0.c — Admin REST surface for organization governance.
// Mounted at /api/admin/organizations/:id/* — admin role required.
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgAdminService } from './org-admin.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Admin · Organizations')
@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class OrgAdminController {
  constructor(private readonly svc: OrgAdminService) {}

  // ── Governance actions ───────────────────────────────────────────────────

  @Post(':id/verify')
  @ApiOperation({ summary: 'Verify organization (admin)' })
  verify(@Req() req: any, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.verify(id, req.user.sub, body || {});
  }

  @Post(':id/unverify')
  @ApiOperation({ summary: 'Remove verified status (admin)' })
  unverify(@Req() req: any, @Param('id') id: string, @Body() body: { reason: string }) {
    return this.svc.unverify(id, req.user.sub, body);
  }

  @Post(':id/suspend')
  @ApiOperation({ summary: 'Suspend or block organization (admin)' })
  suspend(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string; mode?: 'suspended' | 'blocked' },
  ) {
    return this.svc.suspend(id, req.user.sub, body);
  }

  @Post(':id/unsuspend')
  @ApiOperation({ summary: 'Restore suspended/blocked org to active (admin)' })
  unsuspend(@Req() req: any, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.svc.unsuspend(id, req.user.sub, body || {});
  }

  @Post(':id/boost')
  @ApiOperation({ summary: 'Activate or deactivate ranking boost (admin)' })
  boost(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { activate: boolean; durationDays?: number; multiplier?: number; reason?: string },
  ) {
    return this.svc.boost(id, req.user.sub, body);
  }

  @Post(':id/commission')
  @ApiOperation({ summary: 'Override or clear commission rate (admin)' })
  setCommission(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { percent: number | null; reason?: string },
  ) {
    return this.svc.setCommission(id, req.user.sub, body);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Append admin note to org audit (admin)' })
  addNote(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { note: string; visibility?: 'internal' | 'public' },
  ) {
    return this.svc.addNote(id, req.user.sub, body);
  }

  // ── Read-only operational visibility ─────────────────────────────────────

  @Get(':id/bookings')
  @ApiOperation({ summary: 'List org bookings (admin, read-only)' })
  getBookings(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.getBookings(id, {
      status,
      limit: limit ? Number(limit) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(':id/payouts')
  @ApiOperation({ summary: 'List org payouts/payments (admin, read-only)' })
  getPayouts(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.getPayouts(id, {
      status,
      limit: limit ? Number(limit) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }

  @Get(':id/performance')
  @ApiOperation({ summary: 'KPI dashboard for org (admin, read-only)' })
  getPerformance(@Param('id') id: string) {
    return this.svc.getPerformance(id);
  }

  @Get(':id/audit')
  @ApiOperation({ summary: 'Audit trail for org (admin, read-only)' })
  getAudit(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.svc.getAuditTrail(id, {
      limit: limit ? Number(limit) : undefined,
      skip: skip ? Number(skip) : undefined,
    });
  }
}
