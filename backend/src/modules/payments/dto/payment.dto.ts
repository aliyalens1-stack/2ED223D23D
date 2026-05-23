import { IsMongoId, IsOptional, IsString, IsNumber, Min } from 'class-validator';

export class CreatePaymentDto {
  @IsMongoId()
  bookingId: string;

  @IsOptional()
  @IsString()
  paymentMethod?: string;
}

export class ConfirmPaymentDto {
  @IsOptional()
  @IsString()
  transactionId?: string;
}

export class RefundPaymentDto {
  @IsOptional()
  @IsNumber()
  @Min(1)
  amount?: number;

  @IsOptional()
  @IsString()
  reason?: string;
}
