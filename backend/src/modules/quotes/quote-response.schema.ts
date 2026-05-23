import { Schema } from 'mongoose';

export const QuoteResponseSchema = new Schema(
  {
    quoteId: { type: Schema.Types.ObjectId, ref: 'Quote', required: true, index: true },
    providerId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
    providerServiceId: {
      type: Schema.Types.ObjectId,
      ref: 'ProviderService',
      required: true,
      index: true,
    },
    price: { type: Number, required: true },
    message: { type: String, default: '' },
    isSelected: { type: Boolean, default: false, index: true },
  },
  { timestamps: true },
);
