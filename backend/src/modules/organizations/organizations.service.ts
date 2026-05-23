import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrganizationStatus, StaffRole, MembershipStatus } from '../../shared/enums';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('OrganizationMembership') private readonly membershipModel: Model<any>,
    @InjectModel('Audit') private readonly auditModel: Model<any>,
  ) {}

  async create(ownerId: string, dto: { name: string; description?: string; contactEmail?: string; contactPhone?: string }) {
    if (!dto.name) throw new BadRequestException('Name is required');

    const slug = dto.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const org = await this.orgModel.create({
      name: dto.name,
      slug: `${slug}-${Date.now().toString(36)}`,
      ownerId,
      status: OrganizationStatus.DRAFT,
      description: dto.description || '',
      contactEmail: dto.contactEmail || '',
      contactPhone: dto.contactPhone || '',
    });

    await this.membershipModel.create({
      userId: ownerId,
      organizationId: org._id,
      role: StaffRole.OWNER,
      status: MembershipStatus.ACTIVE,
    });

    await this.auditModel.create({
      entity: 'Organization',
      entityId: String(org._id),
      action: 'ORGANIZATION_CREATED',
      actorId: ownerId,
      prev: null,
      next: { status: org.status },
    });

    return org;
  }

  async getById(id: string) {
    const org = await this.orgModel.findById(id).lean();
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async myOrganizations(userId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const memberships = await this.membershipModel
      .find({ userId: userObjectId, status: MembershipStatus.ACTIVE })
      .lean();
    const orgIds = memberships.map((m) => m.organizationId);
    return this.orgModel.find({ _id: { $in: orgIds } }).lean();
  }

  async update(orgId: string, actorId: string, dto: any) {
    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: orgId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });

    if (!membership) throw new BadRequestException('Not authorized');

    const updateData: any = {};
    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.contactEmail !== undefined) updateData.contactEmail = dto.contactEmail;
    if (dto.contactPhone !== undefined) updateData.contactPhone = dto.contactPhone;
    if (dto.specializations !== undefined) updateData.specializations = dto.specializations;

    const org = await this.orgModel
      .findByIdAndUpdate(orgId, { $set: updateData }, { new: true })
      .lean();

    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async list(query: { search?: string; page?: number; limit?: number; sort?: string }) {
    const filter: any = { status: OrganizationStatus.ACTIVE };
    if (query.search) {
      filter.name = { $regex: query.search, $options: 'i' };
    }
    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 20));
    const skip = (page - 1) * limit;

    // Sort by rank by default, or by rating
    const sortField: any = query.sort === 'rating' 
      ? { ratingAvg: -1 } 
      : { rankScore: -1, ratingAvg: -1 };

    const [data, total] = await Promise.all([
      this.orgModel.find(filter).sort(sortField).skip(skip).limit(limit).lean(),
      this.orgModel.countDocuments(filter),
    ]);

    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /**
   * Get provider stats (for provider dashboard)
   */
  async getProviderStats(organizationId: string) {
    const org: any = await this.orgModel.findById(organizationId).lean();
    if (!org) throw new NotFoundException('Organization not found');

    return {
      quotesReceived: org.quotesReceivedCount || 0,
      quotesResponded: org.quotesRespondedCount || 0,
      completedBookings: org.completedBookingsCount || 0,
      totalBookings: org.bookingsCount || 0,
      rating: org.ratingAvg || 0,
      reviewsCount: org.reviewsCount || 0,
      rankScore: org.rankScore || 0,
      avgResponseTimeMinutes: org.avgResponseTimeMinutes,
      isBoosted: org.isBoosted || false,
      boostUntil: org.boostUntil,
    };
  }

  // ═══════ LOCATION MANAGEMENT ═══════

  /**
   * Set location for organization
   * @param source - 'self' (owner), 'admin', or 'auto'
   */
  async setLocation(
    orgId: string,
    actorId: string,
    dto: { lat: number; lng: number; address?: string },
    source: 'self' | 'admin' | 'auto',
  ) {
    // For 'self' - verify actor is owner/manager
    if (source === 'self') {
      const membership = await this.membershipModel.findOne({
        userId: actorId,
        organizationId: orgId,
        role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
        status: MembershipStatus.ACTIVE,
      });
      if (!membership) throw new BadRequestException('Not authorized');
    }

    const updateData: any = {
      lat: dto.lat,
      lng: dto.lng,
      location: {
        type: 'Point',
        coordinates: [dto.lng, dto.lat], // GeoJSON: [lng, lat]
      },
      locationSource: source,
      locationUpdatedAt: new Date(),
    };

    if (dto.address) {
      updateData.address = dto.address;
    }

    // Self-set locations need verification
    if (source === 'self') {
      updateData.isLocationVerified = false;
      updateData.locationVerifiedAt = null;
      updateData.locationVerifiedBy = null;
    }
    // Admin-set locations are auto-verified
    else if (source === 'admin') {
      updateData.isLocationVerified = true;
      updateData.locationVerifiedAt = new Date();
      updateData.locationVerifiedBy = actorId;
    }

    const org = await this.orgModel
      .findByIdAndUpdate(orgId, { $set: updateData }, { new: true })
      .lean();

    if (!org) throw new NotFoundException('Organization not found');

    await this.auditModel.create({
      entity: 'Organization',
      entityId: orgId,
      action: 'LOCATION_UPDATED',
      actorId,
      prev: null,
      next: { lat: dto.lat, lng: dto.lng, source },
    });

    return org;
  }

  /**
   * Admin verifies location set by owner
   */
  async verifyLocation(orgId: string, adminId: string) {
    const org = await this.orgModel.findByIdAndUpdate(
      orgId,
      {
        $set: {
          isLocationVerified: true,
          locationVerifiedAt: new Date(),
          locationVerifiedBy: adminId,
        },
      },
      { new: true },
    ).lean();

    if (!org) throw new NotFoundException('Organization not found');

    await this.auditModel.create({
      entity: 'Organization',
      entityId: orgId,
      action: 'LOCATION_VERIFIED',
      actorId: adminId,
      prev: { isLocationVerified: false },
      next: { isLocationVerified: true },
    });

    return org;
  }

  /**
   * Admin removes location verification
   */
  async unverifyLocation(orgId: string) {
    const org = await this.orgModel.findByIdAndUpdate(
      orgId,
      {
        $set: {
          isLocationVerified: false,
          locationVerifiedAt: null,
          locationVerifiedBy: null,
        },
      },
      { new: true },
    ).lean();

    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }
}
