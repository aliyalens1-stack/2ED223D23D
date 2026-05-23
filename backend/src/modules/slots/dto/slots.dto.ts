import { IsDateString, IsMongoId, IsNumber, IsOptional, IsString, IsBoolean, IsArray, Min, Max, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SetAvailabilityDto {
  @IsMongoId()
  branchId: string;

  @IsNumber()
  @Min(0)
  @Max(6)
  weekday: number;

  @IsString()
  startTime: string; // "09:00"

  @IsString()
  endTime: string;   // "21:00"

  @IsOptional()
  @IsBoolean()
  isWorkingDay?: boolean;
}

export class ScheduleItemDto {
  @IsNumber()
  @Min(0)
  @Max(6)
  weekday: number;

  @IsString()
  startTime: string;

  @IsString()
  endTime: string;

  @IsBoolean()
  isWorkingDay: boolean;
}

export class SetBulkAvailabilityDto {
  @IsMongoId()
  branchId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleItemDto)
  schedule: ScheduleItemDto[];
}

export class BlockTimeDto {
  @IsMongoId()
  branchId: string;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

export class ReserveSlotDto {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  providerServiceId: string;

  @IsString()
  date: string; // "2026-02-15"

  @IsString()
  startTime: string; // "10:00"
}

export class CreateBookingWithSlotDto {
  @IsMongoId()
  slotId: string;

  @IsMongoId()
  branchId: string;

  @IsMongoId()
  providerServiceId: string;

  @IsOptional()
  @IsMongoId()
  vehicleId?: string;

  @IsOptional()
  @IsMongoId()
  quoteId?: string;

  @IsOptional()
  @IsString()
  customerNotes?: string;
}

export class SetDurationRuleDto {
  @IsMongoId()
  providerServiceId: string;

  @IsMongoId()
  branchId: string;

  @IsNumber()
  @Min(15)
  durationMinutes: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  bufferBefore?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  bufferAfter?: number;
}
