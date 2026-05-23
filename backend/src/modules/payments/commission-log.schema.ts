import { Schema } from 'mongoose';

/**
 * Commission Log Schema
 * Зберігає історію розрахунків комісій для аналітики та аудиту
 */
export const CommissionLogSchema = new Schema(
  {
    providerId: { type: String, required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', index: true },
    
    // Розрахунок
    base: { type: Number, required: true },
    final: { type: Number, required: true },
    
    // Модифікатори (JSON)
    modifiers: [{
      name: { type: String },
      value: { type: Number },
      reason: { type: String },
    }],
    
    // Timestamps
    calculatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Indexes для швидкого пошуку
CommissionLogSchema.index({ providerId: 1, calculatedAt: -1 });
CommissionLogSchema.index({ bookingId: 1 });
