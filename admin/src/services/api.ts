import axios from 'axios';
import { API } from '../shared/api-contracts';

const API_URL = '/api';

const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle errors — Sprint 6 unified envelope
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('admin_token');
      window.location.href = '/login';
    }
    // Normalize backend envelope { error, code, message, details, status }
    const data = err.response?.data;
    const normalized = {
      code: data?.code || (err.code === 'ERR_NETWORK' ? 'NETWORK_ERROR' : 'UNKNOWN_ERROR'),
      message: data?.message || err.message || 'Something went wrong',
      status: err.response?.status,
      details: data?.details,
      original: err,
    };
    return Promise.reject(normalized);
  }
);

// Auth
export const authAPI = {
  login: (email: string, password: string) => api.post(API.auth.login, { email, password }),
  me: () => api.get(API.auth.me),
};

// Admin Dashboard
export const adminAPI = {
  // Dashboard & Metrics
  getDashboard: () => api.get(API.admin.dashboard),
  getMarketMetrics: () => api.get('/admin/metrics/market'),
  getResponseMetrics: () => api.get('/admin/metrics/response'),
  getLiveFeed: (limit?: number) => api.get(API.admin.liveFeed, { params: { limit: limit || 50 } }),
  getAlerts: () => api.get(API.admin.alerts),
  
  // Users — NOTE: /admin/users not in backend OpenAPI (retired P2 2026-02-22).
  // Calls below preserved as hardcoded strings; they will 404 against
  // current backend. See /app/shared/contracts/RETIRED_P2_2026_02_22.md.
  getUsers: (params?: { role?: string; search?: string; status?: string; limit?: number; skip?: number }) =>
    api.get('/admin/users', { params }),
  getUser: (id: string) => api.get(`/admin/users/${id}`),
  getUserActivity: (id: string) => api.get(`/admin/users/${id}/activity`),
  blockUser: (id: string) => api.post(`/admin/users/${id}/block`),
  unblockUser: (id: string) => api.post(`/admin/users/${id}/unblock`),
  addUserNote: (id: string, note: string) => api.post(`/admin/users/${id}/notes`, { note }),
  
  // Organizations / Providers
  getOrganizations: (params?: { status?: string; search?: string; type?: string; verified?: boolean; limit?: number; skip?: number }) =>
    api.get('/admin/organizations', { params }),
  getOrganization: (id: string) => api.get(`/admin/organizations/${id}`),
  getOrgPerformance: (id: string) => api.get(`/admin/organizations/${id}/performance`),
  getOrgBookings: (id: string, params?: { limit?: number; skip?: number }) =>
    api.get(`/admin/organizations/${id}/bookings`, { params }),
  getOrgPayouts: (id: string) => api.get(`/admin/organizations/${id}/payouts`),
  enableOrg: (id: string) => api.post(`/admin/organizations/${id}/enable`),
  disableOrg: (id: string) => api.post(`/admin/organizations/${id}/disable`),
  suspendOrg: (id: string, reason: string) => api.post(`/admin/organizations/${id}/suspend`, { reason }),
  verifyOrg: (id: string) => api.post(`/admin/organizations/${id}/verify`),
  setOrgLocation: (id: string, data: { lat: number; lng: number; address?: string }) =>
    api.patch(`/organizations/${id}/location/admin`, data),
  verifyLocation: (id: string) => api.post(`/organizations/${id}/location/verify`),
  setOrgCommission: (id: string, tier: string) => api.patch(`/admin/organizations/${id}/commission`, { tier }),
  addOrgNote: (id: string, note: string) => api.post(`/admin/organizations/${id}/notes`, { note }),
  setOrgBoost: (id: string, enabled: boolean) => api.post(`/admin/organizations/${id}/boost`, { enabled }),
  
  // Bookings
  getBookings: (params?: { status?: string; providerId?: string; customerId?: string; dateFrom?: string; dateTo?: string; limit?: number; skip?: number }) =>
    api.get('/admin/bookings', { params }),
  getBooking: (id: string) => api.get(`/admin/bookings/${id}`),
  getBookingTimeline: (id: string) => api.get(`/admin/bookings/${id}/timeline`),
  updateBookingStatus: (id: string, status: string, reason?: string) =>
    api.patch(`/admin/bookings/${id}/status`, { status, reason }),
  reassignBooking: (id: string, providerId: string) =>
    api.post(`/admin/bookings/${id}/reassign`, { providerId }),
  refundBooking: (id: string, amount: number, reason: string) =>
    api.post(`/admin/bookings/${id}/refund`, { amount, reason }),
  addBookingNote: (id: string, note: string) => api.post(`/admin/bookings/${id}/notes`, { note }),
  
  // Quotes / Requests
  getQuotes: (params?: { status?: string; urgent?: boolean; noResponse?: boolean; limit?: number; page?: number }) =>
    api.get('/admin/quotes/all', { params }),
  getQuote: (id: string) => api.get(`/admin/quotes/${id}`),
  getQuoteDetails: (id: string) => api.get(`/admin/quotes/${id}/details`),
  getQuoteResponses: (id: string) => api.get(`/admin/quotes/${id}/responses`),
  createManualQuote: (data: any) => api.post('/admin/quotes/manual', data),
  distributeQuote: (id: string, organizationIds: string[]) =>
    api.post(`/admin/quotes/${id}/distribute`, { organizationIds }),
  closeQuote: (id: string, data: { organizationId?: string; price?: number; notes?: string; reason?: string }) =>
    api.post(`/admin/quotes/${id}/close`, data),
  escalateQuote: (id: string) => api.post(`/admin/quotes/${id}/escalate`),
  addQuoteNote: (id: string, note: string) => api.post(`/admin/quotes/${id}/notes`, { note }),
  
  // Payments
  getPayments: (params?: { status?: string; type?: string; providerId?: string; dateFrom?: string; dateTo?: string; limit?: number; skip?: number }) =>
    api.get('/admin/payments', { params }),
  getPayment: (id: string) => api.get(`/admin/payments/${id}`),
  getPaymentTimeline: (id: string) => api.get(`/admin/payments/${id}/timeline`),
  retryPayment: (id: string) => api.post(`/admin/payments/${id}/retry`),
  refundPayment: (id: string, amount?: number, reason?: string) =>
    api.post(`/admin/payments/${id}/refund`, { amount, reason }),
  
  // Payouts
  getPayouts: (params?: { status?: string; providerId?: string; limit?: number; skip?: number }) =>
    api.get('/admin/payouts', { params }),
  approvePayout: (id: string) => api.post(`/admin/payouts/${id}/approve`),
  holdPayout: (id: string, reason: string) => api.post(`/admin/payouts/${id}/hold`, { reason }),
  processPayout: (id: string) => api.post(`/admin/payouts/${id}/process`),
  
  // Disputes
  getDisputes: (params?: { status?: string; priority?: string; category?: string; ownerId?: string; limit?: number; skip?: number }) =>
    api.get('/admin/disputes', { params }),
  getDispute: (id: string) => api.get(`/admin/disputes/${id}`),
  getDisputeEvidence: (id: string) => api.get(`/admin/disputes/${id}/evidence`),
  getDisputeTimeline: (id: string) => api.get(`/admin/disputes/${id}/timeline`),
  assignDispute: (id: string, ownerId: string) => api.patch(`/admin/disputes/${id}/assign`, { ownerId }),
  updateDisputeStatus: (id: string, status: string) => api.patch(`/admin/disputes/${id}/status`, { status }),
  resolveDispute: (id: string, resolution: { decision: string; refundAmount?: number; notes: string }) =>
    api.post(`/admin/disputes/${id}/resolve`, resolution),
  requestEvidence: (id: string, party: 'customer' | 'provider', message: string) =>
    api.post(`/admin/disputes/${id}/request-evidence`, { party, message }),
  freezePayout: (id: string) => api.post(`/admin/disputes/${id}/freeze-payout`),
  warnParty: (id: string, party: 'customer' | 'provider', reason: string) =>
    api.post(`/admin/disputes/${id}/warn`, { party, reason }),
  addDisputeNote: (id: string, note: string) => api.post(`/admin/disputes/${id}/notes`, { note }),
  
  // Reviews
  getReviews: (params?: { rating?: number; flagged?: boolean; providerId?: string; limit?: number; skip?: number }) =>
    api.get('/admin/reviews', { params }),
  getReview: (id: string) => api.get(`/admin/reviews/${id}`),
  hideReview: (id: string, reason: string) => api.post(`/admin/reviews/${id}/hide`, { reason }),
  restoreReview: (id: string) => api.post(`/admin/reviews/${id}/restore`),
  flagReview: (id: string, reason: string) => api.post(`/admin/reviews/${id}/flag`, { reason }),
  removeFromRating: (id: string) => api.post(`/admin/reviews/${id}/exclude-rating`),
  
  // Map & Geo
  getNearbyProviders: (lat: number, lng: number, radius: number, limit?: number) =>
    api.get('/map/providers/nearby', { params: { lat, lng, radius, limit: limit || 50 } }),
  getMapHeatmap: (type: 'demand' | 'supply' | 'conversion') =>
    api.get('/admin/map/heatmap', { params: { type } }),
  getServiceZones: () => api.get('/admin/map/zones'),
  createServiceZone: (data: { name: string; coordinates: number[][]; priority?: number }) =>
    api.post('/admin/map/zones', data),
  updateServiceZone: (id: string, data: any) => api.patch(`/admin/map/zones/${id}`, data),
  deleteServiceZone: (id: string) => api.delete(`/admin/map/zones/${id}`),
  
  // 🎯 Assignment Engine API
  getLiveRequests: (params?: { lat?: number; lng?: number; radius?: number; limit?: number }) =>
    api.get('/map/requests/live', { params }),
  getMatchingProviders: (requestId: string) =>
    api.get(`/map/requests/${requestId}/matching`),
  getMatchingCandidates: (requestId: string, limit?: number) =>
    api.get(`/requests/${requestId}/matching`, { params: { limit } }),
  distributeRequest: (requestId: string, providerIds: string[]) =>
    api.post(`/requests/${requestId}/distribute`, { providerIds }),
  autoDistributeRequest: (requestId: string, count?: number) =>
    api.post(`/requests/${requestId}/distribute/auto`, null, { params: { count } }),
  getRequestDistributions: (requestId: string) =>
    api.get(`/requests/${requestId}/distributions`),
  assignProvider: (requestId: string, data: { providerId: string; price?: number; slotId?: string; notes?: string }) =>
    api.post(`/requests/${requestId}/assign`, data),
  createBookingFromRequest: (data: { requestId: string; providerId: string; price?: number; slotId?: string }) =>
    api.post('/bookings/create-from-request', data),
    
  // 📥 Provider Inbox API
  getProviderInbox: () => api.get('/provider/requests/inbox'),
  getProviderPressureSummary: () => api.get('/provider/pressure-summary'),
  getProviderMissedRequests: () => api.get('/provider/requests/missed'),
  providerAcceptRequest: (distributionId: string) =>
    api.post(`/provider/requests/${distributionId}/accept`),
  providerRejectRequest: (distributionId: string, reason?: string) =>
    api.post(`/provider/requests/${distributionId}/reject`, { reason }),
  providerMarkViewed: (distributionId: string) =>
    api.post(`/provider/requests/${distributionId}/view`),
  updateProviderPresence: (isOnline: boolean, acceptsQuickRequests?: boolean) =>
    api.post('/provider/presence/update', { isOnline, acceptsQuickRequests }),
  
  // Services & Categories (Admin CRUD)
  getServiceCategories: () => api.get('/services/categories'),
  getAllServiceCategories: () => api.get('/services/categories/all'),
  createServiceCategory: (data: any) => api.post('/services/categories', data),
  updateServiceCategory: (id: string, data: any) => api.put(`/services/categories/${id}`, data),
  deleteServiceCategory: (id: string) => api.delete(`/services/categories/${id}`),
  getServicesList: (params?: { categoryId?: string; search?: string }) => api.get('/services', { params }),
  getAllServicesList: () => api.get('/services/all'),
  getService: (id: string) => api.get(`/services/${id}`),
  createService: (data: any) => api.post('/services', data),
  updateService: (id: string, data: any) => api.put(`/services/${id}`, data),
  deleteService: (id: string) => api.delete(`/services/${id}`),
  
  // Provider-Services (Org Services)
  getOrgServices: (orgId: string) => api.get(`/provider-services/organization/${orgId}`),
  
  // Settings & Config
  getConfig: () => api.get('/admin/config'),
  setConfig: (key: string, value: any) => api.post('/admin/config', { key, value }),
  getCommissionTiers: () => api.get('/admin/config/commission-tiers'),
  updateCommissionTier: (tier: string, data: any) => api.patch(`/admin/config/commission-tiers/${tier}`, data),
  getConfigFeatureFlags: () => api.get('/admin/config/features'),
  setFeatureFlag: (flag: string, enabled: boolean) => api.post('/admin/config/features', { flag, enabled }),
  
  // Audit Log
  getAuditLog: (params?: { userId?: string; action?: string; entityType?: string; dateFrom?: string; dateTo?: string; limit?: number; skip?: number }) =>
    api.get('/admin/audit-log', { params }),

  // UX-4B Inspection Forensics — timeline events + provenance + suspicion
  getInspectionTimeline: (jobId: string) =>
    api.get(`/inspections/${jobId}/timeline`),
  getInspectionMedia: (jobId: string, mediaId: string) =>
    api.get(`/inspections/${jobId}/media/${mediaId}`),
  listRecentInspectionJobs: (params?: { limit?: number; status?: string }) =>
    api.get('/inspections/admin/jobs', { params }),
  
  // Reports & Export
  exportData: (entity: string, params?: any) =>
    api.get(`/admin/export/${entity}`, { params }),
  getReport: (type: string, params?: { dateFrom?: string; dateTo?: string; groupBy?: string }) =>
    api.get(`/admin/reports/${type}`, { params }),
  
  // Notifications Admin
  getNotificationTemplates: () => api.get('/admin/notifications/templates'),
  createNotificationTemplate: (data: any) => api.post('/admin/notifications/templates', data),
  updateNotificationTemplate: (id: string, data: any) => api.patch(`/admin/notifications/templates/${id}`, data),
  sendBulkNotification: (data: { title: string; message: string; templateCode?: string; filters?: any; channels?: string[] }) =>
    api.post('/admin/notifications/bulk', data),
  getBulkNotifications: (params?: { limit?: number; skip?: number }) =>
    api.get('/admin/notifications/history', { params }),
  
  // Metrics & Analytics (extended)
  getProviderMetrics: (id: string) => api.get(`/admin/providers/${id}/metrics`),
  getCategoryMetrics: () => api.get('/admin/metrics/categories'),
  getCityMetrics: () => api.get('/admin/metrics/cities'),
  getConversionMetrics: (params?: { dateFrom?: string; dateTo?: string }) =>
    api.get('/admin/metrics/conversion', { params }),
  
  // Global Search
  globalSearch: (query: string) => api.get('/admin/search', { params: { q: query } }),
  
  // 🌍 Zone Engine API (City-Level Control)
  getZones: () => api.get('/admin/zones'),
  getZone: (id: string) => api.get(`/admin/zones/${id}`),
  getZoneHeatmap: () => api.get('/admin/zones/heatmap'),
  getHotZones: () => api.get('/admin/zones/hot'),
  getDeadZones: () => api.get('/admin/zones/dead'),
  getZoneKPIs: (cityId?: string) => api.get('/admin/zones/kpis', { params: cityId ? { cityId } : {} }),
  createZone: (data: any) => api.post('/admin/zones', data),
  performZoneAction: (zoneId: string, actionType: string, data: any) => 
    api.post(`/admin/zones/${zoneId}/action`, { actionType, data }),
  findSupplyPull: (zoneId: string, limit?: number) => 
    api.get(`/admin/zones/${zoneId}/supply-pull`, { params: { limit } }),
    
  // 🔥 Demand Engine API
  getDemandMetrics: (cityId?: string) => api.get('/admin/demand/metrics', { params: cityId ? { cityId } : {} }),
  getDemandHeatmap: () => api.get('/admin/demand/heatmap'),
  getDemandHotAreas: () => api.get('/admin/demand/hot-areas'),
  getDemandSurge: () => api.get('/admin/demand/surge'),
  
  // 🤖 Market Control API (Automated Marketplace)
  getMarketRules: () => api.get('/admin/market/rules'),
  getMarketRule: (id: string) => api.get(`/admin/market/rules/${id}`),
  createMarketRule: (data: any) => api.post('/admin/market/rules', data),
  updateMarketRule: (id: string, data: any) => api.put(`/admin/market/rules/${id}`, data),
  toggleMarketRule: (id: string) => api.post(`/admin/market/rules/${id}/toggle`),
  deleteMarketRule: (id: string) => api.delete(`/admin/market/rules/${id}`),
  getMarketStats: () => api.get('/admin/market/stats'),
  getMarketAutoMode: () => api.get('/admin/market/auto-mode'),
  setMarketAutoMode: (data: { enabled: boolean }) => api.post('/admin/market/auto-mode', data),
  getMarketExecutions: (params?: { ruleId?: string; zoneId?: string; limit?: number }) => 
    api.get('/admin/market/executions', { params }),
  triggerMarketRules: (zoneId: string) => api.post(`/admin/market/trigger/${zoneId}`),
  
  // 🧠 Learning Engine API (Self-Learning System)
  getLearningStats: () => api.get('/admin/market/learning/stats'),
  getRulePerformance: (ruleId?: string) => 
    api.get('/admin/market/learning/performance', { params: ruleId ? { ruleId } : {} }),
  getMarketKPIs: (params?: { scope?: string; zoneId?: string; periodType?: string; limit?: number }) =>
    api.get('/admin/market/learning/kpis', { params }),
  getExperiments: (status?: string) => 
    api.get('/admin/experiments', { params: status ? { status } : {} }),
  createExperiment: (data: any) => api.post('/admin/experiments', data),
  startExperiment: (id: string) => api.post(`/admin/market/learning/experiments/${id}/start`),
  forceMeasurement: (executionId: string) => api.post(`/admin/market/learning/measure/${executionId}`),
  
  // Feature Flags
  getFeatureFlags: () => api.get('/admin/feature-flags'),
  createFeatureFlag: (data: any) => api.post('/admin/feature-flags', data),
  updateFeatureFlag: (id: string, data: any) => api.patch(`/admin/feature-flags/${id}`, data),
  toggleFeatureFlag: (key: string, enabled: boolean) => api.post(`/admin/feature-flags/${key}/toggle`, { enabled }),
  updateExperimentStatus: (id: string, status: string) => api.patch(`/admin/experiments/${id}/status`, { status }),
  
  // Auto-Suggestions
  getSuggestions: () => api.get('/admin/suggestions'),
  executeSuggestionAction: (suggestionId: string, actionId: string) => 
    api.post(`/admin/suggestions/${suggestionId}/execute`, { actionId }),
  
  // Reputation Control
  getProviderReputation: (providerId: string) => api.get(`/admin/providers/${providerId}/reputation`),
  adjustProviderRating: (providerId: string, data: { newRating: number; reason: string }) =>
    api.post(`/admin/providers/${providerId}/reputation/rating`, data),
  hideReviewReputation: (reviewId: string, reason: string) => api.post(`/admin/reviews/${reviewId}/hide`, { reason }),
  addTrustFlag: (providerId: string, flag: string) =>
    api.post(`/admin/providers/${providerId}/reputation/trust-flag`, { flag }),
  penalizeProvider: (providerId: string, data: { type: string; severity: number; reason: string }) =>
    api.post(`/admin/providers/${providerId}/reputation/penalize`, data),

  // ==================== P4: GOVERNANCE ====================

  // ==================== GOVERNANCE ====================

  // Provider Behavior Control
  getProviderBehavior: () => api.get('/admin/providers/behavior'),
  providerBehaviorBulkAction: (data: { action: string; filter: any; message?: string }) =>
    api.post('/admin/providers/behavior/bulk-action', data),

  // Demand Push Control
  demandPushProviders: (data: { zoneId: string; minScore?: number; message?: string }) =>
    api.post('/admin/demand/push-providers', data),
  demandBoostSupply: (zoneId: string, data: { boostLevel?: number; durationMinutes?: number }) =>
    api.post(`/admin/demand/${zoneId}/boost-supply`, data),

  // Flow Control
  getFlowConfig: () => api.get('/admin/flow/config'),
  updateFlowConfig: (data: any) => api.post('/admin/flow/config', data),
  getFlowMetrics: () => api.get('/admin/flow/metrics'),

  // Governance Actions History
  getGovernanceActions: () => api.get('/admin/governance/actions'),

  // Governance Score
  getGovernanceScore: () => api.get('/admin/governance/score'),
  getGovernanceScoreZones: () => api.get('/admin/governance/score/zones'),
  getGovernanceScoreHistory: () => api.get('/admin/governance/score/history'),

  // Demand Action Chains
  getDemandActionRecommendations: (zoneId?: string) =>
    api.get('/admin/demand/actions/recommendations', { params: zoneId ? { zoneId } : {} }),
  runDemandAction: (data: { zoneId: string; chainId?: string; mode?: string }) =>
    api.post('/admin/demand/actions/run', data),
  getDemandActionsHistory: () => api.get('/admin/demand/actions/history'),

  // Revenue Experiments
  getRevenueExperiments: () => api.get('/admin/revenue/experiments'),
  createRevenueExperiment: (data: any) => api.post('/admin/revenue/experiments', data),
  startRevenueExperiment: (id: string) => api.post(`/admin/revenue/experiments/${id}/start`),
  stopRevenueExperiment: (id: string) => api.post(`/admin/revenue/experiments/${id}/stop`),
  getExperimentResults: (id: string) => api.get(`/admin/revenue/experiments/${id}/results`),

  // Supply Quality
  getSupplyQuality: () => api.get('/admin/providers/quality'),
  executeQualityAction: (providerId: string, action: string) =>
    api.post(`/admin/providers/${providerId}/quality-action`, { action }),
  getAutoQualityRules: () => api.get('/admin/quality/auto-rules'),
  saveAutoQualityRules: (rules: any[]) => api.post('/admin/quality/auto-rules', { rules }),

  // Zone Control
  getZonesControl: () => api.get('/admin/zones/control'),
  executeZoneAction: (zoneId: string, action: string) =>
    api.post(`/admin/zones/${zoneId}/action`, { action }),

  // Economy Control
  getEconomyConfig: () => api.get('/admin/economy'),
  updateEconomyConfig: (data: any) => api.post('/admin/economy', data),

  // Distribution Control
  getDistributionConfig: () => api.get('/admin/distribution/config'),
  updateDistributionConfig: (data: any) => api.post('/admin/distribution/config', data),

  // Incident Control
  getIncidents: () => api.get('/admin/incidents'),
  executeIncidentAction: (incidentId: string, action: string) =>
    api.post(`/admin/incidents/${incidentId}/action`, { action }),

  // System Health
  getSystemHealth: () => api.get('/admin/system/health'),

  // Demand Control
  getDemandControl: () => api.get('/admin/demand/control'),
  forceQuoteAction: (quoteId: string, action: string) =>
    api.post(`/admin/quotes/${quoteId}/force-action`, { action }),

  // Provider Lifecycle
  getProviderLifecycle: () => api.get('/admin/providers/lifecycle'),
  executeLifecycleAction: (providerId: string, action: string) =>
    api.post(`/admin/providers/${providerId}/lifecycle-action`, { action }),

  // ========== AUTOMATION ENGINE ==========
  getAutomationDashboard: () => api.get('/admin/automation/dashboard'),
  getAutoRules: () => api.get('/admin/automation/rules'),
  createAutoRule: (d: any) => api.post('/admin/automation/rules', d),
  updateAutoRule: (id: string, d: any) => api.patch(`/admin/automation/rules/${id}`, d),
  deleteAutoRule: (id: string) => api.delete(`/admin/automation/rules/${id}`),
  toggleAutoRule: (id: string) => api.post(`/admin/automation/rules/${id}/toggle`),
  testAutoRule: (id: string) => api.post(`/admin/automation/rules/${id}/run-test`),
  setAutoRuleMode: (id: string, mode: string) => api.post(`/admin/automation/rules/${id}/set-mode`, { mode }),
  promoteAutoRule: (id: string) => api.post(`/admin/automation/rules/${id}/promote`),
  bulkPromoteRules: (ruleIds: string[]) => api.post('/admin/automation/rules/bulk-promote', { ruleIds }),
  getAutoExecutions: (ruleId?: string, limit?: number) => api.get('/admin/automation/executions', { params: { ruleId, limit } }),
  getAutoChains: () => api.get('/admin/automation/chains'),
  createAutoChain: (d: any) => api.post('/admin/automation/chains', d),
  updateAutoChain: (id: string, d: any) => api.patch(`/admin/automation/chains/${id}`, d),
  deleteAutoChain: (id: string) => api.delete(`/admin/automation/chains/${id}`),
  toggleAutoChain: (id: string) => api.post(`/admin/automation/chains/${id}/toggle`),
  testAutoChain: (id: string) => api.post(`/admin/automation/chains/${id}/run-test`),
  getChainExecs: (id: string, limit?: number) => api.get(`/admin/automation/chains/${id}/executions`, { params: { limit } }),
  getAutoConfig: () => api.get('/admin/automation/config'),
  updateAutoConfig: (d: any) => api.post('/admin/automation/config', d),
  getAutoMonitor: () => api.get('/admin/automation/engine/monitor'),
  getAutoHistory: (limit?: number) => api.get('/admin/automation/engine/history', { params: { limit } }),
  startAutoEngine: () => api.post('/admin/automation/engine/start'),
  stopAutoEngine: () => api.post('/admin/automation/engine/stop'),
  pauseAutoEngine: () => api.post('/admin/automation/engine/pause'),
  resumeAutoEngine: () => api.post('/admin/automation/engine/resume'),
  updateAutoEngineConfig: (d: any) => api.post('/admin/automation/engine/config', d),
  getShadowHistory: (limit?: number) => api.get('/admin/automation/shadow/history', { params: { limit } }),
  getShadowComparison: () => api.get('/admin/automation/shadow/comparison'),
  runReplay: (d: any) => api.post('/admin/automation/replay', d),
  getReplayHistory: (limit?: number) => api.get('/admin/automation/replay/history', { params: { limit } }),
  getAutoROI: () => api.get('/admin/automation/roi'),
  getAutoROISummary: () => api.get('/admin/automation/roi/summary'),
  getIdempotency: () => api.get('/admin/automation/idempotency'),
  updateIdempotencyConfig: (ttl: number) => api.post('/admin/automation/idempotency/config', { ttl }),
  clearIdempotencyKeys: () => api.post('/admin/automation/idempotency/clear'),
  getUnifiedState: () => api.get('/admin/automation/unified-state'),
  syncUnifiedState: () => api.post('/admin/automation/unified-state/sync'),
  getUnifiedStateHealth: () => api.get('/admin/automation/unified-state/health'),
  getFailsafeRules: () => api.get('/admin/automation/failsafe/rules'),
  createFailsafeRule: (d: any) => api.post('/admin/automation/failsafe/rules', d),
  getFailsafeIncidents: (status?: string, limit?: number) => api.get('/admin/automation/failsafe/incidents', { params: { status, limit } }),
  resolveIncident: (id: string) => api.post(`/admin/automation/failsafe/incidents/${id}/resolve`),
  testFailsafe: () => api.post('/admin/automation/failsafe/run-test'),
  getAutoFeedback: (ruleId?: string, limit?: number) => api.get('/admin/automation/feedback', { params: { ruleId, limit } }),
  getAutoFeedbackSummary: () => api.get('/admin/automation/feedback/summary'),
  runDryRun: (d: any) => api.post('/admin/automation/dry-run', d),
  getAutoPerformance: () => api.get('/admin/automation/performance'),
  getAutoMarketState: (scopeType?: string) => api.get('/admin/automation/unified-state', { params: { scopeType } }),
  getAutoZoneStates: () => api.get('/admin/automation/unified-state'),
};

