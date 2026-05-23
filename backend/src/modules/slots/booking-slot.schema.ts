import { Schema } from 'mongoose';

/**
 * Booking Slot — concrete time window reserved/booked by customer
 */
export enum SlotStatus {
  AVAILABLE = 'available',
  RESERVED = 'reserved',  // Temporary hold (15 min)
  BOOKED = 'booked',      // Confirmed booking
  BLOCKED = 'blocked',    // Admin/provider blocked
  RELEASED = 'released',  // Released after timeout or cancel
  COMPLETED = 'completed',
}

export const BookingSlotSchema = new Schema(
  {
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    date: { type: String, required: true, index: true }, // "2026-02-15"
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(SlotStatus),
      default: SlotStatus.RESERVED,
      index: true,
    },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    providerServiceId: { type: Schema.Types.ObjectId, ref: 'ProviderService', default: null },
    durationMinutes: { type: Number, required: true },
    reservedUntil: { type: Date, default: null }, // TTL for reserved status
  },
  { timestamps: true },
);

BookingSlotSchema.index({ branchId: 1, date: 1, startAt: 1 });
BookingSlotSchema.index({ status: 1, reservedUntil: 1 });
