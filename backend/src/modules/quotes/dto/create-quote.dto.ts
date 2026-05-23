import { IsMongoId, IsOptional, IsString } from 'class-validator';

export class CreateQuoteDto {
  @IsOptional()
  @IsMongoId()
  vehicleId?: string;

  @IsOptional()
  @IsMongoId()
  requestedServiceId?: string;

  @IsOptional()
  @IsMongoId()
  serviceId?: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  cityId?: string;
}
