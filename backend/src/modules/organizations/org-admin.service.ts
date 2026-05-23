// P0.c — Admin-only org governance service.
// Invariants:
//   I1 — every mutation writes an OrgAudit row (append-only).
//   I2 — suspended/blocked orgs are excluded by matching (already enforced upstream).
//   I3 — commission override stored as customCommissionPercent; null = "use category default".
//        Clearing sets back to null — category default kicks back in automatically.
//   I4 — boost contribution is computed by ranking.service and surfaced in /performance.
//   I5 — terminal money records (paid/refunded payments) are never mutated by this service.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrganizationStatus } from '../../shared/enums';
import { ProviderType } from './organization.schema';
import { OrgAuditAction } from './org-audit.schema';
import { RankingService } from './ranking.service';
import { DynamicCommissionService } from './dynamic-commission.service';
import { PaymentStatus } from '../payments/payment.schema';

@Injectable()
export class OrgAdminService {
  // Boost score contribution constant — mirrors ranking.service BOOST_BONUS.
  // Surfaced in /performance breakdown so admin understands ranking impact.
  private readonly BOOST_BONUS = 50;

  constructor(
    @InjectModel('Organization') private readonly orgModel: Model<any>,
    @InjectModel('OrgAudit') private readonly auditModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    private readonly ranking: RankingService,
    private readonly commission: DynamicCommissionService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private async loadOrThrow(id: string): Promise<any> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid organization id');
    }
    const org: any = await this.orgModel.findById(id);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  private async writeAudit(
    orgId: Types.ObjectId,
    adminId: string,
    action: OrgAuditAction,
    meta: Record<string, any> = {},
  ): Promise<void> {
    await this.auditModel.create({
      organizationId: orgId,
      adminId: new Types.ObjectId(adminId),
      action,
      meta,
      timestamp: new Date(),
    });
  }

  // ── /verify — mark org verified + ensure status=active ───────────────────
  async verify(id: string, adminId: string, body: { reason?: string }) {
    const org = await this.loadOrThrow(id);
    if (org.isVerified && org.status === OrganizationStatus.ACTIVE) {
      throw new BadRequestException('Organization already verified and active');
    }
    const prevStatus = org.status;
    const prevVerified = org.isVerified;
    const newStatus =
      org.status === OrganizationStatus.DRAFT ||
      org.status === OrganizationStatus.PENDING_VERIFICATION
        ? OrganizationStatus.ACTIVE
        : org.status;

    // Use $set + findByIdAndUpdate to avoid re-validating unrelated legacy
    // enum fields (visibilityState, providerType) on the existing document.
    const updated: any = await this.orgModel.findByIdAndUpdate(
      id,
      { $set: { isVerified: true, verifiedAt: new Date(), status: newStatus } },
      { new: true },
    );

    await this.writeAudit(org._id, adminId, 'verify', {
      reason: body?.reason || null,
      prevStatus,
      prevVerified,
      newStatus,
    });
    return { ok: true, organization: updated };
  }

  async unverify(id: string, adminId: string, body: { reason: string }) {
    if (!body?.reason?.trim()) throw new BadRequestException('Reason required');
    const org = await this.loadOrThrow(id);
    if (!org.isVerified) throw new BadRequestException('Organization not verified');
    const updated: any = await this.orgModel.findByIdAndUpdate(
      id,
      { $set: { isVerified: false, verifiedAt: null } },
      { new: true },
    );
    await this.writeAudit(org._id, adminId, 'unverify', { reason: body.reason });
    return { ok: true, organization: updated };
  }

  // ── /suspend — operational gate. Suspended orgs excluded from matching ──
  async suspend(id: string, adminId: string, body: { reason: string; mode?: 'suspended' | 'blocked' }) {
    if (!body?.reason?.trim()) throw new BadRequestException('Suspension reason required');
    const mode = body.mode === 'blocked' ? OrganizationStatus.BLOCKED : OrganizationStatus.SUSPENDED;

    const org = await this.loadOrThrow(id);
    if (org.status === mode) {
      throw new BadRequestException(`Organization already ${mode}`);
    }
    const prevStatus = org.status;
    // $set bypasses pre-existing legacy enum validation on other fields.
    const updated: any = await this.orgModel.findByIdAndUpdate(
      id,
      {
        $set: {
          status: mode,
          // Lowercase value matches actual data convention (schema enum allows
          // legacy lowercase variants per seed data).
          visibilityState: 'SUSPENDED',
          rankScore: 0,
        },
      },
      { new: true },
    );

    await this.writeAudit(org._id, adminId, 'suspend', {
      reason: body.reason,
      mode,
      prevStatus,
    });
    return { ok: true, organization: updated };
  }

