// P0.d — Admin payouts + payments admin service.
// Implements explicit state machine (M2) with append-only audit (M1).
// Refunds are recorded as separate rows; original Payment.amount never mutated.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PayoutStatus,
  isAllowedPayoutTransition,
  isPayoutTerminal,
} from './payout.schema';
import { PaymentStatus } from './payment.schema';
import { RefundStatus } from './refund.schema';
import {
  MoneyAuditAction,
  MoneyAuditEntity,
} from './money-audit.schema';

@Injectable()
export class MoneyAdminService {
  constructor(
    @InjectModel('Payout') private readonly payoutModel: Model<any>,
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    @InjectModel('Refund') private readonly refundModel: Model<any>,
    @InjectModel('MoneyAudit') private readonly auditModel: Model<any>,
  ) {}

  // ── audit helper ─────────────────────────────────────────────────────────
  private async writeAudit(
    entity: MoneyAuditEntity,
    entityId: Types.ObjectId,
    adminId: string,
    action: MoneyAuditAction,
    meta: Record<string, any> = {},
  ) {
    await this.auditModel.create({
      entity,
      entityId,
      adminId: new Types.ObjectId(adminId),
      action,
      meta,
      timestamp: new Date(),
    });
  }

  private toOid(id: string, label = 'id'): Types.ObjectId {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException(`Invalid ${label}`);
    return new Types.ObjectId(id);
  }

  // ── PAYOUT actions ───────────────────────────────────────────────────────

  private async loadPayoutOrThrow(id: string): Promise<any> {
    const oid = this.toOid(id, 'payout id');
    const p: any = await this.payoutModel.findById(oid);
    if (!p) throw new NotFoundException('Payout not found');
    return p;
  }

  /**
   * Apply state transition. Enforces M2 state machine and never overwrites
   * lifecycle timestamps (append-only intent). Each lifecycle event sets its
   * own `*At` field exactly once.
   */
  private async transition(
    payout: any,
    to: PayoutStatus,
    adminId: string,
    extra: { reason?: string; failureReason?: string } = {},
  ) {
    const from = payout.status;
    if (isPayoutTerminal(from)) {
      throw new ForbiddenException(
        `Payout is in terminal status '${from}' — cannot transition to '${to}'.`,
      );
    }
    if (!isAllowedPayoutTransition(from, to)) {
      throw new BadRequestException(
        `Invalid payout transition: ${from} → ${to}.`,
      );
    }

    const set: Record<string, any> = { status: to };
    const now = new Date();
    if (to === PayoutStatus.APPROVED) {
      set.approvedAt = payout.approvedAt || now;
      set.approvedBy = payout.approvedBy || new Types.ObjectId(adminId);
      // Resuming from hold — clear hold meta but DO NOT erase holdAt history
      if (from === PayoutStatus.HOLD) {
        set.holdReason = null; // cleared, but holdAt timestamp stays
      }
    } else if (to === PayoutStatus.PROCESSING) {
      set.processingStartedAt = payout.processingStartedAt || now;
    } else if (to === PayoutStatus.PAID) {
      set.paidAt = payout.paidAt || now;
    } else if (to === PayoutStatus.FAILED) {
      set.failedAt = payout.failedAt || now;
      set.failureReason = extra.failureReason || 'unspecified';
    } else if (to === PayoutStatus.HOLD) {
      set.holdAt = now;
      set.holdReason = extra.reason || 'unspecified';
      set.holdBy = new Types.ObjectId(adminId);
    }

    const updated: any = await this.payoutModel.findByIdAndUpdate(
      payout._id,
      { $set: set },
      { new: true },
    );
    return { from, to, updated };
  }

