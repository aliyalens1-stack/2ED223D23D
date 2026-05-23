import { IsString, IsOptional, IsNumber, IsBoolean, IsEnum, Min, Max, ValidateIf } from 'class-validator';

export enum QuickServiceType {
  ENGINE_WONT_START = 'engine_wont_start',
  OIL_CHANGE = 'oil_change',
  BRAKES = 'brakes',
  DIAGNOSTICS = 'diagnostics',
  URGENT = 'urgent',
  SUSPENSION = 'suspension',
  ELECTRICAL = 'electrical',
  OTHER = 'other',
}

/**
 * Sprint 14 — unified contract:
 * Mobile sends `serviceType`; web-app sends `problem`.
 * Both are accepted; controller normalises `problem` → `serviceType`
 * before passing the DTO to the service.
 */
export class QuickRequestDto {
  // serviceType is the canonical field. ValidateIf skips enum check when
  // only `problem` is sent — the controller will fill serviceType from it.
  @ValidateIf((o) => o.serviceType !== undefined && o.serviceType !== null && o.serviceType !== '')
  @IsEnum(QuickServiceType)
  serviceType?: QuickServiceType;

  // Web-app legacy alias. The controller maps `problem` → `serviceType`.
  @IsOptional()
  @IsString()
  problem?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  urgent?: boolean;

  @IsOptional()
  @IsBoolean()
  mobileRequired?: boolean;
}
