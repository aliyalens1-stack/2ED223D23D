import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { DisputesService } from './disputes.service';
import { CreateDisputeDto, AddMessageDto, ResolveDisputeDto } from './dto/dispute.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Disputes')
@Controller('disputes')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Post()
  @ApiOperation({ summary: 'Create a dispute' })
  create(@Req() req: any, @Body() dto: CreateDisputeDto) {
    return this.disputesService.create(req.user.sub, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get my disputes' })
  getMyDisputes(@Req() req: any) {
    return this.disputesService.getMyDisputes(req.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get dispute by ID' })
  getById(@Req() req: any, @Param('id') id: string) {
    return this.disputesService.getById(id, req.user.sub);
  }

  @Post(':id/message')
  @ApiOperation({ summary: 'Add message to dispute' })
  addMessage(@Req() req: any, @Param('id') id: string, @Body() dto: AddMessageDto) {
    return this.disputesService.addMessage(id, req.user.sub, dto, 'customer');
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/resolve')
  @ApiOperation({ summary: 'Resolve dispute (admin)' })
  resolve(@Req() req: any, @Param('id') id: string, @Body() dto: ResolveDisputeDto) {
    return this.disputesService.resolve(id, req.user.sub, dto);
  }
}