  // POST /payouts/{id}/approve — only from pending or hold
  async approvePayout(id: string, adminId: string, body: { reason?: string }) {
    const p = await this.loadPayoutOrThrow(id);
    const r = await this.transition(p, PayoutStatus.APPROVED, adminId, body);
    await this.writeAudit('payout', p._id, adminId,
      r.from === PayoutStatus.HOLD ? 'payout_resume' : 'payout_approve',
      { from: r.from, to: r.to, reason: body?.reason || null },
    );
    return { ok: true, payout: r.updated };
  }

  // POST /payouts/{id}/hold — side-branch from non-terminal
  async holdPayout(id: string, adminId: string, body: { reason: string }) {
    if (!body?.reason?.trim()) throw new BadRequestException('Hold reason required');
    const p = await this.loadPayoutOrThrow(id);
    const r = await this.transition(p, PayoutStatus.HOLD, adminId, body);
    await this.writeAudit('payout', p._id, adminId, 'payout_hold', {
      from: r.from,
      reason: body.reason,
    });
    return { ok: true, payout: r.updated };
  }

  // POST /payouts/{id}/process — only from approved
  async processPayout(id: string, adminId: string, body: { mode?: 'sandbox' | 'live'; transferId?: string }) {
    const p = await this.loadPayoutOrThrow(id);
    if (p.status !== PayoutStatus.APPROVED) {
      throw new BadRequestException(
        `Cannot process payout in status='${p.status}'. Required: 'approved'.`,
      );
    }
    const r = await this.transition(p, PayoutStatus.PROCESSING, adminId);

    // Sandbox mode (default in dev): immediate-success transition processing → paid.
    // Live mode: would call Stripe Connect transfer; here we record intent only.
    const mode = body?.mode || (process.env.ENV === 'production' ? 'live' : 'sandbox');
    let finalState: any = r.updated;
    if (mode === 'sandbox') {
      // Mark paid synchronously with mock transfer id.
      const fakeTid = body?.transferId || `tr_sandbox_${p._id.toString().slice(-8)}_${Date.now()}`;
      const r2 = await this.transition(finalState, PayoutStatus.PAID, adminId);
      finalState = await this.payoutModel.findByIdAndUpdate(
        p._id,
        { $set: { stripeTransferId: fakeTid } },
        { new: true },
      );
      await this.writeAudit('payout', p._id, adminId, 'payout_process', {
        mode,
        transferId: fakeTid,
      });
      await this.writeAudit('payout', p._id, adminId, 'payout_paid', {
        mode,
        transferId: fakeTid,
      });
    } else {
      // Live: leave in 'processing' state; webhook will flip to paid/failed.
      await this.writeAudit('payout', p._id, adminId, 'payout_process', { mode });
    }
    return { ok: true, payout: finalState, mode };
  }

  // GET /payouts — list with filters
  async listPayouts(query: {
    organizationId?: string;
    status?: string;
    limit?: number;
    skip?: number;
  }) {
    const filter: any = {};
    if (query.organizationId) {
      if (!Types.ObjectId.isValid(query.organizationId)) {
        throw new BadRequestException('Invalid organizationId');
      }
      filter.organizationId = new Types.ObjectId(query.organizationId);
    }
    if (query.status) filter.status = query.status;
    const limit = Math.min(query.limit || 50, 200);
    const skip = query.skip || 0;
    const [items, total, agg] = await Promise.all([
      this.payoutModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      this.payoutModel.countDocuments(filter),
      this.payoutModel.aggregate([
        { $match: filter },
        { $group: { _id: '$status', count: { $sum: 1 }, total: { $sum: '$providerAmount' } } },
      ]),
    ]);
    const stats = agg.reduce((acc: any, r: any) => {
      acc[r._id] = { count: r.count, total: r.total };
      return acc;
    }, {});
    return { total, limit, skip, items, stats };
  }

  // GET /payouts/{id} — detail with audit trail
  async getPayout(id: string) {
    const p = await this.loadPayoutOrThrow(id);
    const audit = await this.auditModel
      .find({ entity: 'payout', entityId: p._id })
      .sort({ timestamp: 1 })
      .lean();
    return { payout: p, audit };
  }

