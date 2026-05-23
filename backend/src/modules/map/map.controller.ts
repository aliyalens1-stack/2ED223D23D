import { Controller, Get, Query } from '@nestjs/common';
import { MapService } from './map.service';

@Controller('map')
export class MapController {
  constructor(private readonly mapService: MapService) {}

  /**
   * GET /map/providers/nearby
   * Поиск лучших провайдеров по радиусу от точки пользователя
   * Sorted by: visibilityScore + matchingScore
   */
  @Get('providers/nearby')
  async getNearbyProviders(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('radius') radius?: string,
    @Query('limit') limit?: string,
    @Query('filter') filter?: string,
  ) {
    return this.mapService.getNearbyProviders({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      radiusKm: parseFloat(radius || '15'),
      limit: parseInt(limit || '20'),
      filter: filter as any,
    });
  }

  /**
   * GET /map/providers/viewport
   * Провайдеры в текущем viewport карты (bounding box)
   */
  @Get('providers/viewport')
  async getViewportProviders(
    @Query('swLat') swLat: string,
    @Query('swLng') swLng: string,
    @Query('neLat') neLat: string,
    @Query('neLng') neLng: string,
    @Query('filter') filter?: string,
  ) {
    return this.mapService.getViewportProviders({
      swLat: parseFloat(swLat),
      swLng: parseFloat(swLng),
      neLat: parseFloat(neLat),
      neLng: parseFloat(neLng),
      filter: filter as any,
    });
  }

  /**
   * GET /map/direct
   * Direct Mode — конверсионный экран для выбранного мастера
   * Включает: детали, расстояние, ETA, reasons, слоты
   */
  @Get('direct')
  async getDirectMode(
    @Query('providerId') providerId: string,
    @Query('lat') lat: string,
    @Query('lng') lng: string,
  ) {
    return this.mapService.getDirectMode({
      providerId,
      lat: parseFloat(lat || '0'),
      lng: parseFloat(lng || '0'),
    });
  }

  /**
   * GET /map/providers/matching
   * Matching провайдеры для конкретной заявки
   * Decision Layer: "Кто мне сейчас лучше всего подходит?"
   */
  @Get('providers/matching')
  async getMatchingProviders(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('serviceId') serviceId?: string,
    @Query('urgency') urgency?: string,
    @Query('limit') limit?: string,
  ) {
    return this.mapService.getMatchingProviders({
      lat: parseFloat(lat),
      lng: parseFloat(lng),
      serviceId,
      urgency: urgency as any,
      limit: parseInt(limit || '10'),
    });
  }
}
