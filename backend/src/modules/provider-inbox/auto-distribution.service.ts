import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AssignmentService } from '../assignment/assignment.service';
import { EventBus, PlatformEvent } from '../../shared/events';

// TTL по urgency (в секундах)
const TTL_MAP: Record<string, number> = {
  critical: 20,
  high: 30,
  normal: 60,
  low: 120,
};

@Injectable()
export class AutoDistributionService {
  constructor(
    @InjectModel('RequestDistribution') private readonly distributionModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    private readonly assignmentService: AssignmentService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Calculate expiresAt based on urgency
   */
  private calculateExpiresAt(urgency: string): Date {
    const ttlSeconds = TTL_MAP[urgency] || 60;
    return new Date(Date.now() + ttlSeconds * 1000);
  }

  /**
   * Auto-distribute a request to top N matching providers
   * Called automatically when a quick request is created
   */
  async autoDistribute(requestId: string, count = 3, urgency = 'normal'): Promise<any[]> {
    // Get matching candidates
    const candidates = await this.assignmentService.findMatchingCandidates(requestId, count * 2);
    
    if (candidates.length === 0) {
      console.log(`[AutoDistribute] No candidates found for request ${requestId}`);
      return [];
    }

    // Filter only online and accepting quick requests
    const availableCandidates = candidates.filter(c => c.isOnline);
    
    // Take top N
    const topCandidates = availableCandidates.slice(0, count);
    
    console.log(`[AutoDistribute] Distributing request ${requestId} to ${topCandidates.length} providers`);

    const distributions = [];
    for (const candidate of topCandidates) {
      // Check if already distributed
      const existing = await this.distributionModel.findOne({
        requestId: new Types.ObjectId(requestId),
        providerId: new Types.ObjectId(candidate.providerId),
      });
      
      if (existing) continue;

      // Calculate expiration time
      const expiresAt = this.calculateExpiresAt(urgency);

      const distribution = await this.distributionModel.create({
        requestId: new Types.ObjectId(requestId),
        providerId: new Types.ObjectId(candidate.providerId),
        matchingScore: candidate.matchingScore,
        visibilityScoreSnapshot: candidate.visibilityScore,
        behavioralScoreSnapshot: candidate.behavioralScore,
        distanceKm: candidate.distanceKm,
        etaMinutes: candidate.etaMinutes,
        reasons: candidate.reasons,
        urgency,
        expiresAt,
        attemptNumber: 1,
        distributionStatus: 'sent',
        sentAt: new Date(),
        distributedBy: 'auto',
      });

      distributions.push({
        distributionId: String(distribution._id),
        providerId: candidate.providerId,
        providerName: candidate.providerName,
        matchingScore: candidate.matchingScore,
        distanceKm: candidate.distanceKm,
        etaMinutes: candidate.etaMinutes,
      });

      // Emit event for provider notification
      await this.eventBus.emit(PlatformEvent.QUOTE_DISTRIBUTED, {
        requestId,
        providerId: candidate.providerId,
        distributionId: String(distribution._id),
        urgency: 'high', // For quick requests
      });
    }

    // Update request status
    await this.quoteModel.updateOne(
      { _id: requestId },
      { status: 'in_review' }
    );

    return distributions;
  }

  /**
   * Expire old distributions (called by cron or manually)
   */
  async expireStaleDistributions(): Promise<number> {
    const now = new Date();
    
    // Find distributions that should expire
    // Critical: 20s, High: 30s, Normal: 60s, Low: 120s
    // For simplicity, expire anything older than 2 minutes
    const expireThreshold = new Date(now.getTime() - 2 * 60 * 1000);

    const result = await this.distributionModel.updateMany(
      {
        distributionStatus: { $in: ['sent', 'viewed'] },
        sentAt: { $lt: expireThreshold },
      },
      {
        distributionStatus: 'expired',
        respondedAt: now,
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[AutoDistribute] Expired ${result.modifiedCount} stale distributions`);
    }

    return result.modifiedCount;
  }

  /**
   * Re-distribute request if no one responded
   */
  async redistributeIfNeeded(requestId: string): Promise<boolean> {
    // Check if anyone accepted
    const selected = await this.distributionModel.findOne({
      requestId: new Types.ObjectId(requestId),
      distributionStatus: 'selected',
    });

    if (selected) return false; // Already has winner

    // Check current distributions
    const currentDistributions = await this.distributionModel.find({
      requestId: new Types.ObjectId(requestId),
    });

    const activeDistributions = currentDistributions.filter(
      d => d.distributionStatus === 'sent' || d.distributionStatus === 'viewed'
    );

    // If all expired/rejected, redistribute to next batch
    if (activeDistributions.length === 0 && currentDistributions.length > 0) {
      console.log(`[AutoDistribute] Re-distributing request ${requestId}`);
      
      // Get already distributed provider IDs
      const distributedIds = currentDistributions.map(d => String(d.providerId));
      
      // Get new candidates excluding already distributed
      const allCandidates = await this.assignmentService.findMatchingCandidates(requestId, 10);
      const newCandidates = allCandidates.filter(c => !distributedIds.includes(c.providerId));

      if (newCandidates.length > 0) {
        // Distribute to next 3
        for (const candidate of newCandidates.slice(0, 3)) {
          await this.distributionModel.create({
            requestId: new Types.ObjectId(requestId),
            providerId: new Types.ObjectId(candidate.providerId),
            matchingScore: candidate.matchingScore,
            visibilityScoreSnapshot: candidate.visibilityScore,
            behavioralScoreSnapshot: candidate.behavioralScore,
            distanceKm: candidate.distanceKm,
            etaMinutes: candidate.etaMinutes,
            reasons: candidate.reasons,
            distributionStatus: 'sent',
            sentAt: new Date(),
            distributedBy: 'system',
          });
        }
        return true;
      }
    }

    return false;
  }
}
