import { IsEnum, IsMongoId, IsOptional, IsString, MinLength } from 'class-validator';
import { DisputeReason } from '../dispute.schema';

export class CreateDisputeDto {
  @IsMongoId()
  bookingId: string;

  @IsEnum(DisputeReason)
  reason: DisputeReason;

  @IsString()
  @MinLength(10)
  description: string;
}

export class AddMessageDto {
  @IsString()
  @MinLength(1)
  message: string;
}

export class ResolveDisputeDto {
  @IsString()
  resolution: string;

  @IsOptional()
  @IsString()
  status?: 'resolved' | 'rejected';
}
