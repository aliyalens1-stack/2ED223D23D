import { Schema, model } from 'mongoose';
import { UserRole } from '../../shared/enums';

export const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.CUSTOMER,
      index: true,
    },
    firstName: { type: String, default: '' },
    lastName: { type: String, default: '' },
    phone: { type: String, default: '', sparse: true },
    isActive: { type: Boolean, default: true, index: true },
    // For provider users - link to organization
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
  },
  { timestamps: true },
);