// ─────────────────────────────────────────────────────────────────────
// P2.5 — adminAPI domain slicing (compat-layer).
//
// Below: namespaced accessors over the SAME functions exposed above.
// Existing call-sites (`adminAPI.getPayments(...)`) keep working unchanged.
// New call-sites should prefer the namespaced form
// (`adminAPI.payments.list(...)`) — same identity, clearer ownership.
//
// This is NOT a rewrite. It is a domain projection on the existing
// god-object. See /app/memory/PHASE_2_contract_normalization_closure_2026_02_22.md
// for the rationale (P2.5 — "Не полностью сейчас. Domain slicing с
// сохранением compat").
// ─────────────────────────────────────────────────────────────────────

(adminAPI as any).payments = {
  list:     adminAPI.getPayments,
  get:      adminAPI.getPayment,
  timeline: adminAPI.getPaymentTimeline,
  retry:    adminAPI.retryPayment,
  refund:   adminAPI.refundPayment,
  // payouts share aggregate with payments at the operational level
  payouts: {
    list:    adminAPI.getPayouts,
    approve: adminAPI.approvePayout,
    hold:    adminAPI.holdPayout,
    process: adminAPI.processPayout,
  },
};

(adminAPI as any).governance = {
  score:        adminAPI.getGovernanceScore,
  scoreZones:   adminAPI.getGovernanceScoreZones,
  scoreHistory: adminAPI.getGovernanceScoreHistory,
  actions:      adminAPI.getGovernanceActions,
  flow:         {
    config:  adminAPI.getFlowConfig,
    update:  adminAPI.updateFlowConfig,
    metrics: adminAPI.getFlowMetrics,
  },
};

