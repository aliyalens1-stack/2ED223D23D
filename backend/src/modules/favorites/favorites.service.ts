import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CreateFavoriteDto } from './dto/create-favorite.dto';

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel('Favorite') private readonly favoriteModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
  ) {}

  async create(userId: string, dto: CreateFavoriteDto) {
    // Check org exists
    const org: any = await this.organizationModel.findById(dto.organizationId).lean();
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    // Check if already exists
    const existing = await this.favoriteModel.findOne({
      userId: new Types.ObjectId(userId),
      organizationId: new Types.ObjectId(dto.organizationId),
    });

    if (existing) {
      throw new ConflictException('Already in favorites');
    }

    // Get first branch city
    const branch: any = await this.branchModel.findOne({ organizationId: org._id }).lean();

    const favorite = await this.favoriteModel.create({
      userId: new Types.ObjectId(userId),
      organizationId: new Types.ObjectId(dto.organizationId),
      snapshot: {
        name: org.name,
        ratingAvg: org.ratingAvg || 0,
        reviewsCount: org.reviewsCount || 0,
        city: branch?.city || '',
      },
    });

    return favorite;
  }

  async getMy(userId: string) {
    return this.favoriteModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
  }

  async delete(userId: string, organizationId: string) {
    const result = await this.favoriteModel.deleteOne({
      userId: new Types.ObjectId(userId),
      organizationId: new Types.ObjectId(organizationId),
    });

    if (result.deletedCount === 0) {
      throw new NotFoundException('Favorite not found');
    }

    return { deleted: true };
  }

  async check(userId: string, organizationId: string): Promise<boolean> {
    const exists = await this.favoriteModel.findOne({
      userId: new Types.ObjectId(userId),
      organizationId: new Types.ObjectId(organizationId),
    });
    return !!exists;
  }

  async getMyOrganizationIds(userId: string): Promise<string[]> {
    const favorites = await this.favoriteModel
      .find({ userId: new Types.ObjectId(userId) })
      .select('organizationId')
      .lean();
    return favorites.map((f: any) => String(f.organizationId));
  }
}