  async unsuspend(id: string, adminId: string, body: { reason?: string }) {
    const org = await this.loadOrThrow(id);
    if (org.status !== OrganizationStatus.SUSPENDED && org.status !== OrganizationStatus.BLOCKED) {
      throw new BadRequestException(`Organization is not suspended (status=${org.status})`);
    }
    const prevStatus = org.status;
    await this.orgModel.findByIdAndUpdate(id, {
      $set: { status: OrganizationStatus.ACTIVE, visibilityState: 'NORMAL' },
    });
    // Recalculate rank to bring it back into feeds.
    await this.ranking.updateOrganizationRank(String(org._id)).catch(() => undefined);
    const updated: any = await this.orgModel.findById(id).lean();

    await this.writeAudit(org._id, adminId, 'unsuspend', {
      prevStatus,
      reason: body?.reason || null,
    });
    return { ok: true, organization: updated };
  }

  // ── /boost — activate/deactivate boost. Reuses ranking.service. ──────────
  async boost(
    id: string,
    adminId: string,
    body: { activate: boolean; durationDays?: number; multiplier?: number; reason?: string },
  ) {
    const org = await this.loadOrThrow(id);

    // I2 — refuse boost on non-active orgs (suspended/blocked/draft).
    if (body.activate && org.status !== OrganizationStatus.ACTIVE) {
      throw new BadRequestException(
        `Cannot boost org with status='${org.status}'. Must be active.`,
      );
    }

    if (body.activate) {
      const durationDays = body.durationDays ?? 7;
      const multiplier = body.multiplier ?? 1.5;
      if (durationDays < 1 || durationDays > 90) {
        throw new BadRequestException('durationDays must be between 1 and 90');
      }
      if (multiplier < 1 || multiplier > 5) {
        throw new BadRequestException('multiplier must be between 1 and 5');
      }
      const result = await this.ranking.activateBoost(id, durationDays, multiplier);
      await this.writeAudit(org._id, adminId, 'boost_activate', {
        durationDays,
        multiplier,
        boostUntil: result.boostUntil,
        reason: body.reason || null,
      });
      return { ok: true, boost: result };
    }
    // Deactivate
    if (!org.isBoosted) throw new BadRequestException('Organization is not boosted');
    await this.ranking.deactivateBoost(id);
    await this.writeAudit(org._id, adminId, 'boost_deactivate', { reason: body.reason || null });
    return { ok: true, boost: { isBoosted: false } };
  }

  // ── /commission — override or clear (back to category default) ──────────
  async setCommission(
    id: string,
    adminId: string,
    body: { percent: number | null; reason?: string },
  ) {
    const org = await this.loadOrThrow(id);
    const prev = org.customCommissionPercent;

    if (body.percent === null || body.percent === undefined) {
      // CLEAR — back to category default (invariant I3)
      await this.orgModel.findByIdAndUpdate(id, { $set: { customCommissionPercent: null } });
      await this.writeAudit(org._id, adminId, 'commission_clear', {
        prevPercent: prev,
        reason: body.reason || null,
      });
      const updated: any = await this.orgModel.findById(id).lean();
      const recomputed = await this.commission.calculateCommissionRate(id);
      return { ok: true, organization: updated, effectiveRate: recomputed };
    }

    if (typeof body.percent !== 'number' || body.percent < 0 || body.percent > 50) {
      throw new BadRequestException('percent must be a number between 0 and 50');
    }
    await this.orgModel.findByIdAndUpdate(id, { $set: { customCommissionPercent: body.percent } });
    await this.writeAudit(org._id, adminId, 'commission_set', {
      prevPercent: prev,
      newPercent: body.percent,
      reason: body.reason || null,
    });
    const updated: any = await this.orgModel.findById(id).lean();
    const recomputed = await this.commission.calculateCommissionRate(id);
    return { ok: true, organization: updated, effectiveRate: recomputed };
  }

  // ── /notes — append-only admin note ─────────────────────────────────────
  async addNote(
    id: string,
    adminId: string,
    body: { note: string; visibility?: 'internal' | 'public' },
  ) {
    if (!body?.note?.trim()) throw new BadRequestException('Note text required');
    const org = await this.loadOrThrow(id);
    const visibility = body.visibility || 'internal';
    await this.writeAudit(org._id, adminId, 'note', {
      visibility,
      noteLength: body.note.length,
      note: body.note,
    });
    return { ok: true, organizationId: String(org._id), visibility };
  }

