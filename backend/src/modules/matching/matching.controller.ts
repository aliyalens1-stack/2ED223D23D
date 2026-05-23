import { Controller, Get, Post, Body, Query, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { SmartMatchingService, MatchingInput } from './smart-matching.service';

@Controller('matching')
export class MatchingController {
  constructor(private readonly matchingService: SmartMatchingService) {}

  /**
   * POST /matching/providers
   * Знайти найкращих провайдерів для кейсу
   */
  @Post('providers')
  async findTopMatches(@Body() input: MatchingInput) {
    return this.matchingService.findTopMatches(input);
  }

  /**
   * GET /matching/nearby
   * Швидкий пошук поблизу
   */
  @Get('nearby')
  async findNearby(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('serviceId') serviceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.matchingService.findTopMatches({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      serviceId,
    }, parseInt(limit || '5'));
  }

  /**
   * GET /matching/repeat
   * Знайти попереднього хорошого провайдера (authenticated)
   */
  @Get('repeat')
  @UseGuards(JwtAuthGuard)
  async findRepeatMatch(
    @Req() req: any,
    @Query('serviceId') serviceId?: string,
  ) {
    return this.matchingService.findRepeatMatch(req.user.sub, serviceId);
  }
}
