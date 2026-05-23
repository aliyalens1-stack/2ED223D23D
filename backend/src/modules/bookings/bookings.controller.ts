import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';

@Controller('bookings')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Roles(UserRole.CUSTOMER)
  @Get('my')
  myBookings(@Req() req: any, @Query('vehicleId') vehicleId?: string, @Query('status') status?: string) {
    return this.bookingsService.myBookings(req.user.sub, { vehicleId, status });
  }

  @Roles(UserRole.PROVIDER_OWNER, UserRole.PROVIDER_MANAGER, UserRole.ADMIN)
  @Get('incoming')
  incomingBookings(@Query('organizationId') organizationId?: string) {
    return this.bookingsService.incomingBookings(organizationId);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.bookingsService.getById(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Req() req: any,
    @Body() dto: UpdateBookingStatusDto,
  ) {
    return this.bookingsService.updateStatus(
      id,
      req.user.sub,
      req.user.role,
      dto.status,
    );
  }
}