(adminAPI as any).disputes = {
  list:             adminAPI.getDisputes,
  get:              adminAPI.getDispute,
  evidence:         adminAPI.getDisputeEvidence,
  timeline:         adminAPI.getDisputeTimeline,
  assign:           adminAPI.assignDispute,
  setStatus:        adminAPI.updateDisputeStatus,
  resolve:          adminAPI.resolveDispute,
  requestEvidence:  adminAPI.requestEvidence,
  freezePayout:     adminAPI.freezePayout,
  warn:             adminAPI.warnParty,
  addNote:          adminAPI.addDisputeNote,
};

(adminAPI as any).marketplace = {
  bookings: {
    list:     adminAPI.getBookings,
    get:      adminAPI.getBooking,
    timeline: adminAPI.getBookingTimeline,
    setStatus: adminAPI.updateBookingStatus,
    reassign: adminAPI.reassignBooking,
    refund:   adminAPI.refundBooking,
    addNote:  adminAPI.addBookingNote,
  },
  quotes: {
    list:        adminAPI.getQuotes,
    get:         adminAPI.getQuote,
    details:     adminAPI.getQuoteDetails,
    responses:   adminAPI.getQuoteResponses,
    manual:      adminAPI.createManualQuote,
    distribute:  adminAPI.distributeQuote,
    close:       adminAPI.closeQuote,
    escalate:    adminAPI.escalateQuote,
    addNote:     adminAPI.addQuoteNote,
    forceAction: adminAPI.forceQuoteAction,
  },
  organizations: {
    list:        adminAPI.getOrganizations,
    get:         adminAPI.getOrganization,
    performance: adminAPI.getOrgPerformance,
    bookings:    adminAPI.getOrgBookings,
    payouts:     adminAPI.getOrgPayouts,
    enable:      adminAPI.enableOrg,
    disable:     adminAPI.disableOrg,
    suspend:     adminAPI.suspendOrg,
    verify:      adminAPI.verifyOrg,
    setLocation: adminAPI.setOrgLocation,
    verifyLocation: adminAPI.verifyLocation,
    setCommission: adminAPI.setOrgCommission,
    addNote:     adminAPI.addOrgNote,
    setBoost:    adminAPI.setOrgBoost,
  },
};

