import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VehicleStatus } from '../../shared/enums';

@Injectable()
export class VehiclesService {
  constructor(
    @InjectModel('Vehicle') private readonly vehicleModel: Model<any>,
  ) {}

  async create(userId: string, dto: any) {
    if (!dto.brand || !dto.model || !dto.year) {
      throw new BadRequestException('brand, model, year are required');
    }

    return this.vehicleModel.create({
      userId,
      brand: dto.brand,
      model: dto.model,
      year: dto.year,
      vin: dto.vin || null,
      licensePlate: dto.licensePlate || '',
      engineType: dto.engineType || '',
      transmission: dto.transmission || '',
      color: dto.color || '',
      mileage: dto.mileage || 0,
      status: VehicleStatus.ACTIVE,
    });
  }

  async myVehicles(userId: string) {
    return this.vehicleModel
      .find({ userId, status: VehicleStatus.ACTIVE })
      .sort({ createdAt: -1 })
      .lean();
  }

  async getById(vehicleId: string, userId: string) {
    const vehicle: any = await this.vehicleModel.findById(vehicleId).lean();
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (String(vehicle.userId) !== userId) {
      throw new BadRequestException('Not authorized');
    }
    return vehicle;
  }

  async update(vehicleId: string, userId: string, dto: any) {
    const vehicle = await this.vehicleModel.findById(vehicleId);
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (String(vehicle.userId) !== userId) {
      throw new BadRequestException('Not authorized');
    }

    const updateData: any = {};
    if (dto.brand !== undefined) updateData.brand = dto.brand;
    if (dto.model !== undefined) updateData.model = dto.model;
    if (dto.year !== undefined) updateData.year = dto.year;
    if (dto.vin !== undefined) updateData.vin = dto.vin;
    if (dto.licensePlate !== undefined) updateData.licensePlate = dto.licensePlate;
    if (dto.mileage !== undefined) updateData.mileage = dto.mileage;
    if (dto.color !== undefined) updateData.color = dto.color;

    return this.vehicleModel
      .findByIdAndUpdate(vehicleId, { $set: updateData }, { new: true })
      .lean();
  }

  async archive(vehicleId: string, userId: string) {
    const vehicle = await this.vehicleModel.findById(vehicleId);
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (String(vehicle.userId) !== userId) {
      throw new BadRequestException('Not authorized');
    }

    vehicle.status = VehicleStatus.ARCHIVED;
    await vehicle.save();
    return { success: true };
  }
}
