import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AssignmentService } from '../assignment/assignment.service';
import { EventBus, PlatformEvent } from '../../shared/events';

/**
 * ExpireEngine - Критический сервис для жизни рынка
 * 
 * Задачи:
 * 1. Истекать distributions по TTL (urgency-based)
 * 2. Запускать re-distribution если никто не ответил
 * 3. Эскалация urgency при долгом ожидании
 * 4. Возврат оператору при 3х неудачных попытках
 */
@Injectable()
export class ExpireEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpireEngineService.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private readonly TICK_INTERVAL_MS = 5000; // 5 секунд
  private readonly MAX_ATTEMPTS = 3;

  // TTL по urgency (в секундах)
  private readonly TTL_MAP: Record<string, number> = {
    critical: 20,
    high: 30,
    normal: 60,
    low: 120,
  };

  constructor(
    @InjectModel('RequestDistribution') private readonly distributionModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    private readonly assignmentService: AssignmentService,
    private readonly eventBus: EventBus,
  ) {}

  onModuleInit() {
    this.startEngine();
  }

  onModuleDestroy() {
    this.stopEngine();
  }

  private startEngine() {
    this.logger.log('🔥 Expire Engine started (tick every 5s)');
    this.intervalHandle = setInterval(() => {
      this.tick().catch(err => {
        this.logger.error('Expire Engine tick error:', err);
      });
    }, this.TICK_INTERVAL_MS);
  }

  private stopEngine() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.log('Expire Engine stopped');
    }
  }

  /**
   * Main tick - runs every 5 seconds
   */
  private async tick(): Promise<void> {
    const now = new Date();

    // 1. Expire distributions that passed their TTL
    const expiredCount = await this.expireDistributions(now);

    // 2. Check requests that need re-distribution
    const redistributedCount = await this.processReDistributions(now);

    if (expiredCount > 0 || redistributedCount > 0) {
      this.logger.log(`[Tick] Expired: ${expiredCount}, Redistributed: ${redistributedCount}`);
    }
  }

  /**
   * Expire distributions that have passed their expiresAt time
   */
  private async expireDistributions(now: Date): Promise<number> {
    const result = await this.distributionModel.updateMany(
      {
        distributionStatus: { $in: ['sent', 'viewed'] },
        expiresAt: { $lt: now },
      },
      {
        $set: {
          distributionStatus: 'expired',
          respondedAt: now,
        },
      }
    );

    if (result.modifiedCount > 0) {
      // Emit events for expired distributions
      const expiredDocs = await this.distributionModel.find({
        distributionStatus: 'expired',
        respondedAt: now,
      }).select('requestId providerId');

      for (const doc of expiredDocs) {
        await this.eventBus.emit(PlatformEvent.QUOTE_EXPIRED, {
          requestId: String(doc.requestId),
          providerId: String(doc.providerId),
        });
      }
    }

    return result.modifiedCount;
  }

  /**
   * Process requests that need re-distribution
   */
  private async processReDistributions(now: Date): Promise<number> {
    let redistributedCount = 0;

    // Find requests where all distributions are expired/ignored but no selected
    const requestsToCheck = await this.distributionModel.aggregate([
      {
        $match: {
          distributionStatus: { $in: ['expired', 'ignored', 'rejected'] },
        },
      },
      {
        $group: {
          _id: '$requestId',
          maxAttempt: { $max: '$attemptNumber' },
          totalDistributions: { $sum: 1 },
        },
      },
      {
        $match: {
          maxAttempt: { $lt: this.MAX_ATTEMPTS },
        },
      },
    ]);

    for (const req of requestsToCheck) {
      const requestId = String(req._id);

      // Check if already has a selected distribution
      const hasSelected = await this.distributionModel.findOne({
        requestId: req._id,
        distributionStatus: 'selected',
      });

      if (hasSelected) continue;

      // Check if has any active distributions
      const hasActive = await this.distributionModel.findOne({
        requestId: req._id,
        distributionStatus: { $in: ['sent', 'viewed'] },
      });

      if (hasActive) continue;

      // Check quote is still active
      const quote = await this.quoteModel.findById(requestId);
      if (!quote || quote.status === 'accepted' || quote.status === 'cancelled' || quote.status === 'expired') {
        continue;
      }

      // Re-distribute!
      const success = await this.redistribute(requestId, req.maxAttempt + 1);
      if (success) {
        redistributedCount++;
      }
    }

    return redistributedCount;
  }

  /**
   * Re-distribute request to next batch of providers
   */
  async redistribute(requestId: string, attemptNumber: number): Promise<boolean> {
    try {
      // Get already distributed provider IDs
      const previousDistributions = await this.distributionModel.find({
        requestId: new Types.ObjectId(requestId),
      }).select('providerId');

      const distributedIds = previousDistributions.map(d => String(d.providerId));

      // Get new candidates excluding already distributed
      const allCandidates = await this.assignmentService.findMatchingCandidates(requestId, 10);
      const newCandidates = allCandidates.filter(c => !distributedIds.includes(c.providerId) && c.isOnline);

      if (newCandidates.length === 0) {
        // No more candidates - escalate to operator
        await this.escalateToOperator(requestId);
        return false;
      }

      // Get quote urgency (or escalate it)
      const quote = await this.quoteModel.findById(requestId);
      const currentUrgency = quote?.urgency || 'normal';
      const newUrgency = this.escalateUrgency(currentUrgency, attemptNumber);

      // Calculate new TTL
      const ttlSeconds = this.TTL_MAP[newUrgency] || 60;
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      // Distribute to next 3
      const topCandidates = newCandidates.slice(0, 3);

      for (const candidate of topCandidates) {
        await this.distributionModel.create({
          requestId: new Types.ObjectId(requestId),
          providerId: new Types.ObjectId(candidate.providerId),
          matchingScore: candidate.matchingScore,
          visibilityScoreSnapshot: candidate.visibilityScore,
          behavioralScoreSnapshot: candidate.behavioralScore,
          distanceKm: candidate.distanceKm,
          etaMinutes: candidate.etaMinutes,
          reasons: candidate.reasons,
          urgency: newUrgency,
          expiresAt,
          attemptNumber,
          distributionStatus: 'sent',
          sentAt: now,
          distributedBy: 'system',
        });

        // Emit event
        await this.eventBus.emit(PlatformEvent.QUOTE_DISTRIBUTED, {
          requestId,
          providerId: candidate.providerId,
          urgency: newUrgency,
          attempt: attemptNumber,
        });
      }

      // Update quote urgency
      if (newUrgency !== currentUrgency) {
        await this.quoteModel.updateOne(
          { _id: requestId },
          { $set: { urgency: newUrgency } }
        );
      }

      this.logger.log(`[ReDistribute] Request ${requestId} → attempt ${attemptNumber}, urgency: ${newUrgency}, providers: ${topCandidates.length}`);
      return true;

    } catch (error) {
      this.logger.error(`[ReDistribute] Failed for ${requestId}:`, error);
      return false;
    }
  }

  /**
   * Escalate urgency based on attempt number
   */
  private escalateUrgency(current: string, attempt: number): string {
    if (attempt >= 3) return 'critical';
    if (attempt >= 2) return 'high';
    return current;
  }

  /**
   * Escalate request to operator when no providers respond
   */
  private async escalateToOperator(requestId: string): Promise<void> {
    this.logger.warn(`[Escalate] Request ${requestId} → operator (no available providers)`);

    await this.quoteModel.updateOne(
      { _id: requestId },
      {
        $set: {
          escalatedToOperator: true,
          escalatedAt: new Date(),
          escalationReason: 'no_available_providers',
        },
      }
    );

    // Emit event
    await this.eventBus.emit(PlatformEvent.QUOTE_ESCALATED, {
      requestId,
      reason: 'no_available_providers',
    });
  }

  /**
   * Calculate expiresAt for a new distribution
   */
  calculateExpiresAt(urgency: string): Date {
    const ttlSeconds = this.TTL_MAP[urgency] || 60;
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  /**
   * Manual trigger for testing
   */
  async triggerTick(): Promise<{ expired: number; redistributed: number }> {
    const now = new Date();
    const expired = await this.expireDistributions(now);
    const redistributed = await this.processReDistributions(now);
    return { expired, redistributed };
  }
}