  // ── /bookings — read-only operational visibility ────────────────────────
  async getBookings(
    id: string,
    query: { status?: string; limit?: number; skip?: number },
  ) {
    const org = await this.loadOrThrow(id);
    const filter: any = { organizationId: org._id };
    if (query.status) filter.status = query.status;

    const limit = Math.min(query.limit || 50, 200);
    const skip = query.skip || 0;
    const [items, total, byStatus] = await Promise.all([
      this.bookingModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.bookingModel.countDocuments(filter),
      this.bookingModel.aggregate([
        { $match: { organizationId: org._id } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    const stats = byStatus.reduce((acc: any, s: any) => {
      acc[s._id] = s.count;
      return acc;
    }, {});
    return { total, limit, skip, items, stats };
  }

  // ── /payouts — read-only. Aggregates payments + flags frozen. ───────────
  async getPayouts(
    id: string,
    query: { status?: string; limit?: number; skip?: number },
  ) {
    const org = await this.loadOrThrow(id);
    const filter: any = { organizationId: org._id };
    if (query.status) filter.status = query.status;

    const limit = Math.min(query.limit || 50, 200);
    const skip = query.skip || 0;

    const [items, total, agg] = await Promise.all([
      this.paymentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.paymentModel.countDocuments(filter),
      this.paymentModel.aggregate([
        { $match: { organizationId: org._id } },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            totalProviderAmount: { $sum: '$providerAmount' },
            totalPlatformFee: { $sum: '$platformFee' },
          },
        },
      ]),
    ]);

    const totals = agg.reduce(
      (acc: any, s: any) => {
        acc.byStatus[s._id] = {
          count: s.count,
          totalAmount: s.totalAmount,
          providerAmount: s.totalProviderAmount,
          platformFee: s.totalPlatformFee,
        };
        if (s._id === PaymentStatus.PAID) {
          acc.lifetimeProviderAmount += s.totalProviderAmount;
          acc.lifetimePlatformFee += s.totalPlatformFee;
        }
        return acc;
      },
      { byStatus: {}, lifetimeProviderAmount: 0, lifetimePlatformFee: 0 },
    );

    // Frozen payouts visibility (I4 from P0.a interplay)
    const frozenCount = await this.paymentModel.countDocuments({
      organizationId: org._id,
      payoutFrozen: true,
    });

    return { total, limit, skip, items, totals, frozenPayoutsCount: frozenCount };
  }

  // ── /performance — read-only KPI dashboard. Boost surfaced in ranking. ──
  async getPerformance(id: string) {
    const org = await this.loadOrThrow(id);

    // Commission breakdown — surfaces customOverride vs category default
    const commission = await this.commission.calculateCommissionRate(id);

    // Bookings rollup (last 30 days)
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [bookings30d, completed30d, cancelled30d] = await Promise.all([
      this.bookingModel.countDocuments({ organizationId: org._id, createdAt: { $gte: since } }),
      this.bookingModel.countDocuments({
        organizationId: org._id,
        status: 'completed',
        createdAt: { $gte: since },
      }),
      this.bookingModel.countDocuments({
        organizationId: org._id,
        status: { $in: ['cancelled', 'no_show'] },
        createdAt: { $gte: since },
      }),
    ]);

    // Money rollup (last 30 days, paid only)
    const moneyAgg = await this.paymentModel.aggregate([
      {
        $match: {
          organizationId: org._id,
          status: PaymentStatus.PAID,
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: null,
          gross: { $sum: '$amount' },
          providerAmount: { $sum: '$providerAmount' },
          platformFee: { $sum: '$platformFee' },
          count: { $sum: 1 },
        },
      },
    ]);
    const money = moneyAgg[0] || { gross: 0, providerAmount: 0, platformFee: 0, count: 0 };

    // Ranking breakdown — boost surfaced (invariant I4)
    const boostActive =
      !!org.isBoosted && org.boostUntil && new Date(org.boostUntil) > new Date();
    const boostContribution = boostActive ? this.BOOST_BONUS * (org.boostMultiplier || 1) : 0;
    const ranking = {
      score: org.rankScore || 0,
      visibilityScore: org.visibilityScore || 0,
      visibilityState: org.visibilityState || 'NORMAL',
      boost: {
        active: boostActive,
        multiplier: org.boostMultiplier || 1,
        boostUntil: org.boostUntil || null,
        contributionToScore: boostContribution,
      },
    };

    return {
      organization: {
        id: String(org._id),
        name: org.name,
        status: org.status,
        isVerified: org.isVerified,
      },
      ratings: {
        avg: org.ratingAvg || 0,
        reviewsCount: org.reviewsCount || 0,
        isPopular: !!org.isPopular,
      },
      ranking,
      commission,
      activity: {
        lifetimeBookings: org.bookingsCount || 0,
        lifetimeCompleted: org.completedBookingsCount || 0,
        bookings30d,
        completed30d,
        cancelled30d,
        completionRate30d: bookings30d > 0 ? completed30d / bookings30d : null,
      },
      money30d: money,
      health: {
        suspiciousScore: org.suspiciousScore || 0,
        isShadowBanned: !!org.isShadowBanned,
        isShadowLimited: !!org.isShadowLimited,
        disputesCount: org.disputesCount || 0,
        avgResponseTimeMinutes: org.avgResponseTimeMinutes,
      },
    };
  }

  // ── /audit — full history of admin actions on this org ──────────────────
  async getAuditTrail(id: string, query: { limit?: number; skip?: number }) {
    const org = await this.loadOrThrow(id);
    const limit = Math.min(query.limit || 100, 500);
    const skip = query.skip || 0;
    const [rows, total] = await Promise.all([
      this.auditModel
        .find({ organizationId: org._id })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      this.auditModel.countDocuments({ organizationId: org._id }),
    ]);
    return { total, limit, skip, items: rows };
  }
}
