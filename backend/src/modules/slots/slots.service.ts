import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { SlotStatus } from './booking-slot.schema';
import {
  SetAvailabilityDto,
  SetBulkAvailabilityDto,
  BlockTimeDto,
  ReserveSlotDto,
  CreateBookingWithSlotDto,
  SetDurationRuleDto,
} from './dto/slots.dto';
import { BookingStatus } from '../../shared/enums';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { EventBus, PlatformEvent } from '../../shared/events';

@Injectable()
export class SlotsService {
  private readonly logger = new Logger(SlotsService.name);

  constructor(
    @InjectModel('ProviderAvailability') private readonly availModel: Model<any>,
    @InjectModel('ProviderBlockedTime') private readonly blockedModel: Model<any>,
    @InjectModel('BookingSlot') private readonly slotModel: Model<any>,
    @InjectModel('ServiceDurationRule') private readonly durationModel: Model<any>,
    @InjectModel('ProviderService') private readonly providerServiceModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Branch') private readonly branchModel: Model<any>,
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
    private readonly configService: PlatformConfigService,
    private readonly eventBus: EventBus,
  ) {}

  // ────────────────── AVAILABILITY ──────────────────

  async setAvailability(orgOwnerId: string, dto: SetAvailabilityDto) {
    await this.verifyBranchOwnership(orgOwnerId, dto.branchId);
    const branch: any = await this.branchModel.findById(dto.branchId).lean();
    if (!branch) throw new NotFoundException('Branch not found');

    return this.availModel.findOneAndUpdate(
      { branchId: new Types.ObjectId(dto.branchId), weekday: dto.weekday },
      {
        $set: {
          organizationId: branch.organizationId,
          branchId: new Types.ObjectId(dto.branchId),
          weekday: dto.weekday,
          startTime: dto.startTime,
          endTime: dto.endTime,
          isWorkingDay: dto.isWorkingDay !== false,
        },
      },
      { upsert: true, new: true },
    );
  }

  async setBulkAvailability(orgOwnerId: string, dto: SetBulkAvailabilityDto) {
    await this.verifyBranchOwnership(orgOwnerId, dto.branchId);
    const branch: any = await this.branchModel.findById(dto.branchId).lean();
    if (!branch) throw new NotFoundException('Branch not found');

    const results = [];
    for (const item of dto.schedule) {
      const result = await this.availModel.findOneAndUpdate(
        { branchId: new Types.ObjectId(dto.branchId), weekday: item.weekday },
        {
          $set: {
            organizationId: branch.organizationId,
            branchId: new Types.ObjectId(dto.branchId),
            weekday: item.weekday,
            startTime: item.startTime,
            endTime: item.endTime,
            isWorkingDay: item.isWorkingDay,
          },
        },
        { upsert: true, new: true },
      );
      results.push(result);
    }
    return results;
  }

  async getAvailability(branchId: string) {
    return this.availModel.find({ branchId: new Types.ObjectId(branchId) }).sort({ weekday: 1 }).lean();
  }

  // ────────────────── BLOCKED TIME ──────────────────

  async blockTime(orgOwnerId: string, dto: BlockTimeDto) {
    await this.verifyBranchOwnership(orgOwnerId, dto.branchId);
    return this.blockedModel.create({
      branchId: new Types.ObjectId(dto.branchId),
      startAt: new Date(dto.startAt),
      endAt: new Date(dto.endAt),
      reason: dto.reason || '',
    });
  }

  async getBlockedTimes(branchId: string) {
    return this.blockedModel
      .find({ branchId: new Types.ObjectId(branchId), endAt: { $gte: new Date() } })
      .sort({ startAt: 1 })
      .lean();
  }

  async removeBlockedTime(orgOwnerId: string, blockedTimeId: string) {
    const blocked: any = await this.blockedModel.findById(blockedTimeId);
    if (!blocked) throw new NotFoundException('Blocked time not found');
    await this.verifyBranchOwnership(orgOwnerId, String(blocked.branchId));
    await this.blockedModel.deleteOne({ _id: blockedTimeId });
    return { deleted: true };
  }

  // ────────────────── DURATION RULES ──────────────────

  async setDurationRule(orgOwnerId: string, dto: SetDurationRuleDto) {
    await this.verifyBranchOwnership(orgOwnerId, dto.branchId);
    return this.durationModel.findOneAndUpdate(
      {
        providerServiceId: new Types.ObjectId(dto.providerServiceId),
        branchId: new Types.ObjectId(dto.branchId),
      },
      {
        $set: {
          durationMinutes: dto.durationMinutes,
          bufferBefore: dto.bufferBefore || 0,
          bufferAfter: dto.bufferAfter ?? 15,
        },
      },
      { upsert: true, new: true },
    );
  }

  // ────────────────── SLOT GENERATION ──────────────────

