import { IsMongoId, IsNumber, IsOptional, IsString } from 'class-validator';

export class RespondQuoteDto {
  @IsMongoId()
  branchId: string;

  @IsMongoId()
  providerServiceId: string;

  @IsNumber()
  price: number;

  @IsOptional()
  @IsString()
  message?: string;
}
