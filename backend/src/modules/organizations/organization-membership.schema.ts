import { Schema } from 'mongoose';
import { MembershipStatus, StaffRole } from '../../shared/enums';

export const OrganizationMembershipSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    role: {
      type: String,
      enum: Object.values(StaffRole),
      default: StaffRole.OWNER,
    },
    status: {
      type: String,
      enum: Object.values(MembershipStatus),
      default: MembershipStatus.ACTIVE,
      index: true,
    },
  },
  { timestamps: true },
);

OrganizationMembershipSchema.index({ userId: 1, organizationId: 1 }, { unique: true });
