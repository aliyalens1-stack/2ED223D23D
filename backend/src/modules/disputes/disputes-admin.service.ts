// Admin-only dispute actions (P0.a).
// All mutations enforce invariants:
//   I1 — every action writes an append-only DisputeAudit row.
//   I2 — resolution lock: once terminal, only `notes` are allowed.
//   I3 — state-machine transitions enforced server-side.
//   I4 — freeze-payout sets Payment.payoutFrozen + audit row.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  DisputeStatus,
  DISPUTE_TERMINAL_STATUSES,
  isDisputeTerminal,
} from './dispute.schema';
import { DisputeAuditAction } from './dispute-audit.schema';

/** Valid status transitions (from → allowed targets). Admins only. */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  [DisputeStatus.OPEN]: [
    DisputeStatus.REVIEWING,
    DisputeStatus.ESCALATED,
    DisputeStatus.RESOLVED,
    DisputeStatus.RESOLVED_PARTIAL,
    DisputeStatus.REFUNDED,
    DisputeStatus.REJECTED,
  ],
  [DisputeStatus.REVIEWING]: [
    DisputeStatus.ESCALATED,
    DisputeStatus.RESOLVED,
    DisputeStatus.RESOLVED_PARTIAL,
    DisputeStatus.REFUNDED,
    DisputeStatus.REJECTED,
  ],
  [DisputeStatus.ESCALATED]: [
    DisputeStatus.RESOLVED,
    DisputeStatus.RESOLVED_PARTIAL,
    DisputeStatus.REFUNDED,
    DisputeStatus.REJECTED,
  ],
  // Terminal statuses have no outgoing transitions — enforced by isDisputeTerminal
};

function assertValidTransition(from: string, to: string): void {
  if (from === to) {
    throw new BadRequestException(`Dispute already in status '${to}'`);
  }
  const allowed = STATUS_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw new BadRequestException(
      `Invalid status transition: ${from} → ${to}. Allowed: [${allowed.join(', ') || 'none (terminal)'}]`,
    );
  }
}

@Injectable()
export class DisputesAdminService {
  constructor(
    @InjectModel('Dispute') private readonly disputeModel: Model<any>,
    @InjectModel('DisputeAudit') private readonly auditModel: Model<any>,
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
  ) {}

  /** Append audit row. Invariant I1 — never updates, never deletes. */
  private async writeAudit(
    disputeId: Types.ObjectId,
    adminId: string,
    action: DisputeAuditAction,
    meta: Record<string, any> = {},
  ): Promise<void> {
    await this.auditModel.create({
      disputeId,
      adminId: new Types.ObjectId(adminId),
      action,
      meta,
      timestamp: new Date(),
    });
  }

  /** Load dispute or throw 404. */
  private async loadOrThrow(disputeId: string): Promise<any> {
    if (!Types.ObjectId.isValid(disputeId)) {
      throw new BadRequestException('Invalid dispute id');
    }
    const dispute: any = await this.disputeModel.findById(disputeId);
    if (!dispute) {
      throw new NotFoundException('Dispute not found');
    }
    return dispute;
  }

  /** Invariant I2 — block mutating actions on terminal disputes. */
  private assertNotTerminal(dispute: any, actionLabel: string): void {
    if (isDisputeTerminal(dispute.status)) {
      throw new ForbiddenException(
        `Cannot '${actionLabel}' — dispute is in terminal status '${dispute.status}'. Only notes are allowed.`,
      );
    }
  }

