import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';
import { UserRole } from '../../shared/enums';
import { PlatformConfigService } from '../platform-config/platform-config.service';

@ApiTags('Admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly configService: PlatformConfigService,
  ) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Get dashboard stats' })
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  // Users
  @Get('users')
  @ApiOperation({ summary: 'Get all users' })
  @ApiQuery({ name: 'role', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getUsers(
    @Query('role') role?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getUsers({
      role,
      search,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  @Post('users/:id/block')
  @ApiOperation({ summary: 'Block user' })
  blockUser(@Param('id') id: string) {
    return this.adminService.blockUser(id);
  }

  @Post('users/:id/unblock')
  @ApiOperation({ summary: 'Unblock user' })
  unblockUser(@Param('id') id: string) {
    return this.adminService.unblockUser(id);
  }

  // Organizations
  @Get('organizations')
  @ApiOperation({ summary: 'Get all organizations' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getOrganizations(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getOrganizations({
      status,
      search,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  @Get('organizations/:id')
  @ApiOperation({ summary: 'Get organization by id' })
  getOrganization(@Param('id') id: string) {
    return this.adminService.getOrganization(id);
  }

  @Post('organizations/:id/disable')
  @ApiOperation({ summary: 'Disable organization' })
  disableOrganization(@Param('id') id: string) {
    return this.adminService.disableOrganization(id);
  }

  @Post('organizations/:id/enable')
  @ApiOperation({ summary: 'Enable organization' })
  enableOrganization(@Param('id') id: string) {
    return this.adminService.enableOrganization(id);
  }

  // Bookings
  @Get('bookings')
  @ApiOperation({ summary: 'Get all bookings' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getBookings(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getBookings({
      status,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // Payments
  @Get('payments')
  @ApiOperation({ summary: 'Get all payments' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getPayments(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getPayments({
      status,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // Disputes
  @Get('disputes')
  @ApiOperation({ summary: 'Get all disputes' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getDisputes(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getDisputes({
      status,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // Reviews
  @Get('reviews')
  @ApiOperation({ summary: 'Get all reviews' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getReviews(
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getReviews({
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // ==================== Platform Config ====================

  @Get('config')
  @ApiOperation({ summary: 'Get all platform configuration' })
  getConfig() {
    return this.configService.getAll(false);
  }

  @Post('config')
  @ApiOperation({ summary: 'Set a platform configuration value' })
  setConfig(@Body() body: { key: string; value: any }) {
    return this.configService.set(body.key, body.value);
  }

  // ═══════ 🔥 OPERATOR MODE — РУЧНОЕ УПРАВЛЕНИЕ ЗАЯВКАМИ ═══════

  /**
   * Create quote manually (operator mode)
   * ТЫ = ОПЕРАТОР
   */
  @Post('quotes/manual')
  @ApiOperation({ summary: 'Create quote manually (operator mode)' })
  createManualQuote(
    @Body() dto: {
      customerPhone: string;
      customerName?: string;
      description: string;
      serviceType?: string;
      location?: { lat: number; lng: number };
      urgency?: 'low' | 'normal' | 'urgent';
      notes?: string;
    },
  ) {
    return this.adminService.createManualQuote(dto);
  }

  /**
   * Get all quotes with response tracking
   */
  @Get('quotes/all')
  @ApiOperation({ summary: 'Get all quotes with tracking' })
  getAllQuotes(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    return this.adminService.getAllQuotesWithTracking({
      status,
      limit: limit ? parseInt(limit) : 20,
      page: page ? parseInt(page) : 1,
    });
  }

  /**
   * Get quote details with distribution info
   */
  @Get('quotes/:id/details')
  @ApiOperation({ summary: 'Get quote details with distributions' })
  getQuoteDetailsWithDistributions(@Param('id') id: string) {
    return this.adminService.getQuoteDetailsWithDistributions(id);
  }

  /**
   * Distribute quote to specific providers
   */
  @Post('quotes/:id/distribute')
  @ApiOperation({ summary: 'Distribute quote to providers' })
  distributeQuoteToProviders(
    @Param('id') quoteId: string,
    @Body() dto: { organizationIds: string[] },
  ) {
    return this.adminService.distributeQuoteToProviders(quoteId, dto.organizationIds);
  }

  /**
   * Close quote (match client with provider)
   */
  @Post('quotes/:id/close')
  @ApiOperation({ summary: 'Close quote with provider' })
  closeQuoteWithProvider(
    @Param('id') quoteId: string,
    @Body() dto: { 
      organizationId: string;
      price?: number;
      notes?: string;
    },
  ) {
    return this.adminService.closeQuoteWithProvider(quoteId, dto);
  }

  /**
   * Get provider response metrics
   */
  @Get('providers/:id/metrics')
  @ApiOperation({ summary: 'Get provider behavioral metrics' })
  getProviderMetrics(@Param('id') id: string) {
    return this.adminService.getProviderBehavioralMetrics(id);
  }

  /**
   * Get market health metrics
   */
  @Get('metrics/market')
  @ApiOperation({ summary: 'Get market health metrics' })
  getMarketMetrics() {
    return this.adminService.getMarketHealthMetrics();
  }

  /**
   * Get response time metrics
   */
  @Get('metrics/response')
  @ApiOperation({ summary: 'Get response time metrics' })
  getResponseMetrics() {
    return this.adminService.getResponseTimeMetrics();
  }

  // ==================== AUDIT LOG ====================

  @Get('audit-log')
  @ApiOperation({ summary: 'Get audit logs' })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'entityType', required: false })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getAuditLog(
    @Query('userId') userId?: string,
    @Query('actor') actor?: string,
    @Query('action') action?: string,
    @Query('entityType') entityType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getAuditLogs({
      userId,
      actor,
      action,
      entityType,
      dateFrom,
      dateTo,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // ==================== GLOBAL SEARCH ====================

  @Get('search')
  @ApiOperation({ summary: 'Global search across all entities' })
  @ApiQuery({ name: 'q', required: true })
  globalSearch(@Query('q') query: string) {
    return this.adminService.globalSearch(query);
  }

  // ==================== NOTIFICATIONS ADMIN ====================

  @Get('notifications/templates')
  @ApiOperation({ summary: 'Get notification templates' })
  getNotificationTemplates() {
    return this.adminService.getNotificationTemplates();
  }

  @Post('notifications/templates')
  @ApiOperation({ summary: 'Create notification template' })
  createNotificationTemplate(@Body() body: any) {
    return this.adminService.createNotificationTemplate(body);
  }

  @Patch('notifications/templates/:id')
  @ApiOperation({ summary: 'Update notification template' })
  updateNotificationTemplate(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateNotificationTemplate(id, body);
  }

  @Post('notifications/bulk')
  @ApiOperation({ summary: 'Send bulk notification' })
  sendBulkNotification(@Req() req: any, @Body() body: any) {
    return this.adminService.sendBulkNotification(req.user.sub, body);
  }

  @Get('notifications/history')
  @ApiOperation({ summary: 'Get bulk notifications history' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'skip', required: false })
  getBulkNotifications(
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getBulkNotifications({
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  // ==================== REPORTS & EXPORT ====================

  @Get('reports/:type')
  @ApiOperation({ summary: 'Get report data' })
  @ApiQuery({ name: 'dateFrom', required: false })
  @ApiQuery({ name: 'dateTo', required: false })
  @ApiQuery({ name: 'groupBy', required: false })
  getReport(
    @Param('type') type: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('groupBy') groupBy?: string,
  ) {
    return this.adminService.getReport(type, { dateFrom, dateTo, groupBy });
  }

  @Get('export/:entity')
  @ApiOperation({ summary: 'Export data as CSV' })
  exportData(@Param('entity') entity: string, @Query() params: any) {
    return this.adminService.exportData(entity, params);
  }

  // ==================== FEATURE FLAGS ====================

  @Get('feature-flags')
  @ApiOperation({ summary: 'Get all feature flags' })
  getFeatureFlags() {
    return this.adminService.getFeatureFlags();
  }

  @Post('feature-flags')
  @ApiOperation({ summary: 'Create feature flag' })
  createFeatureFlag(@Body() body: any) {
    return this.adminService.createFeatureFlag(body);
  }

  @Patch('feature-flags/:id')
  @ApiOperation({ summary: 'Update feature flag' })
  updateFeatureFlag(@Param('id') id: string, @Body() body: any) {
    return this.adminService.updateFeatureFlag(id, body);
  }

  @Post('feature-flags/:key/toggle')
  @ApiOperation({ summary: 'Toggle feature flag' })
  toggleFeatureFlag(@Param('key') key: string, @Body('enabled') enabled: boolean) {
    return this.adminService.toggleFeatureFlag(key, enabled);
  }

  // ==================== EXPERIMENTS ====================

  @Get('experiments')
  @ApiOperation({ summary: 'Get all experiments' })
  getExperiments() {
    return this.adminService.getExperiments();
  }

  @Post('experiments')
  @ApiOperation({ summary: 'Create experiment' })
  createExperiment(@Body() body: any) {
    return this.adminService.createExperiment(body);
  }

  @Patch('experiments/:id/status')
  @ApiOperation({ summary: 'Update experiment status' })
  updateExperimentStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.adminService.updateExperimentStatus(id, status);
  }

  // ==================== AUTO-SUGGESTED ACTIONS ====================

  @Get('suggestions')
  @ApiOperation({ summary: 'Get auto-suggested actions' })
  getSuggestions() {
    return this.adminService.getSuggestions();
  }

  @Post('suggestions/:id/execute')
  @ApiOperation({ summary: 'Execute suggested action' })
  executeSuggestionAction(
    @Param('id') suggestionId: string,
    @Body('actionId') actionId: string,
    @Req() req: any,
  ) {
    return this.adminService.executeSuggestionAction(suggestionId, actionId, req.user?.sub);
  }

  // ==================== REPUTATION CONTROL ====================

  @Get('providers/:id/reputation')
  @ApiOperation({ summary: 'Get provider reputation data' })
  getProviderReputation(@Param('id') id: string) {
    return this.adminService.getProviderReputation(id);
  }

  @Post('providers/:id/reputation/rating')
  @ApiOperation({ summary: 'Adjust provider rating' })
  adjustProviderRating(
    @Param('id') id: string,
    @Body() body: { newRating: number; reason: string },
    @Req() req: any,
  ) {
    return this.adminService.adjustProviderRating(id, { ...body, performedBy: req.user?.sub });
  }

  @Post('reviews/:id/hide')
  @ApiOperation({ summary: 'Hide review' })
  hideReview(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Req() req: any,
  ) {
    return this.adminService.hideReview(id, { reason, performedBy: req.user?.sub });
  }

  @Post('providers/:id/reputation/trust-flag')
  @ApiOperation({ summary: 'Add trust flag to provider' })
  addTrustFlag(
    @Param('id') id: string,
    @Body('flag') flag: string,
    @Req() req: any,
  ) {
    return this.adminService.addTrustFlag(id, { flag, performedBy: req.user?.sub });
  }

  @Post('providers/:id/reputation/penalize')
  @ApiOperation({ summary: 'Penalize provider' })
  penalizeProvider(
    @Param('id') id: string,
    @Body() body: { type: string; severity: number; reason: string },
    @Req() req: any,
  ) {
    return this.adminService.penalizeProvider(id, { ...body, performedBy: req.user?.sub });
  }

  // ==================== P4: SUPPLY QUALITY CONTROL ====================

  @Get('providers/quality')
  @ApiOperation({ summary: 'Get providers quality segmentation' })
  getProvidersQuality() {
    return this.adminService.getProvidersQuality();
  }

  @Post('providers/:id/quality-action')
  @ApiOperation({ summary: 'Execute quality action on provider' })
  executeQualityAction(
    @Param('id') id: string,
    @Body('action') action: string,
  ) {
    return this.adminService.executeQualityAction(id, action);
  }

  @Get('quality/auto-rules')
  @ApiOperation({ summary: 'Get auto quality rules' })
  getAutoRules() {
    return this.adminService.getAutoRules();
  }

  @Post('quality/auto-rules')
  @ApiOperation({ summary: 'Save auto quality rules' })
  saveAutoRules(@Body('rules') rules: any[]) {
    return this.adminService.saveAutoRules(rules);
  }

  // ==================== P4: ZONE CONTROL ====================

  @Get('zones/control')
  @ApiOperation({ summary: 'Get zones with control data' })
  getZonesControl() {
    return this.adminService.getZonesControl();
  }

  @Post('zones/:id/action')
  @ApiOperation({ summary: 'Execute zone action' })
  executeZoneAction(
    @Param('id') zoneId: string,
    @Body('action') action: string,
  ) {
    return this.adminService.executeZoneAction(zoneId, action);
  }

  // ==================== P4: ECONOMY CONTROL ====================

  @Get('economy')
  @ApiOperation({ summary: 'Get economy config' })
  getEconomyConfig() {
    return this.adminService.getEconomyConfig();
  }

  @Post('economy')
  @ApiOperation({ summary: 'Update economy config' })
  updateEconomyConfig(@Body() body: any) {
    return this.adminService.updateEconomyConfig(body);
  }

  // ==================== P4: DISTRIBUTION CONTROL ====================

  @Get('distribution/config')
  @ApiOperation({ summary: 'Get distribution config' })
  getDistributionConfig() {
    return this.adminService.getDistributionConfig();
  }

  @Post('distribution/config')
  @ApiOperation({ summary: 'Update distribution config' })
  updateDistributionConfig(@Body() body: any) {
    return this.adminService.updateDistributionConfig(body);
  }

  // ==================== P4: INCIDENT CONTROL ====================

  @Get('incidents')
  @ApiOperation({ summary: 'Get active incidents' })
  getIncidents() {
    return this.adminService.getIncidents();
  }

  @Post('incidents/:id/action')
  @ApiOperation({ summary: 'Execute incident action' })
  executeIncidentAction(
    @Param('id') incidentId: string,
    @Body('action') action: string,
  ) {
    return this.adminService.executeIncidentAction(incidentId, action);
  }

  // ==================== P4: SYSTEM HEALTH ====================

  @Get('system/health')
  @ApiOperation({ summary: 'Get system health metrics' })
  getSystemHealth() {
    return this.adminService.getSystemHealth();
  }

  // ==================== P4: DEMAND CONTROL ====================

  @Get('demand/control')
  @ApiOperation({ summary: 'Get demand control data' })
  getDemandControl() {
    return this.adminService.getDemandControl();
  }

  @Post('quotes/:id/force-action')
  @ApiOperation({ summary: 'Force action on quote' })
  forceQuoteAction(
    @Param('id') quoteId: string,
    @Body('action') action: string,
  ) {
    return this.adminService.forceQuoteAction(quoteId, action);
  }

  // ==================== P4: PROVIDER LIFECYCLE ====================

  @Get('providers/lifecycle')
  @ApiOperation({ summary: 'Get provider lifecycle data' })
  getProviderLifecycle() {
    return this.adminService.getProviderLifecycle();
  }

  @Post('providers/:id/lifecycle-action')
  @ApiOperation({ summary: 'Execute lifecycle action' })
  executeLifecycleAction(
    @Param('id') id: string,
    @Body('action') action: string,
  ) {
    return this.adminService.executeLifecycleAction(id, action);
  }

  // ==================== P4: OPERATOR PERFORMANCE ====================

  @Get('operators/performance')
  @ApiOperation({ summary: 'Get operator performance metrics' })
  getOperatorPerformance() {
    return this.adminService.getOperatorPerformance();
  }

  // ==================== P5: SIMULATION ENGINE ====================

  @Post('simulation/run')
  @ApiOperation({ summary: 'Run simulation with parameters' })
  runSimulation(@Body() body: { surgeMultiplier?: number; commissionRate?: number; providersPerRequest?: number; radius?: number }) {
    return this.adminService.runSimulation(body);
  }

  // ==================== P5.2: RULE ENGINE VISUALIZER ====================

  @Get('rules/visualizer')
  @ApiOperation({ summary: 'Get rules visualization' })
  getRulesVisualization() {
    return this.adminService.getRulesVisualization();
  }

  // ==================== P5.3: OPERATOR PLAYBOOKS ====================

  @Get('playbooks')
  @ApiOperation({ summary: 'Get operator playbooks' })
  getPlaybooks() {
    return this.adminService.getPlaybooks();
  }

  @Post('playbooks/:id/execute-step')
  @ApiOperation({ summary: 'Execute playbook step' })
  executePlaybookStep(
    @Param('id') id: string,
    @Body('stepOrder') stepOrder: number,
  ) {
    return this.adminService.executePlaybookStep(id, stepOrder);
  }

  // ═════════════════════════════════════════════════════════════════
  // 🔥 SPRINT 14 — ADMIN DETAIL LAYER
  // ═════════════════════════════════════════════════════════════════

  // Users — detail
  @Get('users/:id')
  @ApiOperation({ summary: 'Get user detail' })
  getUserById(@Param('id') id: string) {
    return this.adminService.getUserById(id);
  }

  @Get('users/:id/activity')
  @ApiOperation({ summary: 'Get user activity log' })
  getUserActivity(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.getUserActivity(id, limit ? parseInt(limit) : 50);
  }

  @Get('users/:id/notes')
  @ApiOperation({ summary: 'Get user moderation notes' })
  getUserNotes(@Param('id') id: string) {
    return this.adminService.getUserNotes(id);
  }

  // Bookings — detail
  @Get('bookings/:id')
  @ApiOperation({ summary: 'Get booking detail' })
  getBookingById(@Param('id') id: string) {
    return this.adminService.getBookingById(id);
  }

  @Get('bookings/:id/timeline')
  @ApiOperation({ summary: 'Get booking timeline' })
  getBookingTimeline(@Param('id') id: string) {
    return this.adminService.getBookingTimeline(id);
  }

  // Quotes — detail / responses
  @Get('quotes/:id')
  @ApiOperation({ summary: 'Get quote detail' })
  getQuoteById(@Param('id') id: string) {
    return this.adminService.getQuoteById(id);
  }

  @Get('quotes/:id/responses')
  @ApiOperation({ summary: 'Get quote responses (provider proposals)' })
  getQuoteResponses(@Param('id') id: string) {
    return this.adminService.getQuoteResponses(id);
  }

  // Disputes — detail / timeline / evidence
  @Get('disputes/:id')
  @ApiOperation({ summary: 'Get dispute detail' })
  getDisputeById(@Param('id') id: string) {
    return this.adminService.getDisputeById(id);
  }

  @Get('disputes/:id/timeline')
  @ApiOperation({ summary: 'Get dispute timeline' })
  getDisputeTimeline(@Param('id') id: string) {
    return this.adminService.getDisputeTimeline(id);
  }

  @Get('disputes/:id/evidence')
  @ApiOperation({ summary: 'Get dispute evidence' })
  getDisputeEvidence(@Param('id') id: string) {
    return this.adminService.getDisputeEvidence(id);
  }

  // Payments — detail / timeline
  @Get('payments/:id')
  @ApiOperation({ summary: 'Get payment detail' })
  getPaymentById(@Param('id') id: string) {
    return this.adminService.getPaymentById(id);
  }

  @Get('payments/:id/timeline')
  @ApiOperation({ summary: 'Get payment timeline' })
  getPaymentTimeline(@Param('id') id: string) {
    return this.adminService.getPaymentTimeline(id);
  }

  // Reviews — detail
  @Get('reviews/:id')
  @ApiOperation({ summary: 'Get review detail' })
  getReviewById(@Param('id') id: string) {
    return this.adminService.getReviewById(id);
  }

  // Organizations — performance / bookings / payouts
  @Get('organizations/:id/performance')
  @ApiOperation({ summary: 'Get organization performance metrics' })
  getOrganizationPerformance(@Param('id') id: string) {
    return this.adminService.getOrganizationPerformance(id);
  }

  @Get('organizations/:id/bookings')
  @ApiOperation({ summary: 'Get organization bookings' })
  getOrganizationBookings(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getOrganizationBookings(id, {
      status,
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }

  @Get('organizations/:id/payouts')
  @ApiOperation({ summary: 'Get organization payouts (derived from payments)' })
  getOrganizationPayouts(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
  ) {
    return this.adminService.getOrganizationPayouts(id, {
      limit: limit ? parseInt(limit) : undefined,
      skip: skip ? parseInt(skip) : undefined,
    });
  }
}