// P3.1 — extended domain namespaces (closure of P2.5 partial slicing).
// Each entry below references a method that actually exists on the flat
// `adminAPI` object above. Methods not yet implemented in the god-object
// are intentionally absent — namespaces are a projection of EXISTING
// surface, not a wishlist.

(adminAPI as any).system = {
  health:             adminAPI.getSystemHealth,
  config:             adminAPI.getConfig,
  features:           adminAPI.getConfigFeatureFlags,
  setFeature:         adminAPI.setFeatureFlag,
  audit:              adminAPI.getAuditLog,
  search:             adminAPI.globalSearch,
  incidents:          adminAPI.getIncidents,
  resolveIncident:    adminAPI.resolveIncident,
  distribution:       adminAPI.getDistributionConfig,
  updateDistribution: adminAPI.updateDistributionConfig,
};

(adminAPI as any).support = {
  reviews: {
    list:    adminAPI.getReviews,
    get:     adminAPI.getReview,
    hide:    adminAPI.hideReview,
    restore: adminAPI.restoreReview,
    flag:    adminAPI.flagReview,
  },
  notifications: {
    templates:      adminAPI.getNotificationTemplates,
    createTemplate: adminAPI.createNotificationTemplate,
    updateTemplate: adminAPI.updateNotificationTemplate,
    bulkSend:       adminAPI.sendBulkNotification,
    bulkHistory:    adminAPI.getBulkNotifications,
  },
};