  // ── /assign — assign operator/admin to dispute ───────────────────────────
  async assign(disputeId: string, adminId: string, body: { operatorId: string; reason?: string }) {
    const dispute = await this.loadOrThrow(disputeId);
    this.assertNotTerminal(dispute, 'assign');

    if (!Types.ObjectId.isValid(body.operatorId)) {
      throw new BadRequestException('Invalid operatorId');
    }
    const operator = await this.userModel.findById(body.operatorId).lean();
    if (!operator) {
      throw new NotFoundException('Operator user not found');
    }

    const previousAssignee = dispute.assignedTo ? String(dispute.assignedTo) : null;
    dispute.assignedTo = new Types.ObjectId(body.operatorId);
    dispute.assignedAt = new Date();
    if (dispute.status === DisputeStatus.OPEN) {
      dispute.status = DisputeStatus.REVIEWING;
    }
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'assign', {
      operatorId: body.operatorId,
      previousAssignee,
      reason: body.reason || null,
    });
    return { ok: true, dispute };
  }

  // ── /evidence — admin attaches evidence note + optional attachments ──────
  async addEvidence(
    disputeId: string,
    adminId: string,
    body: { note: string; attachments?: string[]; source?: string },
  ) {
    const dispute = await this.loadOrThrow(disputeId);
    this.assertNotTerminal(dispute, 'add_evidence');

    if (!body.note || !body.note.trim()) {
      throw new BadRequestException('Evidence note required');
    }
    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: `[EVIDENCE${body.source ? ` · ${body.source}` : ''}] ${body.note}`,
      attachments: body.attachments || [],
    });
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'add_evidence', {
      noteLength: body.note.length,
      attachments: body.attachments || [],
      source: body.source || null,
    });
    return { ok: true, dispute };
  }

  // ── /request-evidence — ping party to provide evidence ───────────────────
  async requestEvidence(
    disputeId: string,
    adminId: string,
    body: { fromParty: 'customer' | 'provider' | 'both'; deadlineHours?: number; message?: string },
  ) {
    const dispute = await this.loadOrThrow(disputeId);
    this.assertNotTerminal(dispute, 'request_evidence');

    const deadlineHours = body.deadlineHours ?? 48;
    const deadline = new Date(Date.now() + deadlineHours * 60 * 60 * 1000);
    const msg = `[REQUEST-EVIDENCE → ${body.fromParty}] ${body.message || 'Please provide evidence.'} Deadline: ${deadline.toISOString()}`;

    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: msg,
    });
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'request_evidence', {
      fromParty: body.fromParty,
      deadlineHours,
      deadlineAt: deadline.toISOString(),
    });
    return { ok: true, dispute, deadlineAt: deadline };
  }

  // ── /freeze-payout — block Stripe transfer on the related payment ────────
  async freezePayout(disputeId: string, adminId: string, body: { reason: string }) {
    const dispute = await this.loadOrThrow(disputeId);
    this.assertNotTerminal(dispute, 'freeze_payout');

    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('Freeze reason required');
    }
    if (dispute.payoutFrozen) {
      throw new BadRequestException('Payout already frozen');
    }

    dispute.payoutFrozen = true;
    dispute.payoutFrozenReason = body.reason;
    dispute.payoutFrozenAt = new Date();
    dispute.payoutFrozenBy = new Types.ObjectId(adminId);
    await dispute.save();

    // Mirror flag onto Payment so orchestrator/Stripe Connect respects it.
    if (dispute.paymentId) {
      await this.paymentModel.updateOne(
        { _id: dispute.paymentId },
        {
          $set: {
            payoutFrozen: true,
            payoutFrozenReason: body.reason,
            payoutFrozenAt: new Date(),
            payoutFrozenBy: new Types.ObjectId(adminId),
          },
        },
      );
    }

    await this.writeAudit(dispute._id, adminId, 'freeze_payout', {
      reason: body.reason,
      paymentId: dispute.paymentId ? String(dispute.paymentId) : null,
    });
    return { ok: true, dispute };
  }

  // ── /warn — issue formal warning to a party ──────────────────────────────
  async warn(
    disputeId: string,
    adminId: string,
    body: { targetParty: 'customer' | 'provider'; reason: string; severity?: 'low' | 'medium' | 'high' },
  ) {
    const dispute = await this.loadOrThrow(disputeId);
    this.assertNotTerminal(dispute, 'warn');

    if (!body.reason || !body.reason.trim()) {
      throw new BadRequestException('Warning reason required');
    }
    const severity = body.severity || 'medium';

    dispute.lastWarnedAt = new Date();
    dispute.warnCount = (dispute.warnCount || 0) + 1;
    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: `[WARNING → ${body.targetParty} · severity=${severity}] ${body.reason}`,
    });
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'warn', {
      targetParty: body.targetParty,
      severity,
      reason: body.reason,
      warnCount: dispute.warnCount,
    });
    return { ok: true, dispute };
  }

  // ── PATCH /status — state-machine transition ─────────────────────────────
  async changeStatus(
    disputeId: string,
    adminId: string,
    body: { status: string; resolution?: string; refundAmount?: number },
  ) {
    const dispute = await this.loadOrThrow(disputeId);
    const from = dispute.status as string;
    const to = body.status;

    if (!Object.values(DisputeStatus).includes(to as any)) {
      throw new BadRequestException(`Unknown status '${to}'`);
    }

    // Block mutations on terminal disputes (I2)
    if (isDisputeTerminal(from)) {
      throw new ForbiddenException(
        `Cannot change status — dispute is in terminal status '${from}'.`,
      );
    }

    // Validate transition (I3)
    assertValidTransition(from, to);

    // If landing on terminal — require resolution text
    if (isDisputeTerminal(to)) {
      if (!body.resolution || !body.resolution.trim()) {
        throw new BadRequestException(
          `Transition to terminal status '${to}' requires resolution text.`,
        );
      }
      dispute.resolution = body.resolution;
      dispute.resolvedBy = new Types.ObjectId(adminId);
      dispute.resolvedAt = new Date();
    }

    dispute.status = to;

    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: `[STATUS ${from.toUpperCase()} → ${to.toUpperCase()}]${body.resolution ? ' ' + body.resolution : ''}`,
    });
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'status_change', {
      from,
      to,
      resolution: body.resolution || null,
      refundAmount: body.refundAmount ?? null,
    });
    return { ok: true, dispute };
  }

  // ── /notes — append-only. Allowed even after terminal. ───────────────────
  async addNote(disputeId: string, adminId: string, body: { note: string; visibility?: 'internal' | 'public' }) {
    const dispute = await this.loadOrThrow(disputeId);

    if (!body.note || !body.note.trim()) {
      throw new BadRequestException('Note text required');
    }
    const visibility = body.visibility || 'internal';

    dispute.messages.push({
      senderId: new Types.ObjectId(adminId),
      senderRole: 'admin',
      message: `[NOTE · ${visibility}] ${body.note}`,
    });
    await dispute.save();

    await this.writeAudit(dispute._id, adminId, 'note', {
      visibility,
      noteLength: body.note.length,
      onTerminal: isDisputeTerminal(dispute.status),
    });
    return { ok: true, dispute };
  }

  // ── /timeline — merged audit feed (read-only). ───────────────────────────
  async getTimeline(disputeId: string) {
    const dispute = await this.loadOrThrow(disputeId);
    const auditRows = await this.auditModel
      .find({ disputeId: dispute._id })
      .sort({ timestamp: 1 })
      .lean();

    // Merge dispute.messages and audit rows into a single chronological feed.
    const messages = (dispute.messages || []).map((m: any) => ({
      kind: 'message',
      at: m.createdAt || dispute.createdAt,
      senderRole: m.senderRole,
      senderId: m.senderId,
      text: m.message,
      attachments: m.attachments || [],
    }));
    const audits = auditRows.map((a: any) => ({
      kind: 'audit',
      at: a.timestamp,
      action: a.action,
      adminId: a.adminId,
      meta: a.meta,
    }));

    const timeline = [...messages, ...audits].sort(
      (a: any, b: any) => new Date(a.at).getTime() - new Date(b.at).getTime(),
    );

    return {
      disputeId: String(dispute._id),
      status: dispute.status,
      terminal: isDisputeTerminal(dispute.status),
      assignedTo: dispute.assignedTo ? String(dispute.assignedTo) : null,
      payoutFrozen: !!dispute.payoutFrozen,
      payoutFrozenReason: dispute.payoutFrozenReason || null,
      warnCount: dispute.warnCount || 0,
      terminalStatuses: DISPUTE_TERMINAL_STATUSES,
      timeline,
    };
  }
}