  /**
   * Generate available time slots for a given branch/date/service
   * Slots are computed dynamically from availability rules
   */
  async getAvailableSlots(branchId: string, date: string, providerServiceId: string) {
    // 1. Get service duration
    const duration = await this.getServiceDuration(branchId, providerServiceId);
    if (!duration) throw new BadRequestException('Service duration not configured');

    // 2. Parse date and get weekday
    const dateObj = new Date(date + 'T00:00:00');
    const weekday = dateObj.getDay(); // 0=Sun

    // 3. Get availability for this weekday
    const avail: any = await this.availModel.findOne({
      branchId: new Types.ObjectId(branchId),
      weekday,
    }).lean();

    if (!avail || !avail.isWorkingDay) {
      return { date, slots: [], message: 'Not a working day' };
    }

    // 4. Get blocked time ranges for this date
    const dayStart = new Date(date + 'T00:00:00');
    const dayEnd = new Date(date + 'T23:59:59');
    const blockedRanges = await this.blockedModel.find({
      branchId: new Types.ObjectId(branchId),
      startAt: { $lt: dayEnd },
      endAt: { $gt: dayStart },
    }).lean();

    // 5. Get already booked/reserved slots for this date
    const existingSlots: any[] = await this.slotModel.find({
      branchId: new Types.ObjectId(branchId),
      date,
      status: { $in: [SlotStatus.RESERVED, SlotStatus.BOOKED] },
    }).lean();

    // 6. Generate slot windows
    const totalDuration = duration.durationMinutes + duration.bufferBefore + duration.bufferAfter;
    const slots = this.generateTimeSlots(
      date,
      avail.startTime,
      avail.endTime,
      totalDuration,
      duration.durationMinutes,
      blockedRanges,
      existingSlots,
    );

    return { date, branchId, providerServiceId, durationMinutes: duration.durationMinutes, slots };
  }

  private generateTimeSlots(
    date: string,
    startTime: string,
    endTime: string,
    totalDurationMin: number,
    serviceDurationMin: number,
    blockedRanges: any[],
    existingSlots: any[],
  ) {
    const slots: any[] = [];
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);

    const workStart = new Date(`${date}T${startTime}:00`);
    const workEnd = new Date(`${date}T${endTime}:00`);
    const now = new Date();

    let cursor = new Date(workStart);

