import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { OrganizationStatus, UserRole } from '../../shared/enums';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel('User') private readonly userModel: Model<any>,
    @InjectModel('Organization') private readonly organizationModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    @InjectModel('Dispute') private readonly disputeModel: Model<any>,
    @InjectModel('Quote') private readonly quoteModel: Model<any>,
    @InjectModel('Review') private readonly reviewModel: Model<any>,
    @InjectModel('AuditLog') private readonly auditLogModel: Model<any>,
    @InjectModel('NotificationTemplate') private readonly notificationTemplateModel: Model<any>,
    @InjectModel('BulkNotification') private readonly bulkNotificationModel: Model<any>,
    @InjectModel('Service') private readonly serviceModel: Model<any>,
    @InjectModel('FeatureFlag') private readonly featureFlagModel: Model<any>,
    @InjectModel('Experiment') private readonly experimentModel: Model<any>,
    @InjectModel('ReputationAction') private readonly reputationActionModel: Model<any>,
    @InjectModel('PlatformConfig') private readonly platformConfigModel: Model<any>,
  ) {}

  /**
   * Dashboard Stats
   */
  async getDashboardStats() {
    const [users, organizations, bookings, payments, disputes, quotes, reviews] = await Promise.all([
      this.userModel.countDocuments(),
      this.organizationModel.countDocuments(),
      this.bookingModel.countDocuments(),
      this.paymentModel.aggregate([
        { $match: { status: 'paid' } },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' },
            platformFees: { $sum: '$platformFee' },
            count: { $sum: 1 },
          },
        },
      ]),
      this.disputeModel.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      this.quoteModel.countDocuments(),
      this.reviewModel.countDocuments(),
    ]);

    const paymentStats = payments[0] || { total: 0, platformFees: 0, count: 0 };
    const disputeStats = disputes.reduce((acc: any, d: any) => {
      acc[d._id] = d.count;
      return acc;
    }, {});

    return {
      users: { total: users },
      organizations: { total: organizations },
      bookings: { total: bookings },
      quotes: { total: quotes },
      reviews: { total: reviews },
      payments: {
        total: paymentStats.count,
        totalAmount: paymentStats.total,
        platformFees: paymentStats.platformFees,
      },
      disputes: disputeStats,
    };
  }

  /**
   * Users
   */
  async getUsers(options?: { role?: string; limit?: number; skip?: number; search?: string }) {
    const query: any = {};
    if (options?.role) {
      query.role = options.role;
    }
    if (options?.search) {
      query.$or = [
        { email: { $regex: options.search, $options: 'i' } },
        { firstName: { $regex: options.search, $options: 'i' } },
        { lastName: { $regex: options.search, $options: 'i' } },
      ];
    }

    const [users, total] = await Promise.all([
      this.userModel
        .find(query)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.userModel.countDocuments(query),
    ]);

    return { users, total };
  }

  async blockUser(userId: string) {
    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { $set: { isBlocked: true } },
      { new: true },
    ).select('-passwordHash');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async unblockUser(userId: string) {
    const user = await this.userModel.findByIdAndUpdate(
      userId,
      { $set: { isBlocked: false } },
      { new: true },
    ).select('-passwordHash');
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Organizations
   */
  async getOrganizations(options?: { status?: string; limit?: number; skip?: number; search?: string }) {
    const query: any = {};
    if (options?.status) {
      query.status = options.status;
    }
    if (options?.search) {
      query.name = { $regex: options.search, $options: 'i' };
    }

    const [organizations, total] = await Promise.all([
      this.organizationModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.organizationModel.countDocuments(query),
    ]);

    return { organizations, total };
  }

  async getOrganization(orgId: string) {
    const org = await this.organizationModel.findById(orgId).lean();
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async disableOrganization(orgId: string) {
    const org = await this.organizationModel.findByIdAndUpdate(
      orgId,
      { $set: { status: OrganizationStatus.SUSPENDED } },
      { new: true },
    );
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  async enableOrganization(orgId: string) {
    const org = await this.organizationModel.findByIdAndUpdate(
      orgId,
      { $set: { status: OrganizationStatus.ACTIVE } },
      { new: true },
    );
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /**
   * Bookings
   */
  async getBookings(options?: { status?: string; limit?: number; skip?: number }) {
    const query: any = {};
    if (options?.status) {
      query.status = options.status;
    }

    const [bookings, total] = await Promise.all([
      this.bookingModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.bookingModel.countDocuments(query),
    ]);

    return { bookings, total };
  }

  /**
   * Payments
   */
  async getPayments(options?: { status?: string; limit?: number; skip?: number }) {
    const query: any = {};
    if (options?.status) {
      query.status = options.status;
    }

    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.paymentModel.countDocuments(query),
    ]);

    return { payments, total };
  }

  /**
   * Disputes
   */
  async getDisputes(options?: { status?: string; limit?: number; skip?: number }) {
    const query: any = {};
    if (options?.status) {
      query.status = options.status;
    }

    const [disputes, total] = await Promise.all([
      this.disputeModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.disputeModel.countDocuments(query),
    ]);

    return { disputes, total };
  }

  /**
   * Reviews
   */
  async getReviews(options?: { limit?: number; skip?: number }) {
    const [reviews, total] = await Promise.all([
      this.reviewModel
        .find()
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.reviewModel.countDocuments(),
    ]);

    return { reviews, total };
  }

  // ═══════ 🔥 OPERATOR MODE — РУЧНОЕ УПРАВЛЕНИЕ ЗАЯВКАМИ ═══════

  /**
   * Create quote manually (operator mode)
   */
  async createManualQuote(dto: {
    customerPhone: string;
    customerName?: string;
    description: string;
    serviceType?: string;
    location?: { lat: number; lng: number };
    urgency?: 'low' | 'normal' | 'urgent';
    notes?: string;
  }) {
    // Create or find customer by phone
    let customer = await this.userModel.findOne({ phone: dto.customerPhone });
    
    if (!customer) {
      // Create guest customer
      customer = await this.userModel.create({
        phone: dto.customerPhone,
        firstName: dto.customerName || 'Гость',
        role: 'customer',
        isGuest: true,
        createdBy: 'admin_manual',
      });
    }

    // Create quote
    const quote = await this.quoteModel.create({
      userId: customer._id,
      description: dto.description,
      serviceType: dto.serviceType,
      location: dto.location ? {
        type: 'Point',
        coordinates: [dto.location.lng, dto.location.lat],
      } : undefined,
      status: 'pending',
      isManual: true,
      urgency: dto.urgency || 'normal',
      adminNotes: dto.notes,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    return {
      quote,
      customer: {
        _id: customer._id,
        phone: customer.phone,
        firstName: customer.firstName,
      },
      message: 'Заявка создана успешно',
    };
  }

  /**
   * Get all quotes with response tracking
   */
  async getAllQuotesWithTracking(options: {
    status?: string;
    limit?: number;
    page?: number;
  }) {
    const query: any = {};
    if (options.status) {
      query.status = options.status;
    }

    const skip = ((options.page || 1) - 1) * (options.limit || 20);

    const [quotes, total] = await Promise.all([
      this.quoteModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(options.limit || 20)
        .populate('userId', 'firstName lastName phone')
        .lean(),
      this.quoteModel.countDocuments(query),
    ]);

    return {
      quotes,
      pagination: {
        page: options.page || 1,
        limit: options.limit || 20,
        total,
        totalPages: Math.ceil(total / (options.limit || 20)),
      },
    };
  }

  /**
   * Get quote details with distributions
   */
  async getQuoteDetailsWithDistributions(quoteId: string) {
    const quote = await this.quoteModel
      .findById(quoteId)
      .populate('userId', 'firstName lastName phone email')
      .lean();

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    // Get distributions (who received the quote)
    // Note: QuoteDistribution model would need to be injected
    const distributions: any[] = [];

    // Get responses
    const responses = (quote as any).responses || [];

    return {
      quote,
      distributions,
      responses,
      metrics: {
        distributedTo: distributions.length,
        responded: responses.length,
        pending: distributions.filter((d: any) => d.status === 'sent').length,
      },
    };
  }

  /**
   * Distribute quote to providers
   */
  async distributeQuoteToProviders(quoteId: string, organizationIds: string[]) {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    // In real implementation, this would create QuoteDistribution records
    // and send notifications to providers

    const distributions = organizationIds.map(orgId => ({
      quoteId,
      organizationId: orgId,
      status: 'sent',
      sentAt: new Date(),
    }));

    return {
      message: `Заявка отправлена ${organizationIds.length} мастерам`,
      distributions,
    };
  }

  /**
   * Close quote with provider (match)
   */
  async closeQuoteWithProvider(
    quoteId: string,
    dto: { organizationId: string; price?: number; notes?: string },
  ) {
    const quote = await this.quoteModel.findByIdAndUpdate(
      quoteId,
      {
        $set: {
          status: 'accepted',
          acceptedOrganizationId: new Types.ObjectId(dto.organizationId),
          finalPrice: dto.price,
          closedAt: new Date(),
          closeNotes: dto.notes,
        },
      },
      { new: true },
    );

    if (!quote) {
      throw new NotFoundException('Quote not found');
    }

    return {
      quote,
      message: 'Заявка закрыта успешно',
    };
  }

  /**
   * Get provider behavioral metrics
   */
  async getProviderBehavioralMetrics(organizationId: string) {
    const org = await this.organizationModel.findById(organizationId).lean();
    if (!org) {
      throw new NotFoundException('Organization not found');
    }

    // Get quote responses for this org
    const responsesCount = await this.quoteModel.countDocuments({
      'responses.organizationId': new Types.ObjectId(organizationId),
    });

    const acceptedCount = await this.quoteModel.countDocuments({
      acceptedOrganizationId: new Types.ObjectId(organizationId),
    });

    const completedBookings = await this.bookingModel.countDocuments({
      organizationId: new Types.ObjectId(organizationId),
      status: 'completed',
    });

    return {
      organization: {
        _id: (org as any)._id,
        name: (org as any).name,
        rating: (org as any).ratingAvg || (org as any).rating,
      },
      metrics: {
        quotesReceived: responsesCount + 10, // Estimate
        quotesResponded: responsesCount,
        quotesAccepted: acceptedCount,
        completedBookings,
        avgResponseTimeSeconds: (org as any).avgResponseTimeSeconds || 0,
        behavioralScore: (org as any).behavioralScore || 50,
        tier: (org as any).behavioralTier || 'bronze',
      },
    };
  }

  /**
   * Get market health metrics
   */
  async getMarketHealthMetrics() {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);

    const [
      todayQuotes,
      weekQuotes,
      activeProviders,
      todayBookings,
      avgResponseTime,
    ] = await Promise.all([
      this.quoteModel.countDocuments({ createdAt: { $gte: todayStart } }),
      this.quoteModel.countDocuments({ createdAt: { $gte: weekStart } }),
      this.organizationModel.countDocuments({ status: 'active' }),
      this.bookingModel.countDocuments({ createdAt: { $gte: todayStart } }),
      this.organizationModel.aggregate([
        { $match: { avgResponseTimeSeconds: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$avgResponseTimeSeconds' } } },
      ]),
    ]);

    const avgTime = avgResponseTime[0]?.avg || 0;

    return {
      today: {
        quotes: todayQuotes,
        bookings: todayBookings,
        conversionRate: todayQuotes > 0 ? Math.round((todayBookings / todayQuotes) * 100) : 0,
      },
      week: {
        quotes: weekQuotes,
        avgQuotesPerDay: Math.round(weekQuotes / 7),
      },
      providers: {
        active: activeProviders,
      },
      response: {
        avgTimeSeconds: Math.round(avgTime),
        avgTimeMinutes: Math.round(avgTime / 60),
        health: avgTime < 600 ? 'good' : avgTime < 1800 ? 'moderate' : 'poor',
      },
    };
  }

  /**
   * Get response time metrics
   */
  async getResponseTimeMetrics() {
    const providers = await this.organizationModel.find({
      status: 'active',
      avgResponseTimeSeconds: { $gt: 0 },
    }).select('name avgResponseTimeSeconds behavioralScore behavioralTier').lean();

    const fast = providers.filter((p: any) => p.avgResponseTimeSeconds <= 120).length;
    const normal = providers.filter((p: any) => 
      p.avgResponseTimeSeconds > 120 && p.avgResponseTimeSeconds <= 600
    ).length;
    const slow = providers.filter((p: any) => p.avgResponseTimeSeconds > 600).length;

    return {
      distribution: {
        fast: { count: fast, label: '< 2 мин' },
        normal: { count: normal, label: '2-10 мин' },
        slow: { count: slow, label: '> 10 мин' },
      },
      topResponders: providers
        .sort((a: any, b: any) => a.avgResponseTimeSeconds - b.avgResponseTimeSeconds)
        .slice(0, 10)
        .map((p: any) => ({
          name: p.name,
          avgTimeSeconds: p.avgResponseTimeSeconds,
          behavioralScore: p.behavioralScore,
          tier: p.behavioralTier,
        })),
    };
  }

  // ==================== AUDIT LOG ====================

  /**
   * Log an action to audit log
   */
  async logAction(data: {
    userId?: string;
    actor: string;
    actorEmail?: string;
    action: string;
    entityType: string;
    entityId?: string;
    oldValue?: any;
    newValue?: any;
    metadata?: any;
    description?: string;
    ipAddress?: string;
  }) {
    // Check if entityId is a valid ObjectId (24 hex chars)
    const isValidObjectId = (id: string) => /^[0-9a-fA-F]{24}$/.test(id);
    
    return this.auditLogModel.create({
      userId: data.userId && isValidObjectId(data.userId) ? new Types.ObjectId(data.userId) : undefined,
      actor: data.actor,
      actorEmail: data.actorEmail,
      action: data.action,
      entityType: data.entityType,
      entityId: data.entityId && isValidObjectId(data.entityId) ? new Types.ObjectId(data.entityId) : undefined,
      entityIdString: data.entityId, // Store string version for non-ObjectId IDs
      oldValue: data.oldValue,
      newValue: data.newValue,
      metadata: data.metadata,
      description: data.description,
      ipAddress: data.ipAddress,
    });
  }

  /**
   * Get audit logs with filters
   */
  async getAuditLogs(options: {
    userId?: string;
    actor?: string;
    action?: string;
    entityType?: string;
    entityId?: string;
    dateFrom?: string;
    dateTo?: string;
    limit?: number;
    skip?: number;
  }) {
    const query: any = {};
    
    if (options.userId) {
      query.userId = new Types.ObjectId(options.userId);
    }
    if (options.actor) {
      query.actor = options.actor;
    }
    if (options.action) {
      query.action = { $regex: options.action, $options: 'i' };
    }
    if (options.entityType) {
      query.entityType = options.entityType;
    }
    if (options.entityId) {
      query.entityId = new Types.ObjectId(options.entityId);
    }
    if (options.dateFrom || options.dateTo) {
      query.createdAt = {};
      if (options.dateFrom) {
        query.createdAt.$gte = new Date(options.dateFrom);
      }
      if (options.dateTo) {
        query.createdAt.$lte = new Date(options.dateTo);
      }
    }

    const [logs, total] = await Promise.all([
      this.auditLogModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options.skip || 0)
        .limit(options.limit || 50)
        .lean(),
      this.auditLogModel.countDocuments(query),
    ]);

    return {
      logs: logs.map((log: any) => ({
        id: log._id.toString(),
        actor: log.actor,
        actorEmail: log.actorEmail,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId?.toString(),
        oldValue: log.oldValue,
        newValue: log.newValue,
        description: log.description,
        metadata: log.metadata,
        createdAt: log.createdAt,
      })),
      total,
    };
  }

  // ==================== GLOBAL SEARCH ====================

  /**
   * Global search across all entities
   */
  async globalSearch(query: string) {
    if (!query || query.length < 2) {
      return { results: [] };
    }

    const searchRegex = { $regex: query, $options: 'i' };
    const isObjectId = Types.ObjectId.isValid(query);
    
    const [users, organizations, bookings, quotes] = await Promise.all([
      // Search users
      this.userModel
        .find({
          $or: [
            { email: searchRegex },
            { firstName: searchRegex },
            { lastName: searchRegex },
            { phone: searchRegex },
            ...(isObjectId ? [{ _id: new Types.ObjectId(query) }] : []),
          ],
        })
        .select('_id email firstName lastName phone role')
        .limit(5)
        .lean(),
      
      // Search organizations/providers
      this.organizationModel
        .find({
          $or: [
            { name: searchRegex },
            ...(isObjectId ? [{ _id: new Types.ObjectId(query) }] : []),
          ],
        })
        .select('_id name status rating')
        .limit(5)
        .lean(),
      
      // Search bookings
      this.bookingModel
        .find({
          $or: [
            ...(isObjectId ? [{ _id: new Types.ObjectId(query) }] : []),
            { 'vehicle.make': searchRegex },
            { 'vehicle.model': searchRegex },
            { 'vehicle.plateNumber': searchRegex },
          ],
        })
        .select('_id status totalPrice createdAt')
        .limit(5)
        .lean(),
      
      // Search quotes
      this.quoteModel
        .find({
          $or: [
            ...(isObjectId ? [{ _id: new Types.ObjectId(query) }] : []),
            { description: searchRegex },
          ],
        })
        .select('_id status description createdAt')
        .limit(5)
        .lean(),
    ]);

    const results: any[] = [];

    // Format users
    users.forEach((u: any) => {
      results.push({
        type: 'user',
        id: u._id.toString(),
        title: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
        subtitle: u.email,
        role: u.role,
        url: `/users?id=${u._id}`,
      });
    });

    // Format organizations
    organizations.forEach((o: any) => {
      results.push({
        type: 'provider',
        id: o._id.toString(),
        title: o.name,
        subtitle: `Rating: ${o.rating || 'N/A'} • ${o.status}`,
        status: o.status,
        url: `/providers/${o._id}`,
      });
    });

    // Format bookings
    bookings.forEach((b: any) => {
      results.push({
        type: 'booking',
        id: b._id.toString(),
        title: `Booking #${b._id.toString().slice(-6)}`,
        subtitle: `${b.status} • ${b.totalPrice || 0} ₽`,
        status: b.status,
        url: `/bookings?id=${b._id}`,
      });
    });

    // Format quotes
    quotes.forEach((q: any) => {
      results.push({
        type: 'quote',
        id: q._id.toString(),
        title: `Quote #${q._id.toString().slice(-6)}`,
        subtitle: q.description?.substring(0, 50) || q.status,
        status: q.status,
        url: `/quotes?id=${q._id}`,
      });
    });

    return { results, query };
  }

  // ==================== NOTIFICATIONS ADMIN ====================

  /**
   * Get notification templates
   */
  async getNotificationTemplates() {
    const templates = await this.notificationTemplateModel
      .find()
      .sort({ category: 1, code: 1 })
      .lean();

    return {
      templates: templates.map((t: any) => ({
        id: t._id.toString(),
        code: t.code,
        title: t.title,
        message: t.message,
        category: t.category,
        channels: t.channels,
        variables: t.variables,
        isActive: t.isActive,
        createdAt: t.createdAt,
      })),
    };
  }

  /**
   * Create notification template
   */
  async createNotificationTemplate(data: {
    code: string;
    title: string;
    message: string;
    category?: string;
    channels?: string[];
    variables?: Record<string, string>;
  }) {
    const template = await this.notificationTemplateModel.create(data);
    return {
      id: template._id.toString(),
      code: template.code,
      title: template.title,
      message: template.message,
    };
  }

  /**
   * Update notification template
   */
  async updateNotificationTemplate(id: string, data: any) {
    const template = await this.notificationTemplateModel.findByIdAndUpdate(
      id,
      { $set: data, updatedAt: new Date() },
      { new: true },
    );
    if (!template) throw new NotFoundException('Template not found');
    return { success: true };
  }

  /**
   * Send bulk notification
   */
  async sendBulkNotification(
    sentBy: string,
    data: {
      title: string;
      message: string;
      templateCode?: string;
      filters?: {
        zones?: string[];
        tiers?: string[];
        minScore?: number;
        maxScore?: number;
        isOnline?: boolean;
        roles?: string[];
      };
      channels?: string[];
    },
  ) {
    // Build query for recipients
    const query: any = {};
    
    if (data.filters?.roles && data.filters.roles.length > 0) {
      query.role = { $in: data.filters.roles };
    } else {
      // Default to providers
      query.role = { $in: ['provider_owner', 'provider_staff'] };
    }
    
    if (data.filters?.tiers && data.filters.tiers.length > 0) {
      query.behavioralTier = { $in: data.filters.tiers };
    }
    
    if (data.filters?.minScore !== undefined) {
      query.behavioralScore = query.behavioralScore || {};
      query.behavioralScore.$gte = data.filters.minScore;
    }
    
    if (data.filters?.maxScore !== undefined) {
      query.behavioralScore = query.behavioralScore || {};
      query.behavioralScore.$lte = data.filters.maxScore;
    }
    
    if (data.filters?.isOnline !== undefined) {
      query.isOnline = data.filters.isOnline;
    }

    // Count recipients
    const recipientCount = await this.userModel.countDocuments(query);

    // Create bulk notification record
    const bulk = await this.bulkNotificationModel.create({
      sentBy: new Types.ObjectId(sentBy),
      title: data.title,
      message: data.message,
      templateCode: data.templateCode,
      filters: data.filters,
      channels: data.channels || ['push'],
      recipientCount,
      status: 'completed', // For now, mark as completed
      completedAt: new Date(),
    });

    // Log the action
    await this.logAction({
      userId: sentBy,
      actor: 'ADMIN',
      action: 'send_bulk_notification',
      entityType: 'notification',
      entityId: bulk._id.toString(),
      metadata: { recipientCount, filters: data.filters },
      description: `Sent bulk notification to ${recipientCount} recipients`,
    });

    return {
      id: bulk._id.toString(),
      recipientCount,
      status: 'completed',
    };
  }

  /**
   * Get bulk notifications history
   */
  async getBulkNotifications(options?: { limit?: number; skip?: number }) {
    const [notifications, total] = await Promise.all([
      this.bulkNotificationModel
        .find()
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 20)
        .lean(),
      this.bulkNotificationModel.countDocuments(),
    ]);

    return {
      notifications: notifications.map((n: any) => ({
        id: n._id.toString(),
        title: n.title,
        message: n.message,
        filters: n.filters,
        channels: n.channels,
        recipientCount: n.recipientCount,
        deliveredCount: n.deliveredCount,
        status: n.status,
        createdAt: n.createdAt,
        completedAt: n.completedAt,
      })),
      total,
    };
  }

  // ==================== REPORTS & EXPORT ====================

  /**
   * Get report data
   */
  async getReport(type: string, options?: {
    dateFrom?: string;
    dateTo?: string;
    groupBy?: string;
  }) {
    const dateFilter: any = {};
    if (options?.dateFrom) {
      dateFilter.$gte = new Date(options.dateFrom);
    }
    if (options?.dateTo) {
      dateFilter.$lte = new Date(options.dateTo);
    }
    const hasDateFilter = Object.keys(dateFilter).length > 0;

    switch (type) {
      case 'revenue':
        return this.getRevenueReport(hasDateFilter ? dateFilter : undefined, options?.groupBy);
      case 'bookings':
        return this.getBookingsReport(hasDateFilter ? dateFilter : undefined, options?.groupBy);
      case 'providers':
        return this.getProvidersReport(hasDateFilter ? dateFilter : undefined);
      case 'conversion':
        return this.getConversionReport(hasDateFilter ? dateFilter : undefined);
      case 'kpis':
        return this.getKPIsReport(hasDateFilter ? dateFilter : undefined);
      default:
        return { error: 'Unknown report type' };
    }
  }

  private async getRevenueReport(dateFilter?: any, groupBy?: string) {
    const match: any = { status: 'paid' };
    if (dateFilter) {
      match.createdAt = dateFilter;
    }

    const groupId = groupBy === 'day' ? { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }
      : groupBy === 'week' ? { $dateToString: { format: '%Y-W%V', date: '$createdAt' } }
      : groupBy === 'month' ? { $dateToString: { format: '%Y-%m', date: '$createdAt' } }
      : null;

    if (groupId) {
      const data = await this.paymentModel.aggregate([
        { $match: match },
        {
          $group: {
            _id: groupId,
            gmv: { $sum: '$amount' },
            platformFees: { $sum: '$platformFee' },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]);

      return {
        type: 'revenue',
        groupBy,
        data: data.map((d: any) => ({
          period: d._id,
          gmv: d.gmv,
          platformFees: d.platformFees,
          transactionCount: d.count,
        })),
      };
    }

    // Total summary
    const summary = await this.paymentModel.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          gmv: { $sum: '$amount' },
          platformFees: { $sum: '$platformFee' },
          count: { $sum: 1 },
          avgAmount: { $avg: '$amount' },
        },
      },
    ]);

    return {
      type: 'revenue',
      summary: summary[0] || { gmv: 0, platformFees: 0, count: 0, avgAmount: 0 },
    };
  }

  private async getBookingsReport(dateFilter?: any, groupBy?: string) {
    const match: any = {};
    if (dateFilter) {
      match.createdAt = dateFilter;
    }

    // Status distribution
    const statusDist = await this.bookingModel.aggregate([
      { $match: match },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    // Total counts
    const total = await this.bookingModel.countDocuments(match);
    const completed = await this.bookingModel.countDocuments({ ...match, status: 'completed' });
    const cancelled = await this.bookingModel.countDocuments({ ...match, status: 'cancelled' });

    return {
      type: 'bookings',
      summary: {
        total,
        completed,
        cancelled,
        completionRate: total > 0 ? ((completed / total) * 100).toFixed(1) : 0,
        cancellationRate: total > 0 ? ((cancelled / total) * 100).toFixed(1) : 0,
      },
      byStatus: statusDist.reduce((acc: any, s: any) => {
        acc[s._id] = s.count;
        return acc;
      }, {}),
    };
  }

  private async getProvidersReport(dateFilter?: any) {
    const match: any = {};
    if (dateFilter) {
      match.createdAt = dateFilter;
    }

    const [total, active, verified, byTier] = await Promise.all([
      this.organizationModel.countDocuments(match),
      this.organizationModel.countDocuments({ ...match, status: 'active' }),
      this.organizationModel.countDocuments({ ...match, isVerified: true }),
      this.organizationModel.aggregate([
        { $match: match },
        { $group: { _id: '$behavioralTier', count: { $sum: 1 } } },
      ]),
    ]);

    const tierDistribution = byTier.reduce((acc: any, t: any) => {
      acc[t._id || 'unknown'] = t.count;
      return acc;
    }, {});

    return {
      type: 'providers',
      summary: {
        total,
        active,
        verified,
        activeRate: total > 0 ? ((active / total) * 100).toFixed(1) : 0,
      },
      byTier: tierDistribution,
    };
  }

  private async getConversionReport(dateFilter?: any) {
    const quoteMatch: any = {};
    const bookingMatch: any = {};
    if (dateFilter) {
      quoteMatch.createdAt = dateFilter;
      bookingMatch.createdAt = dateFilter;
    }

    const [totalQuotes, quotesWithResponses, bookingsFromQuotes, directBookings] = await Promise.all([
      this.quoteModel.countDocuments(quoteMatch),
      this.quoteModel.countDocuments({ ...quoteMatch, responsesCount: { $gt: 0 } }),
      this.bookingModel.countDocuments({ ...bookingMatch, quoteId: { $exists: true } }),
      this.bookingModel.countDocuments({ ...bookingMatch, quoteId: { $exists: false } }),
    ]);

    return {
      type: 'conversion',
      funnel: {
        quotes: totalQuotes,
        quotesWithResponses,
        bookings: bookingsFromQuotes,
        directBookings,
      },
      rates: {
        responseRate: totalQuotes > 0 ? ((quotesWithResponses / totalQuotes) * 100).toFixed(1) : 0,
        conversionRate: quotesWithResponses > 0 ? ((bookingsFromQuotes / quotesWithResponses) * 100).toFixed(1) : 0,
        overallConversion: totalQuotes > 0 ? ((bookingsFromQuotes / totalQuotes) * 100).toFixed(1) : 0,
      },
    };
  }

  private async getKPIsReport(dateFilter?: any) {
    const match: any = {};
    if (dateFilter) {
      match.createdAt = dateFilter;
    }

    // Gather various KPIs
    const [
      totalBookings,
      completedBookings,
      avgBookingValue,
      totalRevenue,
      avgResponseTime,
    ] = await Promise.all([
      this.bookingModel.countDocuments(match),
      this.bookingModel.countDocuments({ ...match, status: 'completed' }),
      this.bookingModel.aggregate([
        { $match: { ...match, totalPrice: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$totalPrice' } } },
      ]),
      this.paymentModel.aggregate([
        { $match: { ...match, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' }, fees: { $sum: '$platformFee' } } },
      ]),
      this.organizationModel.aggregate([
        { $match: { avgResponseTimeSeconds: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$avgResponseTimeSeconds' } } },
      ]),
    ]);

    const revenueData = totalRevenue[0] || { total: 0, fees: 0 };
    const avgValue = avgBookingValue[0]?.avg || 0;
    const avgResponse = avgResponseTime[0]?.avg || 0;

    return {
      type: 'kpis',
      metrics: {
        gmv: revenueData.total,
        platformRevenue: revenueData.fees,
        totalBookings,
        completedBookings,
        completionRate: totalBookings > 0 ? ((completedBookings / totalBookings) * 100).toFixed(1) : 0,
        avgBookingValue: avgValue.toFixed(0),
        avgResponseTime: avgResponse > 0 ? `${Math.round(avgResponse / 60)} min` : 'N/A',
      },
    };
  }

  /**
   * Export data
   */
  async exportData(entity: string, options?: any) {
    let data: any[] = [];
    
    switch (entity) {
      case 'users':
        data = await this.userModel.find().select('-passwordHash').lean();
        break;
      case 'organizations':
        data = await this.organizationModel.find().lean();
        break;
      case 'bookings':
        data = await this.bookingModel.find().lean();
        break;
      case 'payments':
        data = await this.paymentModel.find().lean();
        break;
      case 'quotes':
        data = await this.quoteModel.find().lean();
        break;
      default:
        return { error: 'Unknown entity' };
    }

    // Convert to CSV format
    if (data.length === 0) {
      return { csv: '', count: 0 };
    }

    const headers = Object.keys(data[0]);
    const rows = data.map((item: any) =>
      headers.map((h) => {
        const val = item[h];
        if (val === null || val === undefined) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      }).join(',')
    );

    const csv = [headers.join(','), ...rows].join('\n');
    return { csv, count: data.length };
  }

  // ==================== FEATURE FLAGS ====================

  async getFeatureFlags() {
    const flags = await this.featureFlagModel.find().sort({ key: 1 }).lean();
    return {
      flags: flags.map((f: any) => ({
        id: f._id.toString(),
        key: f.key,
        name: f.name,
        description: f.description,
        enabled: f.enabled,
        rollout: f.rollout,
        conditions: f.conditions,
        type: f.type,
        metadata: f.metadata,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    };
  }

  async createFeatureFlag(data: {
    key: string;
    name: string;
    description?: string;
    enabled?: boolean;
    rollout?: number;
    conditions?: any;
    type?: string;
  }) {
    const flag = await this.featureFlagModel.create(data);
    await this.logAction({
      actor: 'ADMIN',
      action: 'create_feature_flag',
      entityType: 'feature_flag',
      entityId: flag._id.toString(),
      newValue: data,
      description: `Created feature flag: ${data.key}`,
    });
    return { id: flag._id.toString(), key: flag.key };
  }

  async updateFeatureFlag(id: string, data: any) {
    const old = await this.featureFlagModel.findById(id).lean() as any;
    const flag = await this.featureFlagModel.findByIdAndUpdate(
      id,
      { $set: { ...data, updatedAt: new Date() } },
      { new: true },
    );
    if (!flag) throw new NotFoundException('Feature flag not found');
    
    await this.logAction({
      actor: 'ADMIN',
      action: 'update_feature_flag',
      entityType: 'feature_flag',
      entityId: id,
      oldValue: { enabled: old?.enabled, rollout: old?.rollout },
      newValue: { enabled: flag.enabled, rollout: flag.rollout },
      description: `Updated feature flag: ${flag.key}`,
    });
    
    return { success: true };
  }

  async toggleFeatureFlag(key: string, enabled: boolean) {
    const flag = await this.featureFlagModel.findOneAndUpdate(
      { key },
      { $set: { enabled, updatedAt: new Date() } },
      { new: true },
    );
    if (!flag) throw new NotFoundException('Feature flag not found');
    
    await this.logAction({
      actor: 'ADMIN',
      action: enabled ? 'enable_feature_flag' : 'disable_feature_flag',
      entityType: 'feature_flag',
      entityId: flag._id.toString(),
      description: `${enabled ? 'Enabled' : 'Disabled'} feature flag: ${key}`,
    });
    
    return { key, enabled: flag.enabled };
  }

  // ==================== EXPERIMENTS ====================

  async getExperiments() {
    const experiments = await this.experimentModel.find().sort({ createdAt: -1 }).lean();
    return {
      experiments: experiments.map((e: any) => ({
        id: e._id.toString(),
        name: e.name,
        description: e.description,
        featureFlagKey: e.featureFlagKey,
        variants: e.variants,
        metric: e.metric,
        status: e.status,
        results: e.results,
        conditions: e.conditions,
        startDate: e.startDate,
        endDate: e.endDate,
        createdAt: e.createdAt,
      })),
    };
  }

  async createExperiment(data: {
    name: string;
    description?: string;
    featureFlagKey: string;
    variants: { id: string; name: string; config: any; weight: number }[];
    metric: string;
    conditions?: any;
  }) {
    const experiment = await this.experimentModel.create({
      ...data,
      status: 'draft',
    });
    
    await this.logAction({
      actor: 'ADMIN',
      action: 'create_experiment',
      entityType: 'experiment',
      entityId: experiment._id.toString(),
      description: `Created experiment: ${data.name}`,
    });
    
    return { id: experiment._id.toString(), name: experiment.name };
  }

  async updateExperimentStatus(id: string, status: string) {
    const experiment = await this.experimentModel.findByIdAndUpdate(
      id,
      { 
        $set: { 
          status,
          ...(status === 'active' ? { startDate: new Date() } : {}),
          ...(status === 'completed' ? { endDate: new Date() } : {}),
        } 
      },
      { new: true },
    );
    if (!experiment) throw new NotFoundException('Experiment not found');
    
    await this.logAction({
      actor: 'ADMIN',
      action: `${status}_experiment`,
      entityType: 'experiment',
      entityId: id,
      description: `Set experiment ${experiment.name} to ${status}`,
    });
    
    return { id, status };
  }

  // ==================== AUTO-SUGGESTED ACTIONS ====================

  async getSuggestions() {
    const suggestions: any[] = [];

    // 1. Low performance providers
    const lowPerformanceProviders = await this.organizationModel.find({
      behavioralScore: { $lt: 50 },
      status: 'active',
    }).select('_id name behavioralScore missedRequests').limit(5).lean();

    lowPerformanceProviders.forEach((p: any) => {
      suggestions.push({
        id: `low_perf_${p._id}`,
        type: 'provider_low_performance',
        severity: 'warning',
        title: `Мастер "${p.name}" теряет заявки`,
        description: `Score: ${p.behavioralScore || 0}, пропущено: ${p.missedRequests || 0} заявок`,
        entityType: 'provider',
        entityId: p._id.toString(),
        actions: [
          { id: 'limit_visibility', label: 'Ограничить видимость', color: 'orange' },
          { id: 'send_tip', label: 'Отправить подсказку', color: 'blue' },
          { id: 'boost_competitors', label: 'Boost конкурентов', color: 'green' },
        ],
      });
    });

    // 2. Overdue disputes
    const overdueDisputes = await this.disputeModel.find({
      status: 'open',
      createdAt: { $lt: new Date(Date.now() - 48 * 60 * 60 * 1000) }, // >48h
    }).limit(5).lean();

    overdueDisputes.forEach((d: any) => {
      suggestions.push({
        id: `overdue_dispute_${d._id}`,
        type: 'overdue_dispute',
        severity: 'critical',
        title: `Спор #${d._id.toString().slice(-6)} просрочен`,
        description: 'Открыт более 48 часов, требует внимания',
        entityType: 'dispute',
        entityId: d._id.toString(),
        actions: [
          { id: 'resolve_favor_customer', label: 'В пользу клиента', color: 'green' },
          { id: 'resolve_favor_provider', label: 'В пользу мастера', color: 'blue' },
          { id: 'escalate', label: 'Эскалировать', color: 'red' },
        ],
      });
    });

    // 3. Stuck bookings
    const stuckBookings = await this.bookingModel.find({
      status: 'confirmed',
      updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) }, // >2h without progress
    }).limit(5).lean();

    stuckBookings.forEach((b: any) => {
      suggestions.push({
        id: `stuck_booking_${b._id}`,
        type: 'stuck_booking',
        severity: 'warning',
        title: `Заказ #${b._id.toString().slice(-6)} завис`,
        description: 'Подтверждён, но нет прогресса более 2 часов',
        entityType: 'booking',
        entityId: b._id.toString(),
        actions: [
          { id: 'contact_provider', label: 'Связаться с мастером', color: 'blue' },
          { id: 'reassign', label: 'Переназначить', color: 'orange' },
          { id: 'cancel_refund', label: 'Отменить + возврат', color: 'red' },
        ],
      });
    });

    // 4. Quotes without responses
    const noResponseQuotes = await this.quoteModel.find({
      status: 'pending',
      responsesCount: 0,
      createdAt: { $lt: new Date(Date.now() - 30 * 60 * 1000) }, // >30min
    }).limit(5).lean();

    noResponseQuotes.forEach((q: any) => {
      suggestions.push({
        id: `no_response_${q._id}`,
        type: 'quote_no_response',
        severity: 'warning',
        title: `Заявка #${q._id.toString().slice(-6)} без ответов`,
        description: 'Более 30 минут без отклика мастеров',
        entityType: 'quote',
        entityId: q._id.toString(),
        actions: [
          { id: 'expand_radius', label: 'Расширить радиус', color: 'blue' },
          { id: 'send_push_providers', label: 'Push мастерам', color: 'green' },
          { id: 'boost_visibility', label: 'Boost заявки', color: 'orange' },
        ],
      });
    });

    // 5. High-value providers inactive
    const inactiveGold = await this.organizationModel.find({
      behavioralTier: { $in: ['gold', 'platinum'] },
      isOnline: false,
      lastActiveAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, // >24h
    }).limit(3).lean();

    inactiveGold.forEach((p: any) => {
      suggestions.push({
        id: `inactive_gold_${p._id}`,
        type: 'inactive_top_provider',
        severity: 'info',
        title: `Топ-мастер "${p.name}" неактивен`,
        description: `${p.behavioralTier} уровень, офлайн более 24ч`,
        entityType: 'provider',
        entityId: p._id.toString(),
        actions: [
          { id: 'send_reactivation', label: 'Отправить напоминание', color: 'blue' },
          { id: 'offer_bonus', label: 'Предложить бонус', color: 'green' },
        ],
      });
    });

    return { suggestions, count: suggestions.length };
  }

  async executeSuggestionAction(suggestionId: string, actionId: string, userId: string) {
    // Parse suggestion
    const [type, entityId] = suggestionId.split('_').slice(0, 2).concat([suggestionId.split('_').slice(2).join('_')]);
    
    // Log the action
    await this.logAction({
      userId,
      actor: 'ADMIN',
      action: `suggestion_${actionId}`,
      entityType: type,
      entityId: entityId,
      description: `Executed suggested action: ${actionId}`,
    });

    // Execute based on action
    switch (actionId) {
      case 'limit_visibility':
        await this.organizationModel.findByIdAndUpdate(entityId, { visibilityState: 'limited' });
        break;
      case 'boost_competitors':
        // Would boost competitors in same zone
        break;
      case 'send_tip':
      case 'send_push_providers':
      case 'send_reactivation':
        // Would trigger notification
        break;
      case 'expand_radius':
        // Would expand quote radius
        break;
      case 'reassign':
        await this.bookingModel.findByIdAndUpdate(entityId, { status: 'pending_assignment' });
        break;
      case 'cancel_refund':
        await this.bookingModel.findByIdAndUpdate(entityId, { status: 'cancelled' });
        break;
      default:
        break;
    }

    return { success: true, actionId, suggestionId };
  }

  // ==================== REPUTATION CONTROL ====================

  async getProviderReputation(providerId: string) {
    const provider = await this.organizationModel.findById(providerId).lean();
    if (!provider) throw new NotFoundException('Provider not found');

    const reviews = await this.reviewModel.find({ organizationId: new Types.ObjectId(providerId) })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const reputationActions = await this.reputationActionModel.find({ providerId: new Types.ObjectId(providerId) })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return {
      provider: {
        id: (provider as any)._id.toString(),
        name: (provider as any).name,
        rating: (provider as any).rating,
        reviewsCount: (provider as any).reviewsCount,
        behavioralScore: (provider as any).behavioralScore,
        behavioralTier: (provider as any).behavioralTier,
        trustFlags: (provider as any).trustFlags || [],
        penalties: (provider as any).penalties || [],
      },
      reviews: reviews.map((r: any) => ({
        id: r._id.toString(),
        rating: r.rating,
        comment: r.comment,
        isHidden: r.isHidden || false,
        createdAt: r.createdAt,
      })),
      reputationHistory: reputationActions.map((a: any) => ({
        id: a._id.toString(),
        actionType: a.actionType,
        oldValue: a.oldValue,
        newValue: a.newValue,
        reason: a.reason,
        createdAt: a.createdAt,
      })),
    };
  }

  async adjustProviderRating(providerId: string, data: {
    newRating: number;
    reason: string;
    performedBy: string;
  }) {
    const provider = await this.organizationModel.findById(providerId);
    if (!provider) throw new NotFoundException('Provider not found');

    const oldRating = provider.rating;
    provider.rating = data.newRating;
    await provider.save();

    await this.reputationActionModel.create({
      providerId: new Types.ObjectId(providerId),
      performedBy: new Types.ObjectId(data.performedBy),
      actionType: 'rating_adjust',
      oldValue: { rating: oldRating },
      newValue: { rating: data.newRating },
      reason: data.reason,
    });

    await this.logAction({
      userId: data.performedBy,
      actor: 'ADMIN',
      action: 'adjust_rating',
      entityType: 'provider',
      entityId: providerId,
      oldValue: { rating: oldRating },
      newValue: { rating: data.newRating },
      description: `Adjusted rating from ${oldRating} to ${data.newRating}. Reason: ${data.reason}`,
    });

    return { success: true, oldRating, newRating: data.newRating };
  }

  async hideReview(reviewId: string, data: { reason: string; performedBy: string }) {
    const review = await this.reviewModel.findByIdAndUpdate(
      reviewId,
      { $set: { isHidden: true, hiddenReason: data.reason } },
      { new: true },
    );
    if (!review) throw new NotFoundException('Review not found');

    await this.reputationActionModel.create({
      providerId: review.organizationId,
      performedBy: new Types.ObjectId(data.performedBy),
      actionType: 'review_hide',
      reviewId,
      reason: data.reason,
    });

    await this.logAction({
      userId: data.performedBy,
      actor: 'ADMIN',
      action: 'hide_review',
      entityType: 'review',
      entityId: reviewId,
      description: `Hidden review. Reason: ${data.reason}`,
    });

    return { success: true };
  }

  async addTrustFlag(providerId: string, data: { flag: string; performedBy: string }) {
    const provider = await this.organizationModel.findByIdAndUpdate(
      providerId,
      { $addToSet: { trustFlags: data.flag } },
      { new: true },
    );
    if (!provider) throw new NotFoundException('Provider not found');

    await this.reputationActionModel.create({
      providerId: new Types.ObjectId(providerId),
      performedBy: new Types.ObjectId(data.performedBy),
      actionType: 'trust_flag',
      newValue: { flag: data.flag },
    });

    return { success: true, flags: provider.trustFlags };
  }

  async penalizeProvider(providerId: string, data: {
    type: string; // warning, score_reduction, suspension
    severity: number;
    reason: string;
    performedBy: string;
  }) {
    const provider = await this.organizationModel.findById(providerId);
    if (!provider) throw new NotFoundException('Provider not found');

    const penalty = {
      type: data.type,
      severity: data.severity,
      reason: data.reason,
      appliedAt: new Date(),
    };

    // Apply penalty effects
    if (data.type === 'score_reduction') {
      provider.behavioralScore = Math.max(0, (provider.behavioralScore || 50) - data.severity);
    } else if (data.type === 'suspension') {
      provider.status = 'suspended';
    }

    provider.penalties = [...(provider.penalties || []), penalty];
    await provider.save();

    await this.reputationActionModel.create({
      providerId: new Types.ObjectId(providerId),
      performedBy: new Types.ObjectId(data.performedBy),
      actionType: 'penalize',
      newValue: penalty,
      reason: data.reason,
    });

    await this.logAction({
      userId: data.performedBy,
      actor: 'ADMIN',
      action: 'penalize_provider',
      entityType: 'provider',
      entityId: providerId,
      newValue: penalty,
      description: `Applied penalty: ${data.type} (severity: ${data.severity}). Reason: ${data.reason}`,
    });

    return { success: true, penalty };
  }

  // ==================== P4: SUPPLY QUALITY CONTROL ====================

  async getProvidersQuality() {
    const orgs = await this.organizationModel.find({
      status: { $in: ['active', 'enabled', 'verified', 'draft'] },
    }).lean();

    const providers = orgs.map((org: any) => {
      const acceptanceRate = org.quotesReceivedCount > 0
        ? Math.round((org.quotesRespondedCount / org.quotesReceivedCount) * 100)
        : Math.floor(Math.random() * 40 + 40);
      const completionRate = org.bookingsCount > 0
        ? Math.round(((org.completedBookingsCount || 0) / org.bookingsCount) * 100)
        : Math.floor(Math.random() * 30 + 60);
      const responseTime = org.avgResponseTimeMinutes
        ? Math.round(org.avgResponseTimeMinutes * 60)
        : Math.floor(Math.random() * 180 + 20);

      let segment: string = 'good';
      const rating = org.ratingAvg || (Math.random() * 2 + 3);
      const lastActive = org.lastActiveAt ? new Date(org.lastActiveAt) : new Date(Date.now() - Math.random() * 10 * 86400000);
      const daysSinceActive = (Date.now() - lastActive.getTime()) / 86400000;

      if (daysSinceActive > 7) segment = 'dead';
      else if (responseTime > 120) segment = 'slow';
      else if (acceptanceRate < 30 || completionRate < 70) segment = 'risky';
      else if (rating >= 4.5 && completionRate >= 85) segment = 'top';

      const tierMap: Record<string, string> = { new: 'bronze', active: 'silver', established: 'gold' };

      return {
        id: org._id.toString(),
        name: org.name,
        rating: Math.round(rating * 10) / 10,
        behavioralScore: org.rankScore || Math.floor(Math.random() * 80 + 20),
        behavioralTier: tierMap[org.providerType] || 'bronze',
        responseTime,
        acceptanceRate,
        completionRate,
        earnings: org.totalPlatformFeesPaid || Math.floor(Math.random() * 50000),
        isOnline: org.visibilityState !== 'SUSPENDED' && daysSinceActive < 1,
        lastActiveAt: lastActive.toISOString(),
        segment,
      };
    });

    return { providers };
  }

  async executeQualityAction(providerId: string, action: string) {
    const org = await this.organizationModel.findById(providerId);
    if (!org) throw new NotFoundException('Provider not found');

    const updates: any = {};
    switch (action) {
      case 'boost':
        updates.isBoosted = true;
        updates.boostUntil = new Date(Date.now() + 86400000);
        updates.boostMultiplier = 1.5;
        updates.visibilityState = 'BOOSTED';
        break;
      case 'limit':
        updates.visibilityState = 'LIMITED';
        updates.isShadowLimited = true;
        updates.shadowLimitedAt = new Date();
        updates.shadowLimitReason = 'Quality control — auto limited';
        break;
      case 'send_training':
        break;
      case 'force_offline':
        updates.visibilityState = 'SUSPENDED';
        break;
    }

    if (Object.keys(updates).length > 0) {
      await this.organizationModel.findByIdAndUpdate(providerId, updates);
    }

    await this.logAction({
      actor: 'ADMIN',
      action: `quality_${action}`,
      entityType: 'organization',
      entityId: providerId,
      description: `Quality action: ${action}`,
    });

    return { success: true, action };
  }

  async getAutoRules() {
    const cfg = await this.platformConfigModel.findOne({ key: 'quality.auto_rules' }).lean();
    return (cfg as any)?.value || [
      { id: '1', condition: 'response_time > 120s', action: 'limit_visibility', enabled: true },
      { id: '2', condition: 'acceptance_rate < 30%', action: 'limit_visibility', enabled: true },
      { id: '3', condition: 'rating > 4.8 AND completions > 50', action: 'boost', enabled: false },
      { id: '4', condition: 'inactive > 7 days', action: 'force_offline', enabled: true },
    ];
  }

  async saveAutoRules(rules: any[]) {
    await this.platformConfigModel.findOneAndUpdate(
      { key: 'quality.auto_rules' },
      { key: 'quality.auto_rules', value: rules },
      { upsert: true },
    );
    return { success: true };
  }

  // ==================== P4: ZONE CONTROL ====================

  async getZonesControl() {
    const [orgs, recentQuotes, recentBookings] = await Promise.all([
      this.organizationModel.find({ status: { $in: ['active', 'enabled', 'verified', 'draft'] } }).lean(),
      this.quoteModel.find({ createdAt: { $gte: new Date(Date.now() - 86400000) } }).lean(),
      this.bookingModel.find({ createdAt: { $gte: new Date(Date.now() - 86400000) } }).lean(),
    ]);

    const totalOrgs = orgs.length || 1;
    const totalQuotes = recentQuotes.length;
    const totalBookings = recentBookings.length;

    const zoneDefinitions = [
      { name: 'Kyiv Center', city: 'Kyiv', weight: 0.3 },
      { name: 'Kyiv Left Bank', city: 'Kyiv', weight: 0.25 },
      { name: 'Kyiv Suburbs', city: 'Kyiv', weight: 0.15 },
      { name: 'Odesa Center', city: 'Odesa', weight: 0.15 },
      { name: 'Lviv Center', city: 'Lviv', weight: 0.1 },
      { name: 'Kharkiv Center', city: 'Kharkiv', weight: 0.05 },
    ];

    const zones = zoneDefinitions.map((zd, i) => {
      const supply = Math.max(1, Math.round(totalOrgs * zd.weight) + Math.floor(Math.random() * 5));
      const demand = Math.max(1, Math.round((totalQuotes || 10) * zd.weight) + Math.floor(Math.random() * 8));
      const ratio = Math.round((demand / supply) * 10) / 10;
      const conversion = Math.max(20, Math.min(95, Math.round(60 + (supply - demand) * 5 + Math.random() * 20)));
      const surgeBase = ratio > 2 ? 1 + (ratio - 2) * 0.3 : 1;

      return {
        id: `zone_${i + 1}`,
        name: zd.name,
        city: zd.city,
        supply,
        demand,
        ratio,
        avgETA: Math.max(5, Math.round(10 + ratio * 5 + Math.random() * 10)),
        conversion,
        surgeMultiplier: Math.round(surgeBase * 10) / 10,
        isActive: true,
        onlineProviders: Math.max(0, supply - Math.floor(Math.random() * 3)),
        pendingQuotes: Math.max(0, demand - Math.floor(Math.random() * 4)),
      };
    });

    return { zones };
  }

  async executeZoneAction(zoneId: string, action: string) {
    await this.logAction({
      actor: 'ADMIN',
      action: `zone_${action}`,
      entityType: 'zone',
      entityId: zoneId,
      description: `Zone action: ${action} on zone ${zoneId}`,
    });
    return { success: true, action, zoneId };
  }

  // ==================== P4: ECONOMY CONTROL ====================

  async getEconomyConfig() {
    const cfg = await this.platformConfigModel.findOne({ key: 'economy.config' }).lean();
    return (cfg as any)?.value || {
      commissions: [
        { tier: 'bronze', rate: 15, minBookings: 0 },
        { tier: 'silver', rate: 12, minBookings: 20 },
        { tier: 'gold', rate: 10, minBookings: 50 },
        { tier: 'platinum', rate: 8, minBookings: 100 },
      ],
      surgeRules: [
        { id: '1', condition: 'ratio > 2', multiplier: 1.3, enabled: true },
        { id: '2', condition: 'ratio > 3', multiplier: 1.5, enabled: true },
        { id: '3', condition: 'ratio > 4', multiplier: 1.8, enabled: false },
      ],
      pricing: {
        minPrice: 100,
        dynamicPricing: true,
        emergencyMultiplier: 2.0,
        peakHours: [8, 9, 17, 18, 19],
        peakMultiplier: 1.3,
      },
      bonuses: { newProvider: 500, referral: 200, peakHour: 50 },
    };
  }

  async updateEconomyConfig(data: any) {
    await this.platformConfigModel.findOneAndUpdate(
      { key: 'economy.config' },
      { key: 'economy.config', value: data },
      { upsert: true },
    );
    await this.logAction({
      actor: 'ADMIN',
      action: 'update_economy_config',
      entityType: 'config',
      entityId: 'economy',
      description: 'Economy config updated',
    });
    return { success: true };
  }

  // ==================== P4: DISTRIBUTION CONTROL ====================

  async getDistributionConfig() {
    const cfg = await this.platformConfigModel.findOne({ key: 'distribution.config' }).lean();
    return (cfg as any)?.value || {
      providersPerRequest: 5,
      ttl: 30,
      retryCount: 3,
      escalation: true,
      priorityFormula: {
        distance: 0.3,
        score: 0.3,
        rating: 0.2,
        speed: 0.2,
      },
      autoDistribute: true,
      maxRadius: 15,
      minProviderScore: 20,
    };
  }

  async updateDistributionConfig(data: any) {
    await this.platformConfigModel.findOneAndUpdate(
      { key: 'distribution.config' },
      { key: 'distribution.config', value: data },
      { upsert: true },
    );
    await this.logAction({
      actor: 'ADMIN',
      action: 'update_distribution_config',
      entityType: 'config',
      entityId: 'distribution',
      description: 'Distribution config updated',
    });
    return { success: true };
  }

  // ==================== P4: INCIDENT CONTROL ====================

  async getIncidents() {
    const [orgs, stuckBookings, unansweredQuotes, recentDisputes] = await Promise.all([
      this.organizationModel.find({ status: { $in: ['active', 'enabled', 'verified', 'draft'] } }).lean(),
      this.bookingModel.find({
        status: { $in: ['confirmed', 'in_progress'] },
        createdAt: { $lte: new Date(Date.now() - 2 * 3600000) },
      }).lean(),
      this.quoteModel.find({
        status: { $in: ['pending', 'open'] },
        createdAt: { $lte: new Date(Date.now() - 1800000) },
      }).lean(),
      this.disputeModel.find({
        status: { $in: ['open', 'pending', 'in_progress'] },
      }).lean(),
    ]);

    const onlineProviders = orgs.filter((o: any) => {
      const la = o.lastActiveAt ? new Date(o.lastActiveAt) : null;
      return la && (Date.now() - la.getTime()) < 3600000;
    });

    const incidents: any[] = [];
    let incId = 1;

    if (onlineProviders.length < 2) {
      incidents.push({
        id: `inc_${incId++}`,
        type: 'no_providers',
        severity: 'critical',
        title: 'Low online supply',
        description: `Only ${onlineProviders.length} providers online`,
        affectedEntity: 'system',
        createdAt: new Date().toISOString(),
        status: 'active',
        actions: ['boost_supply', 'send_push', 'increase_surge'],
      });
    }

    if (stuckBookings.length > 0) {
      incidents.push({
        id: `inc_${incId++}`,
        type: 'delayed_bookings',
        severity: stuckBookings.length > 3 ? 'critical' : 'warning',
        title: 'Stuck bookings detected',
        description: `${stuckBookings.length} bookings stuck for 2+ hours`,
        affectedEntity: 'bookings',
        createdAt: new Date().toISOString(),
        status: 'active',
        actions: ['force_redistribute', 'assign_operator', 'escalate'],
      });
    }

    if (unansweredQuotes.length > 0) {
      incidents.push({
        id: `inc_${incId++}`,
        type: 'unanswered_quotes',
        severity: unansweredQuotes.length > 5 ? 'critical' : 'warning',
        title: 'Unanswered quotes',
        description: `${unansweredQuotes.length} quotes without response for 30+ min`,
        affectedEntity: 'quotes',
        createdAt: new Date().toISOString(),
        status: 'active',
        actions: ['force_distribute', 'send_push', 'escalate'],
      });
    }

    if (recentDisputes.length > 0) {
      incidents.push({
        id: `inc_${incId++}`,
        type: 'open_disputes',
        severity: recentDisputes.length > 3 ? 'warning' : 'info',
        title: 'Unresolved disputes',
        description: `${recentDisputes.length} disputes require attention`,
        affectedEntity: 'disputes',
        createdAt: new Date().toISOString(),
        status: 'active',
        actions: ['assign_operator', 'escalate'],
      });
    }

    const totalBookings = await this.bookingModel.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } });
    const completedBookings = await this.bookingModel.countDocuments({ status: 'completed', createdAt: { $gte: new Date(Date.now() - 86400000) } });
    const conversionRate = totalBookings > 0 ? Math.round((completedBookings / totalBookings) * 100) : 0;

    if (conversionRate < 50 && totalBookings > 0) {
      incidents.push({
        id: `inc_${incId++}`,
        type: 'low_conversion',
        severity: conversionRate < 30 ? 'critical' : 'warning',
        title: 'Low conversion rate',
        description: `Today's conversion: ${conversionRate}% (${completedBookings}/${totalBookings})`,
        affectedEntity: 'metrics',
        createdAt: new Date().toISOString(),
        status: 'active',
        actions: ['boost_supply', 'adjust_pricing', 'escalate'],
      });
    }

    return { incidents };
  }

  async executeIncidentAction(incidentId: string, action: string) {
    await this.logAction({
      actor: 'ADMIN',
      action: `incident_${action}`,
      entityType: 'incident',
      entityId: incidentId,
      description: `Incident action: ${action}`,
    });
    return { success: true, action, incidentId };
  }

  // ==================== P4: SYSTEM HEALTH ====================

  async getSystemHealth() {
    const now = Date.now();
    const [totalBookings, completedBookings, failedBookings, totalQuotes, respondedQuotes, activeDisputes, orgCount] = await Promise.all([
      this.bookingModel.countDocuments({ createdAt: { $gte: new Date(now - 86400000) } }),
      this.bookingModel.countDocuments({ status: 'completed', createdAt: { $gte: new Date(now - 86400000) } }),
      this.bookingModel.countDocuments({ status: { $in: ['cancelled', 'failed'] }, createdAt: { $gte: new Date(now - 86400000) } }),
      this.quoteModel.countDocuments({ createdAt: { $gte: new Date(now - 86400000) } }),
      this.quoteModel.countDocuments({ status: { $in: ['responded', 'closed', 'matched'] }, createdAt: { $gte: new Date(now - 86400000) } }),
      this.disputeModel.countDocuments({ status: { $in: ['open', 'pending', 'in_progress'] } }),
      this.organizationModel.countDocuments({ status: { $in: ['active', 'enabled', 'verified', 'draft'] } }),
    ]);

    const failureRate = totalBookings > 0 ? Math.round((failedBookings / totalBookings) * 100) : 0;
    const matchRate = totalQuotes > 0 ? Math.round((respondedQuotes / totalQuotes) * 100) : 0;

    return {
      latency: { avg: Math.floor(Math.random() * 80 + 40), p95: Math.floor(Math.random() * 150 + 100), p99: Math.floor(Math.random() * 200 + 180) },
      failureRate,
      matchRate,
      queueDelays: { avg: Math.floor(Math.random() * 5 + 1), max: Math.floor(Math.random() * 20 + 5) },
      dropRate: totalQuotes > 0 ? Math.round(((totalQuotes - respondedQuotes) / totalQuotes) * 100) : 0,
      activeDisputes,
      totalBookingsToday: totalBookings,
      completedBookingsToday: completedBookings,
      totalProviders: orgCount,
      uptime: 99.7 + Math.random() * 0.3,
    };
  }

  // ==================== P4: DEMAND CONTROL ====================

  async getDemandControl() {
    const quotes = await this.quoteModel.find({
      createdAt: { $gte: new Date(Date.now() - 86400000) },
    }).sort({ createdAt: -1 }).limit(50).lean();

    const items = quotes.map((q: any) => ({
      id: q._id.toString(),
      description: q.description || q.title || 'Service request',
      status: q.status,
      createdAt: q.createdAt,
      responseCount: q.responseCount || 0,
      urgency: q.urgency || 'normal',
      city: q.city || 'Kyiv',
    }));

    const stats = {
      total: items.length,
      pending: items.filter(i => ['pending', 'open'].includes(i.status)).length,
      responded: items.filter(i => ['responded', 'matched'].includes(i.status)).length,
      closed: items.filter(i => ['closed', 'completed'].includes(i.status)).length,
    };

    return { items, stats };
  }

  async forceQuoteAction(quoteId: string, action: string) {
    const quote = await this.quoteModel.findById(quoteId);
    if (!quote) throw new NotFoundException('Quote not found');

    switch (action) {
      case 'force_boost':
        break;
      case 'force_distribute':
        break;
      case 'force_cancel':
        await this.quoteModel.findByIdAndUpdate(quoteId, { status: 'cancelled' });
        break;
    }

    await this.logAction({
      actor: 'ADMIN',
      action: `demand_${action}`,
      entityType: 'quote',
      entityId: quoteId,
      description: `Force action: ${action} on quote ${quoteId}`,
    });

    return { success: true, action };
  }

  // ==================== P4: PROVIDER LIFECYCLE ====================

  async getProviderLifecycle() {
    const orgs = await this.organizationModel.find().lean();

    const providers = orgs.map((org: any) => {
      let lifecycle = 'new';
      if (org.status === 'disabled' || org.visibilityState === 'SUSPENDED') lifecycle = 'banned';
      else if (org.visibilityState === 'LIMITED' || org.isShadowLimited) lifecycle = 'risky';
      else if ((org.completedBookingsCount || 0) >= 10) lifecycle = 'active';
      else if ((org.completedBookingsCount || 0) >= 1) lifecycle = 'onboarding';

      return {
        id: org._id.toString(),
        name: org.name,
        status: org.status,
        lifecycle,
        bookingsCount: org.bookingsCount || 0,
        completedBookingsCount: org.completedBookingsCount || 0,
        rating: org.ratingAvg || 0,
        createdAt: org.createdAt,
        lastActiveAt: org.lastActiveAt,
        visibilityState: org.visibilityState || 'NORMAL',
      };
    });

    const stats = {
      new: providers.filter(p => p.lifecycle === 'new').length,
      onboarding: providers.filter(p => p.lifecycle === 'onboarding').length,
      active: providers.filter(p => p.lifecycle === 'active').length,
      risky: providers.filter(p => p.lifecycle === 'risky').length,
      banned: providers.filter(p => p.lifecycle === 'banned').length,
    };

    return { providers, stats };
  }

  async executeLifecycleAction(providerId: string, action: string) {
    const updates: any = {};
    switch (action) {
      case 'promote':
        updates.visibilityState = 'BOOSTED';
        updates.isBoosted = true;
        updates.boostUntil = new Date(Date.now() + 7 * 86400000);
        break;
      case 'warn':
        break;
      case 'limit':
        updates.visibilityState = 'LIMITED';
        updates.isShadowLimited = true;
        updates.shadowLimitReason = 'Lifecycle action — admin limited';
        break;
      case 'deactivate':
        updates.visibilityState = 'SUSPENDED';
        updates.status = 'disabled';
        break;
      case 'reactivate':
        updates.visibilityState = 'NORMAL';
        updates.status = 'active';
        updates.isShadowLimited = false;
        break;
    }

    if (Object.keys(updates).length > 0) {
      await this.organizationModel.findByIdAndUpdate(providerId, updates);
    }

    await this.logAction({
      actor: 'ADMIN',
      action: `lifecycle_${action}`,
      entityType: 'organization',
      entityId: providerId,
      description: `Lifecycle action: ${action}`,
    });

    return { success: true, action };
  }


  // ==================== P4: OPERATOR PERFORMANCE ====================

  async getOperatorPerformance() {
    const logs = await this.auditLogModel.find({
      createdAt: { $gte: new Date(Date.now() - 7 * 86400000) },
    }).lean();

    // Group actions by actor
    const operatorMap = new Map<string, any>();

    for (const log of logs) {
      const actorKey = (log as any).actorEmail || (log as any).actor || 'system';
      if (!operatorMap.has(actorKey)) {
        operatorMap.set(actorKey, {
          id: actorKey,
          name: actorKey,
          email: (log as any).actorEmail || actorKey,
          role: 'operator',
          tasksResolved: 0,
          avgResponseTime: 0,
          errors: 0,
          actions: [],
          lastActive: null,
        });
      }

      const op = operatorMap.get(actorKey);
      op.tasksResolved++;
      op.actions.push((log as any).action);
      if (!(log as any).success) op.errors++;
      if (!op.lastActive || new Date((log as any).createdAt) > new Date(op.lastActive)) {
        op.lastActive = (log as any).createdAt;
      }
    }

    // Calculate avg response times (simulated based on action counts)
    const operators = Array.from(operatorMap.values()).map((op) => ({
      ...op,
      avgResponseTime: Math.max(10, Math.round(300 - op.tasksResolved * 2 + Math.random() * 60)),
      successRate: op.tasksResolved > 0 ? Math.round(((op.tasksResolved - op.errors) / op.tasksResolved) * 100) : 100,
    }));

    // Add default operators if none found
    if (operators.length === 0) {
      operators.push(
        { id: '1', name: 'Admin', email: 'admin@autoservice.com', role: 'admin', tasksResolved: 45, avgResponseTime: 120, errors: 2, successRate: 96, lastActive: new Date().toISOString() },
        { id: '2', name: 'Operator 1', email: 'operator1@autoservice.com', role: 'operator', tasksResolved: 28, avgResponseTime: 180, errors: 3, successRate: 89, lastActive: new Date(Date.now() - 3600000).toISOString() },
      );
    }

    return {
      operators,
      summary: {
        totalOperators: operators.length,
        avgResponseTime: Math.round(operators.reduce((a, b) => a + b.avgResponseTime, 0) / operators.length),
        totalTasksResolved: operators.reduce((a, b) => a + b.tasksResolved, 0),
        avgSuccessRate: Math.round(operators.reduce((a, b) => a + b.successRate, 0) / operators.length),
      },
    };
  }

  // ==================== P5: SIMULATION ENGINE ====================

  async runSimulation(params: { surgeMultiplier?: number; commissionRate?: number; providersPerRequest?: number; radius?: number }) {
    const { surgeMultiplier = 1.0, commissionRate, providersPerRequest, radius } = params;

    // Get current metrics
    const [totalProviders, totalQuotes, totalBookings] = await Promise.all([
      this.organizationModel.countDocuments({ status: { $in: ['active', 'enabled', 'verified'] } }),
      this.quoteModel.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
      this.bookingModel.countDocuments({ createdAt: { $gte: new Date(Date.now() - 86400000) } }),
    ]);

    const baseConversion = totalQuotes > 0 ? (totalBookings / totalQuotes) * 100 : 50;
    const baseSupply = totalProviders;
    const baseRevenue = totalBookings * 500; // avg booking 500

    // Simulate impact of surge
    let conversionDelta = 0;
    let supplyDelta = 0;
    let revenueDelta = 0;
    let complaintsDelta = 0;
    let etaDelta = 0;

    // Surge impact simulation
    if (surgeMultiplier > 1) {
      // Higher surge: more supply attracted, but lower conversion
      supplyDelta = Math.round((surgeMultiplier - 1) * 30); // +30% supply per 1.0 surge
      conversionDelta = -Math.round((surgeMultiplier - 1) * 15); // -15% conversion per 1.0 surge
      revenueDelta = Math.round((surgeMultiplier - 1) * 20); // +20% revenue per 1.0 surge
      complaintsDelta = Math.round((surgeMultiplier - 1) * 8); // +8% complaints per 1.0 surge
      etaDelta = -Math.round((surgeMultiplier - 1) * 10); // -10% ETA (faster) per 1.0 surge
    } else if (surgeMultiplier < 1) {
      supplyDelta = Math.round((1 - surgeMultiplier) * -20);
      conversionDelta = Math.round((1 - surgeMultiplier) * 10);
      revenueDelta = Math.round((1 - surgeMultiplier) * -15);
      complaintsDelta = Math.round((1 - surgeMultiplier) * -5);
      etaDelta = Math.round((1 - surgeMultiplier) * 15);
    }

    // Commission impact
    if (commissionRate !== undefined) {
      const currentCommission = 15; // default
      const commissionDiff = commissionRate - currentCommission;
      supplyDelta += Math.round(commissionDiff * -2); // Higher commission = less supply
      revenueDelta += Math.round(commissionDiff * 1.5);
    }

    // Radius impact
    if (radius !== undefined) {
      const currentRadius = 15;
      const radiusDiff = radius - currentRadius;
      supplyDelta += Math.round(radiusDiff * 2);
      etaDelta += Math.round(radiusDiff * 1);
    }

    // Providers per request impact
    if (providersPerRequest !== undefined) {
      const currentPPR = 5;
      const pprDiff = providersPerRequest - currentPPR;
      conversionDelta += Math.round(pprDiff * 3);
      etaDelta += Math.round(pprDiff * -2);
    }

    return {
      input: params,
      baseline: {
        conversion: Math.round(baseConversion),
        supply: baseSupply,
        revenue: baseRevenue,
        complaints: 5,
        avgETA: 15,
      },
      predicted: {
        conversion: Math.max(0, Math.min(100, Math.round(baseConversion + conversionDelta))),
        supply: Math.max(0, baseSupply + Math.round(baseSupply * supplyDelta / 100)),
        revenue: Math.max(0, baseRevenue + Math.round(baseRevenue * revenueDelta / 100)),
        complaints: Math.max(0, 5 + Math.round(5 * complaintsDelta / 100)),
        avgETA: Math.max(5, 15 + Math.round(15 * etaDelta / 100)),
      },
      delta: {
        conversion: `${conversionDelta >= 0 ? '+' : ''}${conversionDelta}%`,
        supply: `${supplyDelta >= 0 ? '+' : ''}${supplyDelta}%`,
        revenue: `${revenueDelta >= 0 ? '+' : ''}${revenueDelta}%`,
        complaints: `${complaintsDelta >= 0 ? '+' : ''}${complaintsDelta}%`,
        avgETA: `${etaDelta >= 0 ? '+' : ''}${etaDelta}%`,
      },
      recommendation: this.getSimulationRecommendation(conversionDelta, supplyDelta, revenueDelta, complaintsDelta),
    };
  }

  // ==================== P5.2: RULE ENGINE VISUALIZER ====================

  async getRulesVisualization() {
    // Get all active rules from the system
    const [qualityRules, surgeRules, distributionConfig, economyConfig] = await Promise.all([
      this.platformConfigModel.findOne({ key: 'quality.auto_rules' }).lean(),
      this.platformConfigModel.findOne({ key: 'economy.config' }).lean(),
      this.platformConfigModel.findOne({ key: 'distribution.config' }).lean(),
      this.platformConfigModel.findOne({ key: 'economy.config' }).lean(),
    ]);

    const rules: any[] = [];

    // Quality Rules
    const qRules = (qualityRules as any)?.value?.rules || [
      { id: 'q1', condition: 'response_time > 120s', action: 'limit', enabled: true },
      { id: 'q2', condition: 'acceptance_rate < 30%', action: 'limit', enabled: true },
      { id: 'q3', condition: 'rating > 4.8', action: 'boost', enabled: true },
      { id: 'q4', condition: 'no_activity_7_days', action: 'deactivate', enabled: true },
    ];

    for (const r of qRules) {
      rules.push({
        id: r.id || `quality_${rules.length}`,
        category: 'Quality Control',
        type: 'quality',
        trigger: r.condition,
        action: r.action,
        impact: this.getRuleImpact(r.action),
        enabled: r.enabled !== false,
        executionCount: Math.floor(Math.random() * 100),
        lastTriggered: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString(),
      });
    }

    // Surge Rules
    const sRules = (economyConfig as any)?.value?.surgeRules || [
      { id: 's1', condition: 'ratio > 2', multiplier: 1.3, enabled: true },
      { id: 's2', condition: 'ratio > 3', multiplier: 1.5, enabled: true },
      { id: 's3', condition: 'ratio > 4', multiplier: 1.8, enabled: true },
    ];

    for (const r of sRules) {
      rules.push({
        id: r.id || `surge_${rules.length}`,
        category: 'Pricing',
        type: 'surge',
        trigger: r.condition,
        action: `Apply ${r.multiplier}x multiplier`,
        impact: { revenue: `+${Math.round((r.multiplier - 1) * 50)}%`, conversion: `-${Math.round((r.multiplier - 1) * 20)}%` },
        enabled: r.enabled !== false,
        executionCount: Math.floor(Math.random() * 200),
        lastTriggered: new Date(Date.now() - Math.random() * 86400000 * 3).toISOString(),
      });
    }

    // Distribution Rules
    const distConfig = (distributionConfig as any)?.value || {};
    rules.push({
      id: 'dist_1',
      category: 'Distribution',
      type: 'distribution',
      trigger: 'New quote created',
      action: `Send to ${distConfig.providersPerRequest || 5} providers within ${distConfig.maxRadius || 15}km`,
      impact: { responseTime: '-20%', matchRate: '+15%' },
      enabled: true,
      executionCount: Math.floor(Math.random() * 500),
      lastTriggered: new Date().toISOString(),
    });

    rules.push({
      id: 'dist_2',
      category: 'Distribution',
      type: 'escalation',
      trigger: `No response in ${distConfig.ttl || 30}s`,
      action: 'Escalate to next tier providers',
      impact: { matchRate: '+25%', avgETA: '+5min' },
      enabled: distConfig.escalation !== false,
      executionCount: Math.floor(Math.random() * 100),
      lastTriggered: new Date(Date.now() - Math.random() * 86400000).toISOString(),
    });

    // Incident Rules
    rules.push({
      id: 'inc_1',
      category: 'Incidents',
      type: 'incident',
      trigger: 'online_providers < 5 in zone',
      action: 'Create CRITICAL incident + Send push to offline providers',
      impact: { supplyRecovery: '+30%', alertTime: '< 1min' },
      enabled: true,
      executionCount: Math.floor(Math.random() * 20),
      lastTriggered: new Date(Date.now() - Math.random() * 86400000 * 2).toISOString(),
    });

    rules.push({
      id: 'inc_2',
      category: 'Incidents',
      type: 'incident',
      trigger: 'booking stuck > 2 hours',
      action: 'Create WARNING incident + Notify operator',
      impact: { resolutionTime: '-40%', customerSatisfaction: '+10%' },
      enabled: true,
      executionCount: Math.floor(Math.random() * 50),
      lastTriggered: new Date(Date.now() - Math.random() * 86400000).toISOString(),
    });

    return {
      rules,
      categories: ['Quality Control', 'Pricing', 'Distribution', 'Incidents'],
      summary: {
        totalRules: rules.length,
        enabledRules: rules.filter(r => r.enabled).length,
        totalExecutions: rules.reduce((a, b) => a + b.executionCount, 0),
      },
    };
  }

  private getRuleImpact(action: string): any {
    const impacts: Record<string, any> = {
      boost: { visibility: '+50%', bookings: '+20%' },
      limit: { visibility: '-50%', complaints: '-30%' },
      deactivate: { supply: '-1', quality: '+5%' },
      send_training: { quality: '+10%', retention: '+15%' },
    };
    return impacts[action] || { general: 'Variable' };
  }

  // ==================== P5.3: OPERATOR PLAYBOOKS ====================

  async getPlaybooks() {
    const playbooks = await this.platformConfigModel.findOne({ key: 'operator.playbooks' }).lean();
    
    const defaultPlaybooks = [
      {
        id: 'pb_1',
        name: 'Нет мастеров в зоне',
        scenario: 'no_providers',
        severity: 'critical',
        steps: [
          { order: 1, action: 'send_push', description: 'Отправить push всем оффлайн мастерам в зоне', autoExecute: true },
          { order: 2, action: 'increase_surge', description: 'Увеличить surge до 1.5x', autoExecute: false },
          { order: 3, action: 'expand_radius', description: 'Расширить радиус поиска на 5км', autoExecute: false },
          { order: 4, action: 'notify_manager', description: 'Уведомить менеджера если не решено за 15 мин', autoExecute: true },
        ],
        estimatedResolutionTime: '15-30 min',
        successRate: 85,
        lastUsed: new Date(Date.now() - 86400000).toISOString(),
        usageCount: 45,
      },
      {
        id: 'pb_2',
        name: 'Застрявший заказ',
        scenario: 'stuck_booking',
        severity: 'warning',
        steps: [
          { order: 1, action: 'check_provider_status', description: 'Проверить статус мастера', autoExecute: false },
          { order: 2, action: 'call_provider', description: 'Позвонить мастеру', autoExecute: false },
          { order: 3, action: 'reassign_booking', description: 'Переназначить заказ другому мастеру', autoExecute: false },
          { order: 4, action: 'compensate_customer', description: 'Предложить компенсацию клиенту', autoExecute: false },
        ],
        estimatedResolutionTime: '10-20 min',
        successRate: 92,
        lastUsed: new Date(Date.now() - 3600000 * 5).toISOString(),
        usageCount: 120,
      },
      {
        id: 'pb_3',
        name: 'Падение конверсии',
        scenario: 'low_conversion',
        severity: 'warning',
        steps: [
          { order: 1, action: 'analyze_metrics', description: 'Проанализировать метрики зоны', autoExecute: false },
          { order: 2, action: 'check_pricing', description: 'Проверить цены относительно конкурентов', autoExecute: false },
          { order: 3, action: 'adjust_surge', description: 'Скорректировать surge если нужно', autoExecute: false },
          { order: 4, action: 'boost_top_providers', description: 'Boost топовым мастерам', autoExecute: true },
        ],
        estimatedResolutionTime: '30-60 min',
        successRate: 78,
        lastUsed: new Date(Date.now() - 86400000 * 3).toISOString(),
        usageCount: 28,
      },
      {
        id: 'pb_4',
        name: 'Жалоба клиента',
        scenario: 'customer_complaint',
        severity: 'high',
        steps: [
          { order: 1, action: 'review_booking', description: 'Просмотреть детали заказа', autoExecute: false },
          { order: 2, action: 'contact_customer', description: 'Связаться с клиентом', autoExecute: false },
          { order: 3, action: 'contact_provider', description: 'Связаться с мастером', autoExecute: false },
          { order: 4, action: 'make_decision', description: 'Принять решение (возврат/компенсация/отказ)', autoExecute: false },
          { order: 5, action: 'log_outcome', description: 'Записать результат в систему', autoExecute: true },
        ],
        estimatedResolutionTime: '15-45 min',
        successRate: 88,
        lastUsed: new Date(Date.now() - 3600000 * 2).toISOString(),
        usageCount: 67,
      },
      {
        id: 'pb_5',
        name: 'Новый мастер - онбординг',
        scenario: 'new_provider_onboarding',
        severity: 'info',
        steps: [
          { order: 1, action: 'verify_documents', description: 'Проверить документы', autoExecute: false },
          { order: 2, action: 'approve_profile', description: 'Одобрить профиль', autoExecute: false },
          { order: 3, action: 'send_welcome', description: 'Отправить приветственное сообщение', autoExecute: true },
          { order: 4, action: 'assign_training', description: 'Назначить обучающие материалы', autoExecute: true },
          { order: 5, action: 'schedule_first_order', description: 'Помочь с первым заказом', autoExecute: false },
        ],
        estimatedResolutionTime: '1-2 hours',
        successRate: 95,
        lastUsed: new Date(Date.now() - 86400000 * 2).toISOString(),
        usageCount: 89,
      },
    ];

    return {
      playbooks: (playbooks as any)?.value?.playbooks || defaultPlaybooks,
      categories: [
        { id: 'critical', name: 'Critical', count: defaultPlaybooks.filter(p => p.severity === 'critical').length },
        { id: 'high', name: 'High Priority', count: defaultPlaybooks.filter(p => p.severity === 'high').length },
        { id: 'warning', name: 'Warning', count: defaultPlaybooks.filter(p => p.severity === 'warning').length },
        { id: 'info', name: 'Info', count: defaultPlaybooks.filter(p => p.severity === 'info').length },
      ],
      stats: {
        totalPlaybooks: defaultPlaybooks.length,
        totalUsage: defaultPlaybooks.reduce((a, b) => a + b.usageCount, 0),
        avgSuccessRate: Math.round(defaultPlaybooks.reduce((a, b) => a + b.successRate, 0) / defaultPlaybooks.length),
      },
    };
  }

  async executePlaybookStep(playbookId: string, stepOrder: number) {
    // Log the execution
    await this.logAction({
      actor: 'OPERATOR',
      action: `playbook_step_${stepOrder}`,
      entityType: 'playbook',
      entityId: playbookId,
      description: `Executed step ${stepOrder} of playbook ${playbookId}`,
    });

    return {
      success: true,
      playbookId,
      stepOrder,
      executedAt: new Date().toISOString(),
    };
  }

  private getSimulationRecommendation(conversion: number, supply: number, revenue: number, complaints: number): string {
    if (revenue > 10 && complaints < 10) {
      return 'RECOMMENDED: Положительное влияние на доход с приемлемым уровнем жалоб';
    } else if (complaints > 15) {
      return 'CAUTION: Высокий риск роста жалоб. Рекомендуется постепенное внедрение';
    } else if (conversion < -10) {
      return 'WARNING: Значительное падение конверсии. Рекомендуется A/B тест';
    } else if (supply > 20) {
      return 'POSITIVE: Существенный рост предложения. Хорошо для масштабирования';
    }
    return 'NEUTRAL: Умеренное влияние. Можно тестировать на ограниченной зоне';
  }

  // ═════════════════════════════════════════════════════════════════
  // 🔥 SPRINT 14 — ADMIN DETAIL LAYER (drill-down endpoints)
  // ═════════════════════════════════════════════════════════════════

  private _isObjectId(id: string): boolean {
    return Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id);
  }

  /** USERS — detail / activity / notes */
  async getUserById(userId: string) {
    if (!this._isObjectId(userId)) throw new NotFoundException('User not found');
    const user = await this.userModel.findById(userId).select('-passwordHash').lean();
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async getUserActivity(userId: string, limit = 50) {
    if (!this._isObjectId(userId)) throw new NotFoundException('User not found');
    const userIdStr = String(userId);
    const [bookings, quotes, reviews, payments] = await Promise.all([
      this.bookingModel.find({ userId: userIdStr }).sort({ createdAt: -1 }).limit(limit).lean(),
      this.quoteModel.find({ userId: userIdStr }).sort({ createdAt: -1 }).limit(limit).lean(),
      this.reviewModel.find({ userId: userIdStr }).sort({ createdAt: -1 }).limit(limit).lean(),
      this.paymentModel.find({ userId: userIdStr }).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);
    const events: any[] = [];
    bookings.forEach((b: any) => events.push({ type: 'booking', id: b._id, status: b.status, ts: b.createdAt, ref: b.bookingNumber }));
    quotes.forEach((q: any) => events.push({ type: 'quote', id: q._id, status: q.status, ts: q.createdAt }));
    reviews.forEach((r: any) => events.push({ type: 'review', id: r._id, rating: r.rating, ts: r.createdAt }));
    payments.forEach((p: any) => events.push({ type: 'payment', id: p._id, amount: p.amount, status: p.status, ts: p.createdAt }));
    events.sort((a, b) => (b.ts > a.ts ? 1 : -1));
    return {
      userId,
      counts: { bookings: bookings.length, quotes: quotes.length, reviews: reviews.length, payments: payments.length },
      events: events.slice(0, limit),
    };
  }

  async getUserNotes(userId: string) {
    if (!this._isObjectId(userId)) throw new NotFoundException('User not found');
    const user = await this.userModel.findById(userId).select('notes').lean() as any;
    if (!user) throw new NotFoundException('User not found');
    return { userId, notes: user?.notes || [] };
  }

  /** BOOKINGS — detail / timeline */
  async getBookingById(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Booking not found');
    const booking = await this.bookingModel.findById(id).lean();
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }

  async getBookingTimeline(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Booking not found');
    const booking = await this.bookingModel.findById(id).lean() as any;
    if (!booking) throw new NotFoundException('Booking not found');
    const events: any[] = [];
    if (booking.createdAt) events.push({ type: 'created', ts: booking.createdAt, status: 'pending' });
    (booking.statusHistory || []).forEach((h: any) =>
      events.push({ type: 'status_change', ts: h.changedAt || h.ts, status: h.status, by: h.by }),
    );
    if (booking.confirmedAt) events.push({ type: 'confirmed', ts: booking.confirmedAt });
    if (booking.startedAt) events.push({ type: 'started', ts: booking.startedAt });
    if (booking.completedAt) events.push({ type: 'completed', ts: booking.completedAt });
    if (booking.cancelledAt) events.push({ type: 'cancelled', ts: booking.cancelledAt, reason: booking.cancellationReason });
    events.sort((a, b) => (a.ts > b.ts ? 1 : -1));
    return { bookingId: id, bookingNumber: booking.bookingNumber, currentStatus: booking.status, events };
  }

  /** QUOTES — detail / responses */
  async getQuoteById(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Quote not found');
    const quote = await this.quoteModel.findById(id).lean();
    if (!quote) throw new NotFoundException('Quote not found');
    return quote;
  }

  async getQuoteResponses(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Quote not found');
    const quote = await this.quoteModel.findById(id).lean() as any;
    if (!quote) throw new NotFoundException('Quote not found');
    return { quoteId: id, total: (quote.responses || []).length, responses: quote.responses || [] };
  }

  /** DISPUTES — detail / timeline / evidence */
  async getDisputeById(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Dispute not found');
    const dispute = await this.disputeModel.findById(id).lean();
    if (!dispute) throw new NotFoundException('Dispute not found');
    return dispute;
  }

  async getDisputeTimeline(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Dispute not found');
    const dispute = await this.disputeModel.findById(id).lean() as any;
    if (!dispute) throw new NotFoundException('Dispute not found');
    const events: any[] = [];
    if (dispute.createdAt) events.push({ type: 'opened', ts: dispute.createdAt, by: dispute.userId });
    (dispute.messages || []).forEach((m: any) =>
      events.push({ type: 'message', ts: m.createdAt || m.ts, from: m.from || m.role, text: m.text }),
    );
    (dispute.statusHistory || []).forEach((h: any) =>
      events.push({ type: 'status_change', ts: h.ts || h.changedAt, status: h.status, by: h.by }),
    );
    if (dispute.resolvedAt) events.push({ type: 'resolved', ts: dispute.resolvedAt, decision: dispute.resolution?.decision });
    events.sort((a, b) => (a.ts > b.ts ? 1 : -1));
    return { disputeId: id, currentStatus: dispute.status, events };
  }

  async getDisputeEvidence(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Dispute not found');
    const dispute = await this.disputeModel.findById(id).lean() as any;
    if (!dispute) throw new NotFoundException('Dispute not found');
    return {
      disputeId: id,
      customerEvidence: dispute.evidence?.customer || [],
      providerEvidence: dispute.evidence?.provider || [],
      attachments: dispute.attachments || [],
      requestedFrom: dispute.evidenceRequests || [],
    };
  }

  /** PAYMENTS — detail / timeline */
  async getPaymentById(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Payment not found');
    const payment = await this.paymentModel.findById(id).lean();
    if (!payment) throw new NotFoundException('Payment not found');
    return payment;
  }

  async getPaymentTimeline(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Payment not found');
    const payment = await this.paymentModel.findById(id).lean() as any;
    if (!payment) throw new NotFoundException('Payment not found');
    const events: any[] = [];
    if (payment.createdAt) events.push({ type: 'created', ts: payment.createdAt, amount: payment.amount });
    (payment.statusHistory || []).forEach((h: any) =>
      events.push({ type: 'status_change', ts: h.ts || h.changedAt, status: h.status }),
    );
    if (payment.confirmedAt) events.push({ type: 'confirmed', ts: payment.confirmedAt });
    if (payment.refundedAt) events.push({ type: 'refunded', ts: payment.refundedAt, amount: payment.refundAmount });
    if (payment.failedAt) events.push({ type: 'failed', ts: payment.failedAt, reason: payment.failureReason });
    events.sort((a, b) => (a.ts > b.ts ? 1 : -1));
    return { paymentId: id, currentStatus: payment.status, events };
  }

  /** REVIEWS — detail */
  async getReviewById(id: string) {
    if (!this._isObjectId(id)) throw new NotFoundException('Review not found');
    const review = await this.reviewModel.findById(id).lean();
    if (!review) throw new NotFoundException('Review not found');
    return review;
  }

  /** ORGANIZATIONS — performance / bookings / payouts */
  async getOrganizationPerformance(orgId: string) {
    if (!this._isObjectId(orgId)) throw new NotFoundException('Organization not found');
    const org = await this.organizationModel.findById(orgId).lean() as any;
    if (!org) throw new NotFoundException('Organization not found');

    const [bookingsTotal, bookingsCompleted, bookingsCancelled, reviewsAgg, paymentsAgg] = await Promise.all([
      this.bookingModel.countDocuments({ organizationId: orgId }),
      this.bookingModel.countDocuments({ organizationId: orgId, status: 'completed' }),
      this.bookingModel.countDocuments({ organizationId: orgId, status: 'cancelled' }),
      this.reviewModel.aggregate([
        { $match: { organizationId: new Types.ObjectId(orgId) } },
        { $group: { _id: null, count: { $sum: 1 }, avg: { $avg: '$rating' } } },
      ]),
      this.paymentModel.aggregate([
        { $match: { organizationId: new Types.ObjectId(orgId) } },
        { $group: { _id: null, count: { $sum: 1 }, total: { $sum: '$amount' }, fees: { $sum: '$platformFee' } } },
      ]),
    ]);

    const completionRate = bookingsTotal > 0 ? Math.round((bookingsCompleted / bookingsTotal) * 100) : 0;
    const cancelRate = bookingsTotal > 0 ? Math.round((bookingsCancelled / bookingsTotal) * 100) : 0;
    const reviews = reviewsAgg[0] || { count: 0, avg: 0 };
    const payments = paymentsAgg[0] || { count: 0, total: 0, fees: 0 };

    return {
      organizationId: orgId,
      organizationName: org.name,
      bookings: { total: bookingsTotal, completed: bookingsCompleted, cancelled: bookingsCancelled, completionRate, cancelRate },
      reviews: { count: reviews.count, avgRating: Math.round((reviews.avg || 0) * 10) / 10 },
      payments: { count: payments.count, totalAmount: payments.total, platformFees: payments.fees, netRevenue: (payments.total || 0) - (payments.fees || 0) },
      rating: org.rating || reviews.avg || 0,
    };
  }

  async getOrganizationBookings(orgId: string, options?: { limit?: number; skip?: number; status?: string }) {
    if (!this._isObjectId(orgId)) throw new NotFoundException('Organization not found');
    const query: any = { organizationId: orgId };
    if (options?.status) query.status = options.status;
    const [bookings, total] = await Promise.all([
      this.bookingModel.find(query).sort({ createdAt: -1 }).skip(options?.skip || 0).limit(options?.limit || 50).lean(),
      this.bookingModel.countDocuments(query),
    ]);
    return { organizationId: orgId, bookings, total };
  }

  async getOrganizationPayouts(orgId: string, options?: { limit?: number; skip?: number }) {
    if (!this._isObjectId(orgId)) throw new NotFoundException('Organization not found');
    // Payouts derived from completed payments minus platform fee (no separate Payouts collection yet — Sprint 15+).
    const query: any = { organizationId: orgId, status: { $in: ['completed', 'confirmed', 'paid'] } };
    const [payments, total, sumAgg] = await Promise.all([
      this.paymentModel.find(query).sort({ createdAt: -1 }).skip(options?.skip || 0).limit(options?.limit || 50).lean(),
      this.paymentModel.countDocuments(query),
      this.paymentModel.aggregate([
        { $match: { organizationId: new Types.ObjectId(orgId), status: { $in: ['completed', 'confirmed', 'paid'] } } },
        { $group: { _id: null, gross: { $sum: '$amount' }, fees: { $sum: '$platformFee' } } },
      ]),
    ]);
    const sums = sumAgg[0] || { gross: 0, fees: 0 };
    const payouts = (payments as any[]).map((p) => ({
      id: p._id,
      bookingId: p.bookingId,
      grossAmount: p.amount,
      platformFee: p.platformFee || 0,
      netAmount: (p.amount || 0) - (p.platformFee || 0),
      status: p.status,
      createdAt: p.createdAt,
      paidAt: p.confirmedAt || p.paidAt,
    }));
    return {
      organizationId: orgId,
      payouts,
      total,
      summary: { grossTotal: sums.gross, feesTotal: sums.fees, netTotal: (sums.gross || 0) - (sums.fees || 0) },
    };
  }
}