  // ── PAYMENTS ADMIN ───────────────────────────────────────────────────────

  // POST /payments/{id}/refund
  // Invariant M1: NEVER mutates payment.amount/providerAmount. Creates a new
  // Refund row + advances payment.status to REFUNDED or PARTIALLY_REFUNDED.
  async refundPayment(
    id: string,
    adminId: string,
    body: {
      amount?: number;          // partial; defaults to full remaining
      reason: string;
      idempotencyKey?: string;  // prevents duplicate refunds
    },
  ) {
    if (!body?.reason?.trim()) throw new BadRequestException('Refund reason required');

    const oid = this.toOid(id, 'payment id');
    const payment: any = await this.paymentModel.findById(oid);
    if (!payment) throw new NotFoundException('Payment not found');

    // Only PAID or PARTIALLY_REFUNDED can be refunded.
    if (![PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED].includes(payment.status)) {
      throw new BadRequestException(
        `Cannot refund payment in status='${payment.status}'. Required: 'paid' or 'partially_refunded'.`,
      );
    }
    if (payment.status === PaymentStatus.REFUNDED) {
      throw new BadRequestException('Payment fully refunded already');
    }

    // Idempotency: if idempotencyKey provided and Refund exists with that key — return it.
    if (body.idempotencyKey) {
      const existing = await this.refundModel.findOne({ idempotencyKey: body.idempotencyKey }).lean();
      if (existing) {
        return { ok: true, refund: existing, idempotent: true };
      }
    }

    // Compute remaining refundable amount (from append-only refunds).
    const prevAgg = await this.refundModel.aggregate([
      { $match: { paymentId: payment._id, status: RefundStatus.SUCCEEDED } },
      { $group: { _id: null, refunded: { $sum: '$amount' } } },
    ]);
    const alreadyRefunded = prevAgg[0]?.refunded || 0;
    const remaining = payment.amount - alreadyRefunded;
    if (remaining <= 0) {
      throw new BadRequestException('Payment fully refunded already');
    }

    const requestedAmount =
      typeof body.amount === 'number' && body.amount > 0 ? body.amount : remaining;
    if (requestedAmount > remaining) {
      throw new BadRequestException(
        `Refund amount (${requestedAmount}) exceeds remaining refundable (${remaining})`,
      );
    }
    const kind = requestedAmount === remaining ? 'full' : 'partial';
    const idempotencyKey = body.idempotencyKey || `${id}_${Date.now()}`;

    // Create append-only refund row. Sandbox: immediate success.
    const refund: any = await this.refundModel.create({
      paymentId: payment._id,
      bookingId: payment.bookingId,
      organizationId: payment.organizationId,
      amount: requestedAmount,
      currency: payment.currency,
      reason: body.reason,
      kind,
      status: RefundStatus.SUCCEEDED,
      initiatedBy: new Types.ObjectId(adminId),
      stripeRefundId: `re_sandbox_${payment._id.toString().slice(-8)}_${Date.now()}`,
      idempotencyKey,
    });

    // Advance payment status (NEVER touches amount/providerAmount).
    const newStatus =
      requestedAmount + alreadyRefunded >= payment.amount
        ? PaymentStatus.REFUNDED
        : PaymentStatus.PARTIALLY_REFUNDED;
    await this.paymentModel.updateOne(
      { _id: payment._id },
      {
        $set: {
          status: newStatus,
          refundedAt: payment.refundedAt || new Date(),
          // keep refundId pointing at the most recent succeeded refund (legacy field)
          refundId: refund.stripeRefundId,
        },
      },
    );

    await this.writeAudit('payment', payment._id, adminId, 'refund_create', {
      refundId: String(refund._id),
      amount: requestedAmount,
      kind,
      reason: body.reason,
      newPaymentStatus: newStatus,
      idempotencyKey,
    });
    await this.writeAudit('refund', refund._id, adminId, 'refund_create', {
      paymentId: String(payment._id),
      amount: requestedAmount,
      kind,
    });

    return { ok: true, refund, paymentStatus: newStatus, kind };
  }

