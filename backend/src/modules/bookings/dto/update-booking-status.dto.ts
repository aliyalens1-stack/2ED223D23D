import { IsEnum } from 'class-validator';
import { BookingStatus } from '../../../shared/enums';

export class UpdateBookingStatusDto {
  @IsEnum(BookingStatus)
  status: BookingStatus;
}
