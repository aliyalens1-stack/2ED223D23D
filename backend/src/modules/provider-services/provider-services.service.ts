import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { GeoStatus, StaffRole, MembershipStatus } from '../../shared/enums';

@Injectable()
export class ProviderServicesService {
  constructor(
    @InjectModel('ProviderService') private readonly psModel: Model<any>,
    @InjectModel('OrganizationMembership') private readonly membershipModel: Model<any>,
    @InjectModel('Service') private readonly serviceModel: Model<any>,
  ) {}

  async create(actorId: string, dto: any) {
    if (!dto.organizationId || !dto.branchId || !dto.serviceId || !dto.price) {
      throw new BadRequestException('organizationId, branchId, serviceId, price are required');
    }

    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: dto.organizationId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });
    if (!membership) throw new BadRequestException('Not authorized');

    const service = await this.serviceModel.findById(dto.serviceId);
    if (!service) throw new NotFoundException('Service not found');

    return this.psModel.create({
      organizationId: dto.organizationId,
      branchId: dto.branchId,
      serviceId: dto.serviceId,
      price: dto.price,
      priceFrom: dto.priceFrom || 0,
      priceTo: dto.priceTo || 0,
      duration: dto.duration || service.durationMin || 60,
      warrantyDays: dto.warrantyDays || 0,
      description: dto.description || '',
      brandsSupported: dto.brandsSupported || [],
      status: GeoStatus.ACTIVE,
    });
  }

  async getByOrganization(organizationId: string, branchId?: string) {
    const filter: any = { organizationId, status: GeoStatus.ACTIVE };
    if (branchId) filter.branchId = branchId;
    return this.psModel.find(filter).lean();
  }

  async update(id: string, actorId: string, dto: any) {
    const ps = await this.psModel.findById(id);
    if (!ps) throw new NotFoundException('ProviderService not found');

    const membership = await this.membershipModel.findOne({
      userId: actorId,
      organizationId: ps.organizationId,
      role: { $in: [StaffRole.OWNER, StaffRole.MANAGER] },
      status: MembershipStatus.ACTIVE,
    });
    if (!membership) throw new BadRequestException('Not authorized');

    const updateData: any = {};
    if (dto.price !== undefined) updateData.price = dto.price;
    if (dto.duration !== undefined) updateData.duration = dto.duration;
    if (dto.warrantyDays !== undefined) updateData.warrantyDays = dto.warrantyDays;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.status !== undefined) updateData.status = dto.status;

    return this.psModel.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean();
  }
}