    while (cursor.getTime() + totalDurationMin * 60000 <= workEnd.getTime()) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor.getTime() + serviceDurationMin * 60000);

      // Skip past slots
      if (slotStart <= now) {
        cursor = new Date(cursor.getTime() + 30 * 60000); // 30 min step
        continue;
      }

      // Check blocked ranges
      const isBlocked = blockedRanges.some(
        (b: any) => slotStart < new Date(b.endAt) && slotEnd > new Date(b.startAt),
      );

      // Check existing bookings
      const isOccupied = existingSlots.some(
        (s: any) => slotStart < new Date(s.endAt) && slotEnd > new Date(s.startAt),
      );

      if (!isBlocked && !isOccupied) {
        slots.push({
          startAt: slotStart.toISOString(),
          endAt: slotEnd.toISOString(),
          startTime: `${String(slotStart.getHours()).padStart(2, '0')}:${String(slotStart.getMinutes()).padStart(2, '0')}`,
          endTime: `${String(slotEnd.getHours()).padStart(2, '0')}:${String(slotEnd.getMinutes()).padStart(2, '0')}`,
          durationMinutes: serviceDurationMin,
          available: true,
        });
      }

      // Step by 30 minutes
      cursor = new Date(cursor.getTime() + 30 * 60000);
    }

    return slots;
  }

  // ────────────────── RESERVE SLOT ──────────────────

  async reserveSlot(userId: string, dto: ReserveSlotDto) {
    const duration = await this.getServiceDuration(dto.branchId, dto.providerServiceId);
    if (!duration) throw new BadRequestException('Service duration not configured');

    const slotStart = new Date(`${dto.date}T${dto.startTime}:00`);
    const slotEnd = new Date(slotStart.getTime() + duration.durationMinutes * 60000);

    if (slotStart <= new Date()) {
      throw new BadRequestException('Cannot reserve a slot in the past');
    }

    // Release expired reservations first
    await this.releaseExpiredReservations();

    // Check for conflicts
    const conflict = await this.slotModel.findOne({
      branchId: new Types.ObjectId(dto.branchId),
      date: dto.date,
      status: { $in: [SlotStatus.RESERVED, SlotStatus.BOOKED] },
      $or: [
        { startAt: { $lt: slotEnd }, endAt: { $gt: slotStart } },
      ],
    });

    if (conflict) {
      throw new ConflictException('This time slot is already taken');
    }

    // Check blocked time
    const isBlocked = await this.blockedModel.findOne({
      branchId: new Types.ObjectId(dto.branchId),
      startAt: { $lt: slotEnd },
      endAt: { $gt: slotStart },
    });
    if (isBlocked) {
      throw new BadRequestException('This time is blocked by the provider');
    }

    const reservationMinutes = await this.configService.getSlotReservationMinutes();

    const slot = await this.slotModel.create({
      branchId: new Types.ObjectId(dto.branchId),
      date: dto.date,
      startAt: slotStart,
      endAt: slotEnd,
      status: SlotStatus.RESERVED,
      userId: new Types.ObjectId(userId),
      providerServiceId: new Types.ObjectId(dto.providerServiceId),
      durationMinutes: duration.durationMinutes,
      reservedUntil: new Date(Date.now() + reservationMinutes * 60000),
    });

    this.logger.log(`Slot ${slot._id} reserved for user ${userId} until ${slot.reservedUntil}`);
    return slot;
  }

  // ────────────────── CREATE BOOKING WITH SLOT ──────────────────

  async createBookingWithSlot(userId: string, dto: CreateBookingWithSlotDto) {
    const slot: any = await this.slotModel.findById(dto.slotId);
    if (!slot) throw new NotFoundException('Slot not found');
    if (String(slot.userId) !== userId) throw new BadRequestException('Slot not reserved by you');
    if (slot.status !== SlotStatus.RESERVED) {
      throw new BadRequestException('Slot is not in reserved status');
    }
    if (slot.reservedUntil && slot.reservedUntil < new Date()) {
      // Release expired slot
      slot.status = SlotStatus.RELEASED;
      await slot.save();
      throw new BadRequestException('Slot reservation expired');
    }

    const branch: any = await this.branchModel.findById(dto.branchId).lean();
    if (!branch) throw new NotFoundException('Branch not found');

    const org: any = await this.orgModel.findById(branch.organizationId).lean();
    const provService: any = await this.providerServiceModel.findById(dto.providerServiceId).lean();
    const user: any = await this.userModel.findById(userId).lean();

    // Create booking
    const booking = await this.bookingModel.create({
      userId: new Types.ObjectId(userId),
      vehicleId: dto.vehicleId ? new Types.ObjectId(dto.vehicleId) : null,
      organizationId: branch.organizationId,
      branchId: new Types.ObjectId(dto.branchId),
      providerServiceId: new Types.ObjectId(dto.providerServiceId),
      quoteId: dto.quoteId ? new Types.ObjectId(dto.quoteId) : null,
      scheduledAt: slot.startAt,
      slotId: slot._id,
      status: BookingStatus.PENDING,
      snapshot: {
        orgName: org?.name || '',
        branchName: branch?.name || '',
        branchAddress: branch?.address || '',
        serviceName: provService?.description || '',
        price: provService?.price || 0,
        customerName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
      },
      customerNotes: dto.customerNotes || '',
    });

    // Update slot to booked
    slot.status = SlotStatus.BOOKED;
    slot.bookingId = booking._id;
    slot.reservedUntil = null;
    await slot.save();

    await this.eventBus.emit(PlatformEvent.BOOKING_CREATED, {
      bookingId: String(booking._id),
      customerId: userId,
      providerId: org?.ownerId ? String(org.ownerId) : undefined,
      scheduledAt: slot.startAt,
      serviceName: provService?.description || '',
    });

    this.logger.log(`Booking ${booking._id} created with slot ${slot._id}`);
    return { booking, slot };
  }

  // ────────────────── RELEASE SLOT ──────────────────

  async releaseSlot(userId: string, slotId: string) {
    const slot: any = await this.slotModel.findById(slotId);
    if (!slot) throw new NotFoundException('Slot not found');
    if (String(slot.userId) !== userId) throw new BadRequestException('Not your slot');
    if (slot.status === SlotStatus.BOOKED) {
      throw new BadRequestException('Cannot release a booked slot, cancel the booking instead');
    }
    if (slot.status !== SlotStatus.RESERVED) {
      throw new BadRequestException('Slot is not reserved');
    }

    slot.status = SlotStatus.RELEASED;
    await slot.save();
    return { released: true };
  }

  // ────────────────── HELPERS ──────────────────

  private async releaseExpiredReservations() {
    const result = await this.slotModel.updateMany(
      {
        status: SlotStatus.RESERVED,
        reservedUntil: { $lt: new Date() },
      },
      { $set: { status: SlotStatus.RELEASED } },
    );
    if (result.modifiedCount > 0) {
      this.logger.log(`Released ${result.modifiedCount} expired reservations`);
    }
  }

  private async getServiceDuration(branchId: string, providerServiceId: string) {
    // Check custom duration rule first
    const rule: any = await this.durationModel.findOne({
      providerServiceId: new Types.ObjectId(providerServiceId),
      branchId: new Types.ObjectId(branchId),
    }).lean();

    if (rule) {
      return {
        durationMinutes: rule.durationMinutes,
        bufferBefore: rule.bufferBefore || 0,
        bufferAfter: rule.bufferAfter ?? 15,
      };
    }

    // Fallback to ProviderService.duration
    const ps: any = await this.providerServiceModel.findById(providerServiceId).lean();
    if (!ps) return null;

    return {
      durationMinutes: ps.duration || 60,
      bufferBefore: 0,
      bufferAfter: 15,
    };
  }

  private async verifyBranchOwnership(userId: string, branchId: string) {
    const branch: any = await this.branchModel.findById(branchId).lean();
    if (!branch) throw new NotFoundException('Branch not found');
    const org: any = await this.orgModel.findById(branch.organizationId).lean();
    if (!org) throw new NotFoundException('Organization not found');
    if (String(org.ownerId) !== userId) {
      throw new BadRequestException('You do not own this branch');
    }
  }
}