(adminAPI as any).engine = {
  zones: {
    list:    adminAPI.getZones,
    get:     adminAPI.getZone,
    heatmap: adminAPI.getZoneHeatmap,
    hot:     adminAPI.getHotZones,
    dead:    adminAPI.getDeadZones,
    kpis:    adminAPI.getZoneKPIs,
    create:  adminAPI.createZone,
    serviceZones: {
      list:   adminAPI.getServiceZones,
      create: adminAPI.createServiceZone,
      update: adminAPI.updateServiceZone,
      delete: adminAPI.deleteServiceZone,
    },
  },
  demand: {
    metrics:  adminAPI.getDemandMetrics,
    heatmap:  adminAPI.getDemandHeatmap,
    hotAreas: adminAPI.getDemandHotAreas,
    surge:    adminAPI.getDemandSurge,
  },
  market: {
    rules:        adminAPI.getMarketRules,
    rule:         adminAPI.getMarketRule,
    createRule:   adminAPI.createMarketRule,
    updateRule:   adminAPI.updateMarketRule,
    deleteRule:   adminAPI.deleteMarketRule,
    toggleRule:   adminAPI.toggleMarketRule,
    stats:        adminAPI.getMarketStats,
    autoMode:     adminAPI.getMarketAutoMode,
    setAutoMode:  adminAPI.setMarketAutoMode,
    executions:   adminAPI.getMarketExecutions,
    trigger:      adminAPI.triggerMarketRules,
  },
};

