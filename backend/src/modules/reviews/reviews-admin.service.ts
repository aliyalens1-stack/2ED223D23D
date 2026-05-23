// P0.d — Reviews moderation service.
// Invariant M3: exclude-rating MUST NOT mutate review content (rating/comment).
// It only sets `excludedFromReputation: true` and triggers org rating recompute.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

@Injectable()
export class ReviewsAdminService {
  constructor(
    @InjectModel('Review') private readonly reviewModel: Model<any>,
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('MoneyAudit') private readonly auditModel: Model<any>,
  ) {}

  private toOid(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label}`);
    return new Types.ObjectId(id);
  }

  private async loadOrThrow(id: string): Promise<any> {
    const r: any = await this.reviewModel.findById(this.toOid(id, 'review id'));
    if (!r) throw new NotFoundException('Review not found');
    return r;
  }

  /**
   * Recompute org ratingAvg/reviewsCount excluding `excludedFromReputation`
   * reviews. Idempotent — safe to run after any flag toggle.
   */
  private async recomputeOrgRating(orgId: Types.ObjectId): Promise<{ avg: number; count: number }> {
    const agg = await this.reviewModel.aggregate([
      {
        $match: {
          organizationId: orgId,
          excludedFromReputation: { $ne: true },
          status: { $ne: 'hidden' },
        },
      },
      {
        $group: {
          _id: null,
          avg: { $avg: '$rating' },
          count: { $sum: 1 },
        },
      },
    ]);
    const avg = agg[0]?.avg ? Math.round(agg[0].avg * 100) / 100 : 0;
    const count = agg[0]?.count || 0;
    await this.orgModel.updateOne(
      { _id: orgId },
      { $set: { ratingAvg: avg, reviewsCount: count } },
    );
    return { avg, count };
  }

  // POST /reviews/{id}/flag — set status=flagged + reason. Does NOT change rating.
  async flag(id: string, adminId: string, body: { reason: string }) {
    if (!body?.reason?.trim()) throw new BadRequestException('Flag reason required');
    const review = await this.loadOrThrow(id);
    if (review.status === 'flagged') {
      throw new BadRequestException('Review already flagged');
    }
    const prevStatus = review.status;
    await this.reviewModel.updateOne(
      { _id: review._id },
      {
        $set: {
          status: 'flagged',
          flagReason: body.reason,
          flaggedAt: new Date(),
          flaggedBy: new Types.ObjectId(adminId),
        },
      },
    );
    await this.auditModel.create({
      entity: 'review',
      entityId: review._id,
      adminId: new Types.ObjectId(adminId),
      action: 'review_flag',
      meta: { prevStatus, reason: body.reason },
      timestamp: new Date(),
    });
    const updated: any = await this.reviewModel.findById(review._id).lean();
    return { ok: true, review: updated };
  }

  // POST /reviews/{id}/restore — set status=active. Does NOT change excludedFromReputation.
  async restore(id: string, adminId: string, body: { reason?: string }) {
    const review = await this.loadOrThrow(id);
    if (review.status === 'active') {
      throw new BadRequestException('Review already active');
    }
    const prevStatus = review.status;
    await this.reviewModel.updateOne(
      { _id: review._id },
      {
        $set: { status: 'active' },
        $unset: { flagReason: '', flaggedAt: '', flaggedBy: '' },
      },
    );
    await this.auditModel.create({
      entity: 'review',
      entityId: review._id,
      adminId: new Types.ObjectId(adminId),
      action: 'review_restore',
      meta: { prevStatus, reason: body?.reason || null },
      timestamp: new Date(),
    });
    const updated: any = await this.reviewModel.findById(review._id).lean();
    return { ok: true, review: updated };
  }

  // POST /reviews/{id}/exclude-rating — set excludedFromReputation flag + recompute org rating.
  // Body: { exclude: true|false, reason: string }.
  // Invariant M3: NEVER mutates review.rating or review.comment.
  async excludeRating(
    id: string,
    adminId: string,
    body: { exclude: boolean; reason: string },
  ) {
    if (typeof body?.exclude !== 'boolean') {
      throw new BadRequestException('Body.exclude must be boolean');
    }
    if (!body?.reason?.trim()) {
      throw new BadRequestException('Reason required');
    }
    const review = await this.loadOrThrow(id);
    if (!!review.excludedFromReputation === !!body.exclude) {
      throw new BadRequestException(
        `Review excludedFromReputation already = ${body.exclude}`,
      );
    }

    const prevExcluded = !!review.excludedFromReputation;
    const set: any = {
      excludedFromReputation: body.exclude,
      excludedReason: body.exclude ? body.reason : null,
    };
    if (body.exclude) {
      set.excludedAt = new Date();
      set.excludedBy = new Types.ObjectId(adminId);
    } else {
      set.excludedAt = null;
      set.excludedBy = null;
    }
    await this.reviewModel.updateOne({ _id: review._id }, { $set: set });

    const ratingSnapshot = { rating: review.rating, comment: review.comment };
    const recomputed = await this.recomputeOrgRating(review.organizationId);

    await this.auditModel.create({
      entity: 'review',
      entityId: review._id,
      adminId: new Types.ObjectId(adminId),
      action: body.exclude ? 'review_exclude_rating' : 'review_include_rating',
      meta: {
        prevExcluded,
        reason: body.reason,
        // Invariant M3 audit guarantee — snapshot of unchanged content.
        ratingSnapshot,
        orgRecomputed: recomputed,
      },
      timestamp: new Date(),
    });
    const updated: any = await this.reviewModel.findById(review._id).lean();
    return { ok: true, review: updated, orgRecomputed: recomputed };
  }

  // GET /reviews — list with admin filters
  async list(query: {
    organizationId?: string;
    status?: string;
    excludedFromReputation?: boolean;
    limit?: number;
    skip?: number;
  }) {
    const filter: any = {};
    if (query.organizationId) filter.organizationId = this.toOid(query.organizationId, 'organizationId');
    if (query.status) filter.status = query.status;
    if (typeof query.excludedFromReputation === 'boolean') {
      filter.excludedFromReputation = query.excludedFromReputation;
    }
    const limit = Math.min(query.limit || 50, 200);
    const skip = query.skip || 0;
    const [items, total] = await Promise.all([
      this.reviewModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.reviewModel.countDocuments(filter),
    ]);
    return { total, limit, skip, items };
  }

  // GET /reviews/{id}/audit
  async audit(id: string) {
    const review = await this.loadOrThrow(id);
    const rows = await this.auditModel
      .find({ entity: 'review', entityId: review._id })
      .sort({ timestamp: 1 })
      .lean();
    return {
      reviewId: String(review._id),
      currentStatus: review.status,
      excludedFromReputation: !!review.excludedFromReputation,
      audit: rows,
    };
  }
}
