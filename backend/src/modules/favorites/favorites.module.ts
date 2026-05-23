import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { JwtModule } from '@nestjs/jwt';
import { FavoriteSchema } from './favorite.schema';
import { FavoritesService } from './favorites.service';
import { FavoritesController } from './favorites.controller';
import { OrganizationSchema } from '../organizations/organization.schema';
import { BranchSchema } from '../branches/branch.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Favorite', schema: FavoriteSchema },
      { name: 'Organization', schema: OrganizationSchema },
      { name: 'Branch', schema: BranchSchema },
    ]),
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_ACCESS_SECRET || 'auto-platform-jwt-secret',
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [FavoritesController],
  providers: [FavoritesService],
  exports: [FavoritesService],
})
export class FavoritesModule {}
