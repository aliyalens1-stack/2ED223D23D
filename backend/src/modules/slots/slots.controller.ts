import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { SlotsService } from './slots.service';
import {
  SetAvailabilityDto,
  SetBulkAvailabilityDto,
  BlockTimeDto,
  ReserveSlotDto,
  CreateBookingWithSlotDto,
  SetDurationRuleDto,
} from './dto/slots.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Slots & Availability')
@Controller('')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SlotsController {
  constructor(private readonly slotsService: SlotsService) {}

  // ────────── AVAILABILITY (Provider) ──────────

  @Post('provider-availability')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Set single weekday availability' })
  setAvailability(@Req() req: any, @Body() dto: SetAvailabilityDto) {
    return this.slotsService.setAvailability(req.user.sub, dto);
  }

  @Post('provider-availability/bulk')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Set weekly schedule in bulk' })
  setBulkAvailability(@Req() req: any, @Body() dto: SetBulkAvailabilityDto) {
    return this.slotsService.setBulkAvailability(req.user.sub, dto);
  }

  @Get('branches/:branchId/availability')
  @ApiOperation({ summary: 'Get branch weekly availability' })
  getAvailability(@Param('branchId') branchId: string) {
    return this.slotsService.getAvailability(branchId);
  }

  // ────────── BLOCKED TIME (Provider) ──────────

  @Post('provider-blocked-time')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Block a time period' })
  blockTime(@Req() req: any, @Body() dto: BlockTimeDto) {
    return this.slotsService.blockTime(req.user.sub, dto);
  }

  @Get('branches/:branchId/blocked-times')
  @ApiOperation({ summary: 'Get blocked time periods for branch' })
  getBlockedTimes(@Param('branchId') branchId: string) {
    return this.slotsService.getBlockedTimes(branchId);
  }

  @Delete('provider-blocked-time/:id')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Remove blocked time' })
  removeBlockedTime(@Req() req: any, @Param('id') id: string) {
    return this.slotsService.removeBlockedTime(req.user.sub, id);
  }

  // ────────── DURATION RULES (Provider) ──────────

  @Post('service-duration-rule')
  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Set custom duration rule for a service at branch' })
  setDurationRule(@Req() req: any, @Body() dto: SetDurationRuleDto) {
    return this.slotsService.setDurationRule(req.user.sub, dto);
  }

  // ────────── SLOTS (Customer) ──────────

  @Get('branches/:branchId/slots')
  @ApiOperation({ summary: 'Get available time slots for date + service' })
  @ApiQuery({ name: 'date', required: true, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'serviceId', required: true, description: 'ProviderService ID' })
  getSlots(
    @Param('branchId') branchId: string,
    @Query('date') date: string,
    @Query('serviceId') serviceId: string,
  ) {
    return this.slotsService.getAvailableSlots(branchId, date, serviceId);
  }

  @Post('slots/reserve')
  @ApiOperation({ summary: 'Reserve a time slot (15 min hold)' })
  reserveSlot(@Req() req: any, @Body() dto: ReserveSlotDto) {
    return this.slotsService.reserveSlot(req.user.sub, dto);
  }

  @Post('slots/:id/release')
  @ApiOperation({ summary: 'Release a reserved slot' })
  releaseSlot(@Req() req: any, @Param('id') id: string) {
    return this.slotsService.releaseSlot(req.user.sub, id);
  }

  // ────────── BOOKING WITH SLOT ──────────

  @Post('bookings/create-with-slot')
  @Roles(UserRole.CUSTOMER)
  @UseGuards(RolesGuard)
  @ApiOperation({ summary: 'Create booking from reserved slot' })
  createBookingWithSlot(@Req() req: any, @Body() dto: CreateBookingWithSlotDto) {
    return this.slotsService.createBookingWithSlot(req.user.sub, dto);
  }
}
