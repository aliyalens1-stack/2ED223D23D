import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { BranchStatus, StaffRole, MembershipStatus } from '../../shared/enums';

interface NearbyQuery {
  lat: number;
  lng: number;
  radius?: number; // in km
  city?: string;
  limit?: number;
}

@Injectable()
export class BranchesService {
  constructor(
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('OrganizationMembership') private readonly membershipModel: Model<any>,
    @InjectModel('Audit') private readonly auditModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
  ) {}

  async create(actorId: string, dto: any) {
    if (!dto.organizationId || !dto.name || !dto.city || !dto.address) {
      throw new BadRequestException('organizationId, name, city, address are required');
    }

    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: dto.organizationId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });

    if (!membership) throw new BadRequestException('Not authorized');

    const branch = await this.branchModel.create({
      organizationId: dto.organizationId,
      name: dto.name,
      city: dto.city,
      address: dto.address,
      phone: dto.phone || '',
      email: dto.email || '',
      location: dto.lat && dto.lng
        ? { type: 'Point', coordinates: [dto.lng, dto.lat] }
        : { type: 'Point', coordinates: [0, 0] },
      workingHours: dto.workingHours || {},
      timezone: dto.timezone || 'Europe/Moscow',
      status: BranchStatus.PENDING_SETUP,
    });

    await this.auditModel.create({
      entity: 'Branch',
      entityId: String(branch._id),
      action: 'BRANCH_CREATED',
      actorId,
      prev: null,
      next: { status: branch.status },
    });

    return branch;
  }

  async getByOrganization(organizationId: string) {
    return this.branchModel
      .find({ organizationId, status: { $ne: BranchStatus.PERMANENTLY_CLOSED } })
      .lean();
  }

  async getById(id: string) {
    const branch = await this.branchModel.findById(id).lean();
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  async update(branchId: string, actorId: string, dto: any) {
    const branch = await this.branchModel.findById(branchId);
    if (!branch) throw new NotFoundException('Branch not found');

    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: branch.organizationId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });

    if (!membership) throw new BadRequestException('Not authorized');

    const updateData: any = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.address !== undefined) updateData.address = dto.address;
    if (dto.phone !== undefined) updateData.phone = dto.phone;
    if (dto.email !== undefined) updateData.email = dto.email;
    if (dto.workingHours !== undefined) updateData.workingHours = dto.workingHours;
    if (dto.status !== undefined) updateData.status = dto.status;

    const updated = await this.branchModel
      .findByIdAndUpdate(branchId, { $set: updateData }, { new: true })
      .lean();

    return updated;
  }

  async activate(branchId: string, actorId: string) {
    const branch = await this.branchModel.findById(branchId);
    if (!branch) throw new NotFoundException('Branch not found');

    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: branch.organizationId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });

    if (!membership) throw new BadRequestException('Not authorized');

    branch.status = BranchStatus.ACTIVE;
    await branch.save();

    return branch;
  }

  /**
   * Geo-search for nearby branches (public endpoint for discovery)
   * Returns branches with organization info, response time, and min price
   */
  async findNearby(query: NearbyQuery) {
    const { lat, lng, radius = 10, city, limit = 50 } = query;
    
    // Build match conditions
    const matchConditions: any = {
      status: BranchStatus.ACTIVE,
    };

    let branches: any[];

    // Common pipeline stages for enrichment
    const enrichmentStages = [
      {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      // Lookup provider services to get min price
      {
        $lookup: {
          from: 'providerservices',
          let: { branchId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$branchId', '$$branchId'] }, status: 'active' } },
            { $sort: { price: 1 } },
            { $limit: 1 },
            { $project: { price: 1, priceFrom: 1 } },
          ],
          as: 'minPriceService',
        },
      },
    ];

    const projectStage = {
      $project: {
        _id: 1,
        name: 1,
        city: 1,
        address: 1,
        phone: 1,
        location: 1,
        distance: 1,
        ratingAvg: 1,
        reviewsCount: 1,
        organizationId: 1,
        organization: {
          _id: '$organization._id',
          name: '$organization.name',
          description: '$organization.description',
          ratingAvg: '$organization.ratingAvg',
          reviewsCount: '$organization.reviewsCount',
          specializations: '$organization.specializations',
          avgResponseTimeMinutes: '$organization.avgResponseTimeMinutes',
        },
        minPrice: {
          $ifNull: [
            { $arrayElemAt: ['$minPriceService.priceFrom', 0] },
            { $arrayElemAt: ['$minPriceService.price', 0] },
          ],
        },
      },
    };

    if (lat && lng && lat !== 0 && lng !== 0) {
      // Use geo-search
      branches = await this.branchModel.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [lng, lat] },
            distanceField: 'distance',
            maxDistance: radius * 1000,
            spherical: true,
            query: matchConditions,
          },
        },
        { $limit: limit },
        { $addFields: { distance: { $round: [{ $divide: ['$distance', 1000] }, 1] } } },
        ...enrichmentStages,
        projectStage,
      ] as any[]);
    } else {
      // Fallback without geo - filter by city name in address if provided
      if (city) {
        matchConditions.$or = [
          { address: { $regex: city, $options: 'i' } },
          { name: { $regex: city, $options: 'i' } },
        ];
      }
      
      branches = await this.branchModel.aggregate([
        { $match: matchConditions },
        { $limit: limit },
        { $addFields: { distance: { $literal: null } } },
        ...enrichmentStages,
        projectStage,
      ] as any[]);
    }

    return branches;
  }

  /**
   * Search branches by text query
   */
  async search(query: string, options?: { city?: string; limit?: number }) {
    const limit = options?.limit || 20;
    
    const conditions: any = {
      status: BranchStatus.ACTIVE,
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { address: { $regex: query, $options: 'i' } },
      ],
    };

    if (options?.city) {
      conditions.city = { $regex: options.city, $options: 'i' };
    }

    const branches = await this.branchModel.aggregate([
      { $match: conditions },
      { $limit: limit },
      {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      },
      { $unwind: { path: '$organization', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          name: 1,
          city: 1,
          address: 1,
          phone: 1,
          location: 1,
          ratingAvg: 1,
          reviewsCount: 1,
          organizationId: 1,
          organization: {
            _id: '$organization._id',
            name: '$organization.name',
            description: '$organization.description',
            ratingAvg: '$organization.ratingAvg',
            reviewsCount: '$organization.reviewsCount',
          },
        },
      },
    ]);

    return branches;
  }
}
