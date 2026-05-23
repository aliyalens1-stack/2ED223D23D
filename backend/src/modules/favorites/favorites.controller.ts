import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FavoritesService } from './favorites.service';
import { CreateFavoriteDto } from './dto/create-favorite.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

@ApiTags('Favorites')
@Controller('favorites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FavoritesController {
  constructor(private readonly favoritesService: FavoritesService) {}

  @Post()
  @ApiOperation({ summary: 'Add organization to favorites' })
  create(@Req() req: any, @Body() dto: CreateFavoriteDto) {
    return this.favoritesService.create(req.user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get my favorites' })
  getMy(@Req() req: any) {
    return this.favoritesService.getMy(req.user.sub);
  }

  @Get('check/:organizationId')
  @ApiOperation({ summary: 'Check if organization is in favorites' })
  async check(@Req() req: any, @Param('organizationId') organizationId: string) {
    const isFavorite = await this.favoritesService.check(req.user.sub, organizationId);
    return { isFavorite };
  }

  @Delete(':organizationId')
  @ApiOperation({ summary: 'Remove organization from favorites' })
  delete(@Req() req: any, @Param('organizationId') organizationId: string) {
    return this.favoritesService.delete(req.user.sub, organizationId);
  }
}
