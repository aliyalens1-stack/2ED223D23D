import { Schema } from 'mongoose';

export const AuditSchema = new Schema(
  {
    entity: { type: String, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    actorId: { type: String, required: true, index: true },
    prev: { type: Schema.Types.Mixed, default: null },
    next: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

AuditSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