  // POST /payments/{id}/retry
  // For payments that failed — re-attempts by creating a new PaymentIntent.
  // Sandbox: marks as pending and returns expected next state. M1: never
  // overwrites failureReason/failedAt of the previous attempt — they remain
  // as historical record.
  async retryPayment(id: string, adminId: string, body: { reason?: string }) {
    const oid = this.toOid(id, 'payment id');
    const payment: any = await this.paymentModel.findById(oid);
    if (!payment) throw new NotFoundException('Payment not found');

    if (![PaymentStatus.FAILED, PaymentStatus.CANCELLED].includes(payment.status)) {
      throw new BadRequestException(
        `Cannot retry payment in status='${payment.status}'. Required: 'failed' or 'cancelled'.`,
      );
    }

    // Move back to PENDING for a fresh attempt. failedAt/failureReason
    // remain intact as historical record (they were set on prior fail).
    await this.paymentModel.updateOne(
      { _id: payment._id },
      {
        $set: { status: PaymentStatus.PENDING },
      },
    );
    const updated: any = await this.paymentModel.findById(oid).lean();

    await this.writeAudit('payment', payment._id, adminId, 'payment_retry', {
      from: payment.status,
      to: PaymentStatus.PENDING,
      reason: body?.reason || null,
      // Historical record preserved
      preservedFailedAt: payment.failedAt,
      preservedFailureReason: payment.failureReason,
    });

    return { ok: true, payment: updated };
  }

  // GET /payments/{id}/refunds — list of refund attempts (audit trail)
  async listPaymentRefunds(paymentId: string) {
    const oid = this.toOid(paymentId, 'payment id');
    const refunds = await this.refundModel.find({ paymentId: oid }).sort({ createdAt: -1 }).lean();
    return { paymentId, items: refunds, count: refunds.length };
  }

  // ── Helper: generate payouts from PAID payments (for tests/demo) ────────
  // Production uses scheduled aggregation; this is a manual trigger for ops.
  async generatePayoutForOrg(organizationId: string, adminId: string) {
    const oid = this.toOid(organizationId, 'organizationId');
    // Find PAID payments without a payout assignment.
    const paid = await this.paymentModel
      .find({ organizationId: oid, status: PaymentStatus.PAID, payoutFrozen: { $ne: true } })
      .lean();
    // Exclude already-included payments (any existing payout pointing to them)
    const existing = await this.payoutModel.find({ organizationId: oid }).select('paymentIds').lean();
    const usedIds = new Set(
      existing.flatMap((p: any) => (p.paymentIds || []).map((x: any) => String(x))),
    );
    const fresh = paid.filter((p: any) => !usedIds.has(String(p._id)));
    if (fresh.length === 0) {
      throw new BadRequestException('No fresh paid payments eligible for payout');
    }

    const totalAmount = fresh.reduce((s: number, p: any) => s + p.amount, 0);
    const platformFee = fresh.reduce((s: number, p: any) => s + (p.platformFee || 0), 0);
    const providerAmount = fresh.reduce((s: number, p: any) => s + (p.providerAmount || 0), 0);
    const currency = fresh[0]?.currency || 'rub';

    const payout: any = await this.payoutModel.create({
      organizationId: oid,
      paymentIds: fresh.map((p: any) => p._id),
      totalAmount,
      platformFee,
      providerAmount,
      currency,
      status: PayoutStatus.PENDING,
    });

    await this.writeAudit('payout', payout._id, adminId, 'payout_create', {
      paymentCount: fresh.length,
      totalAmount,
      providerAmount,
    });
    return { ok: true, payout };
  }
}