// P3.3 + P3.4 — observability namespaces (read-only, admin-only).
(adminAPI as any).reconciliation = {
  report:   (limit?: number) => api.get('/admin/reconciliation/report', { params: { limit } }),
  taxonomy: () => api.get('/admin/reconciliation/taxonomy'),
};

(adminAPI as any).forensicGraph = {
  describe: () => api.get('/admin/forensic-graph/'),
  booking:  (id: string) => api.get(`/admin/forensic-graph/booking/${id}`),
  payment:  (id: string) => api.get(`/admin/forensic-graph/payment/${id}`),
  dispute:  (id: string) => api.get(`/admin/forensic-graph/dispute/${id}`),
};

// Sprint 6 — System observability
export interface SystemErrorItem {
  timestamp?: string;
  level?: 'error' | 'warn' | 'info';
  service?: string;
  route?: string;
  method?: string;
  status?: number;
  errorCode?: string;
  message?: string;
  durationMs?: number;
  meta?: Record<string, unknown>;
}

export interface SystemErrorStats {
  errorsLast5Min: number;
  errorRate: number;
  timeline: Array<{ from: string; to: string; count: number }>;
  topCodes: Array<{ code: string; count: number; lastMessage?: string }>;
  topRoutes: Array<{ route: string; count: number }>;
  countersLive: {
    total: number;
    by_status: Record<string, number>;
    by_code: Record<string, number>;
    by_route: Record<string, number>;
  };
}

