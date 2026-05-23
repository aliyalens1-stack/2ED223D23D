// Admin REST surface for dispute governance (P0.a).
// Mounted at /api/admin/disputes/:id/* — admin role required.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DisputesAdminService } from './disputes-admin.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Admin · Disputes')
@Controller('admin/disputes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class DisputesAdminController {
  constructor(private readonly svc: DisputesAdminService) {}

  @Post(':id/assign')
  @ApiOperation({ summary: 'Assign dispute to operator (admin)' })
  assign(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { operatorId: string; reason?: string },
  ) {
    return this.svc.assign(id, req.user.sub, body);
  }

  @Post(':id/evidence')
  @ApiOperation({ summary: 'Attach evidence note (admin)' })
  addEvidence(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { note: string; attachments?: string[]; source?: string },
  ) {
    return this.svc.addEvidence(id, req.user.sub, body);
  }

  @Post(':id/request-evidence')
  @ApiOperation({ summary: 'Request evidence from party (admin)' })
  requestEvidence(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { fromParty: 'customer' | 'provider' | 'both'; deadlineHours?: number; message?: string },
  ) {
    return this.svc.requestEvidence(id, req.user.sub, body);
  }

  @Post(':id/freeze-payout')
  @ApiOperation({ summary: 'Freeze Stripe payout pending dispute outcome' })
  freezePayout(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { reason: string },
  ) {
    return this.svc.freezePayout(id, req.user.sub, body);
  }

  @Post(':id/warn')
  @ApiOperation({ summary: 'Issue formal warning to a party (admin)' })
  warn(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { targetParty: 'customer' | 'provider'; reason: string; severity?: 'low' | 'medium' | 'high' },
  ) {
    return this.svc.warn(id, req.user.sub, body);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Change dispute status (state-machine, admin)' })
  changeStatus(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { status: string; resolution?: string; refundAmount?: number },
  ) {
    return this.svc.changeStatus(id, req.user.sub, body);
  }

  @Post(':id/notes')
  @ApiOperation({ summary: 'Append admin note (allowed even after terminal)' })
  addNote(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { note: string; visibility?: 'internal' | 'public' },
  ) {
    return this.svc.addNote(id, req.user.sub, body);
  }

  @Get(':id/timeline')
  @ApiOperation({ summary: 'Full audit timeline (messages + admin actions)' })
  timeline(@Param('id') id: string) {
    return this.svc.getTimeline(id);
  }
}
