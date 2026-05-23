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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';

@ApiTags('Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a review for completed booking' })
  create(@Req() req: any, @Body() dto: CreateReviewDto) {
    return this.reviewsService.create(req.user.sub, dto);
  }

  @Get('my')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my reviews' })
  getMyReviews(@Req() req: any) {
    return this.reviewsService.getByUser(req.user.sub);
  }

  @Get('booking/:bookingId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get review by booking ID' })
  getByBooking(@Param('bookingId') bookingId: string) {
    return this.reviewsService.getByBooking(bookingId);
  }

  @Get('organization/:organizationId')
  @ApiOperation({ summary: 'Get reviews for organization' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  getByOrganization(
    @Param('organizationId') organizationId: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.reviewsService.getByOrganization(organizationId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
    });
  }

  @Get('organization/:organizationId/stats')
  @ApiOperation({ summary: 'Get review stats for organization' })
  getOrganizationStats(@Param('organizationId') organizationId: string) {
    return this.reviewsService.getOrganizationStats(organizationId);
  }
}