export const systemAPI = {
  getHealth: () => api.get('/system/health'),
  getErrors: (params?: { level?: string; route?: string; limit?: number }) =>
    api.get<{ items: SystemErrorItem[]; total: number }>('/system/errors', { params }),
  getErrorStats: () => api.get<SystemErrorStats>('/system/errors/stats'),
};

// Stripe Settings — admin runtime config (keys, currency, payment methods)
export interface StripeConfig {
  secretKeyMasked: string;
  secretKeyIsSet: boolean;
  publishableKey: string;
  webhookSecretMasked: string;
  webhookSecretIsSet: boolean;
  currency: string;
  paymentMethods: string[];
  mode: 'test' | 'live';
  automaticPaymentMethods: boolean;
  captureMethod: 'automatic' | 'manual';
  allowPromotionCodes: boolean;
  billingAddressCollection: 'auto' | 'required';
  source: { secretKey: string; webhookSecret: string; publishableKey: string };
  updatedAt: string | null;
  updatedBy: string | null;
}
export interface StripePaymentMethod {
  code: string; name: string;
  category: 'global' | 'wallet' | 'bank' | 'redirect' | 'bnpl' | 'crypto';
  default?: boolean; auto_with_card?: boolean;
}
export interface StripeCurrency {
  code: string; name: string; symbol: string; zero_decimal?: boolean;
}

export const stripeAdminAPI = {
  getConfig: () => api.get<StripeConfig>('/admin/stripe/config'),
  updateConfig: (data: Partial<{
    secretKey: string;
    publishableKey: string;
    webhookSecret: string;
    currency: string;
    paymentMethods: string[];
    mode: 'test' | 'live';
    automaticPaymentMethods: boolean;
    captureMethod: 'automatic' | 'manual';
    allowPromotionCodes: boolean;
    billingAddressCollection: 'auto' | 'required';
  }>) => api.post<StripeConfig>('/admin/stripe/config', data),
  listPaymentMethods: () =>
    api.get<{ paymentMethods: StripePaymentMethod[] }>('/admin/stripe/payment-methods'),
  listCurrencies: () =>
    api.get<{ currencies: StripeCurrency[] }>('/admin/stripe/currencies'),
  testKey: (secretKey: string) =>
    api.post<{ ok: boolean; mode: string; accountId: string | null; country: string | null }>(
      '/admin/stripe/test-key',
      { secretKey }
    ),
};

export default api;
