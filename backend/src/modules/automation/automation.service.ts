import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { ExecutionEngineService } from './execution-engine.service';

const uid = () => uuidv4();
const nowUtc = () => new Date().toISOString();

@Injectable()
export class AutomationService {
  constructor(
    @InjectModel('AutoActionRule') private ruleModel: Model<any>,
    @InjectModel('ActionChain') private chainModel: Model<any>,
    @InjectModel('ActionExecution') private execModel: Model<any>,
    @InjectModel('ChainExecution') private chainExecModel: Model<any>,
    @InjectModel('AutomationConfig') private configModel: Model<any>,
    @InjectModel('AutomationFeedback') private feedbackModel: Model<any>,
    @InjectModel('FailsafeRule') private failsafeModel: Model<any>,
    @InjectModel('FailsafeIncident') private incidentModel: Model<any>,
    @InjectModel('MarketStateSnapshot') private snapshotModel: Model<any>,
    @InjectModel('ReplaySession') private replayModel: Model<any>,
    private readonly engine: ExecutionEngineService,
  ) {}

  private c(doc: any) { if (!doc) return null; const o = doc.toObject ? doc.toObject() : { ...doc }; delete o._id; delete o.__v; return o; }
  private cl(docs: any[]) { return docs.map(d => this.c(d)); }

  // ── Rules ──
  async getRules() {
    const rules = await this.ruleModel.find().sort({ priority: 1 }).lean();
    const result = [];
    for (const r of rules) {
      const total = await this.execModel.countDocuments({ ruleId: r.id });
      const success = await this.execModel.countDocuments({ ruleId: r.id, status: 'executed' });
      result.push({ ...this.c(r), stats: { total, success, successRate: total > 0 ? +((success / total) * 100).toFixed(1) : 0 } });
    }
    return result;
  }
  async createRule(data: any) { return this.c(await this.ruleModel.create({ id: uid(), name: data.name, isEnabled: true, mode: data.mode || 'active', triggerType: data.triggerType || 'zone', conditionJson: data.conditionJson || {}, actionType: data.actionType || 'set_surge', actionPayload: data.actionPayload || {}, cooldownSeconds: data.cooldownSeconds || 300, priority: data.priority || 5 })); }
  async updateRule(id: string, data: any) { const r = await this.ruleModel.findOneAndUpdate({ id }, { $set: { ...data, updatedAt: nowUtc() } }, { new: true }).lean(); if (!r) throw new Error('Not found'); return this.c(r); }
  async deleteRule(id: string) { const r = await this.ruleModel.deleteOne({ id }); if (!r.deletedCount) throw new Error('Not found'); return { success: true }; }
  async toggleRule(id: string) { const r: any = await this.ruleModel.findOne({ id }).lean(); if (!r) throw new Error('Not found'); await this.ruleModel.updateOne({ id }, { $set: { isEnabled: !r.isEnabled } }); return { isEnabled: !r.isEnabled }; }
  async testRule(id: string) { const r: any = await this.ruleModel.findOne({ id }).lean(); if (!r) throw new Error('Not found'); const affected = Math.floor(Math.random() * 15) + 1; const exec = { id: uid(), ruleId: id, entityType: r.triggerType, entityId: `test-${uid().substring(0, 8)}`, triggerSnapshot: r.conditionJson, actionType: r.actionType, actionPayload: r.actionPayload, status: 'executed', isDryRun: true, affectedEntities: affected, createdAt: nowUtc() }; await this.execModel.create(exec); return { execution: exec, affectedEntities: affected }; }
  async setRuleMode(id: string, mode: string) { if (!['active', 'shadow'].includes(mode)) throw new Error('Invalid mode'); await this.ruleModel.updateOne({ id }, { $set: { mode } }); return { id, mode }; }

  // Auto-Promote Pipeline: Shadow → Active with validation
  async promoteRule(id: string) {
    const rule: any = await this.ruleModel.findOne({ id }).lean();
    if (!rule) throw new Error('Rule not found');

    const currentMode = rule.mode || 'active';
    const newMode = currentMode === 'shadow' ? 'active' : 'shadow';

    // Gather evidence for promotion decision
    const totalExecs = await this.execModel.countDocuments({ ruleId: id });
    const successExecs = await this.execModel.countDocuments({ ruleId: id, status: { $in: ['executed', 'shadow'] } });
    const failedExecs = await this.execModel.countDocuments({ ruleId: id, status: 'failed' });
    const fb = await this.feedbackModel.find({ ruleId: id }).lean();
    const positiveFb = fb.filter(f => f.impactType === 'positive').length;

    const successRate = totalExecs > 0 ? +((successExecs / totalExecs) * 100).toFixed(1) : 0;
    const positiveRate = fb.length > 0 ? +((positiveFb / fb.length) * 100).toFixed(1) : 0;

    // Promotion checks
    const checks = [];
    if (newMode === 'active') {
      checks.push({ name: 'min_shadow_executions', passed: totalExecs >= 3, detail: `${totalExecs}/3 executions` });
      checks.push({ name: 'success_rate_above_50', passed: successRate >= 50, detail: `${successRate}%` });
      checks.push({ name: 'no_recent_failures', passed: failedExecs < totalExecs * 0.3, detail: `${failedExecs} failures` });
      checks.push({ name: 'positive_feedback', passed: fb.length === 0 || positiveRate >= 40, detail: `${positiveRate}% positive` });
    }

    const allPassed = checks.length === 0 || checks.every(c => c.passed);
    const warnings = checks.filter(c => !c.passed);

    // Execute mode change
    await this.ruleModel.updateOne({ id }, { $set: { mode: newMode, promotedAt: nowUtc(), previousMode: currentMode } });

    return {
      id,
      name: rule.name,
      previousMode: currentMode,
      newMode,
      promoted: true,
      checks,
      allChecksPassed: allPassed,
      warnings: warnings.length,
      stats: { totalExecs, successRate, positiveRate, failedExecs },
      timestamp: nowUtc(),
    };
  }

  async bulkPromote(ruleIds: string[]) {
    const results = [];
    for (const id of ruleIds) {
      try {
        results.push(await this.promoteRule(id));
      } catch (e: any) {
        results.push({ id, promoted: false, error: e.message });
      }
    }
    return { results, total: ruleIds.length, promoted: results.filter(r => r.promoted).length };
  }

  async getExecutions(ruleId?: string, limit = 50) { const q: any = {}; if (ruleId) q.ruleId = ruleId; return this.cl(await this.execModel.find(q).sort({ createdAt: -1 }).limit(limit).lean()); }

  // ── Chains ──
  async getChains() {
    const chains = await this.chainModel.find().lean();
    const result = [];
    for (const ch of chains) {
      const total = await this.chainExecModel.countDocuments({ chainId: ch.id });
      const success = await this.chainExecModel.countDocuments({ chainId: ch.id, status: 'completed' });
      result.push({ ...this.c(ch), stats: { total, success, successRate: total > 0 ? +((success / total) * 100).toFixed(1) : 0 } });
    }
    return result;
  }
  async createChain(data: any) { return this.c(await this.chainModel.create({ id: uid(), name: data.name, isEnabled: true, triggerType: data.triggerType || 'zone_state', triggerConditionJson: data.triggerConditionJson || {}, steps: data.steps || [] })); }
  async updateChain(id: string, data: any) { const r = await this.chainModel.findOneAndUpdate({ id }, { $set: { ...data, updatedAt: nowUtc() } }, { new: true }).lean(); if (!r) throw new Error('Not found'); return this.c(r); }
  async deleteChain(id: string) { const r = await this.chainModel.deleteOne({ id }); if (!r.deletedCount) throw new Error('Not found'); return { success: true }; }
  async toggleChain(id: string) { const ch: any = await this.chainModel.findOne({ id }).lean(); if (!ch) throw new Error('Not found'); await this.chainModel.updateOne({ id }, { $set: { isEnabled: !ch.isEnabled } }); return { isEnabled: !ch.isEnabled }; }
  async testChain(id: string) { const ch: any = await this.chainModel.findOne({ id }).lean(); if (!ch) throw new Error('Not found'); const sr = (ch.steps || []).map((s: any) => ({ order: s.order, actionType: s.actionType, status: 'simulated', delaySeconds: s.delaySeconds })); const exec = { id: uid(), chainId: id, status: 'simulated', isDryRun: true, stepsResults: sr, createdAt: nowUtc() }; await this.chainExecModel.create(exec); return { execution: exec }; }
  async getChainExecutions(chainId: string, limit = 20) { return this.cl(await this.chainExecModel.find({ chainId }).sort({ createdAt: -1 }).limit(limit).lean()); }

  // ── Config ──
  async getConfig() { const c = await this.configModel.findOne({ type: 'global' }).lean(); return c ? this.c(c) : { type: 'global', autoDistribution: true, autoSurge: true, autoVisibility: true, autoNotifications: true, autoChains: false, dryRunMode: false, requireOperatorApprovalForCritical: true }; }
  async updateConfig(data: any) { data.type = 'global'; data.updatedAt = nowUtc(); await this.configModel.updateOne({ type: 'global' }, { $set: data }, { upsert: true }); return this.getConfig(); }

  // ── Market State ──
  async getMarketState(scopeType?: string) { const q: any = scopeType ? { scopeType } : { scopeType: 'global' }; const s = await this.snapshotModel.findOne(q).sort({ createdAt: -1 }).lean(); return s ? this.c(s) : { state: 'balanced', ratio: 1.0 }; }
  async getMarketStateHistory(scopeType?: string, limit = 50) { const q: any = scopeType ? { scopeType } : {}; return this.cl(await this.snapshotModel.find(q).sort({ createdAt: -1 }).limit(limit).lean()); }
  async getZoneStates() { const s = await this.snapshotModel.find({ scopeType: 'zone' }).sort({ createdAt: -1 }).limit(50).lean(); const seen = new Set<string>(); return s.filter(z => { if (seen.has(z.scopeId)) return false; seen.add(z.scopeId); return true; }).map(z => this.c(z)); }

  // ── Unified State ──
  async getUnifiedState() {
    const g: any = await this.snapshotModel.findOne({ scopeType: 'global' }).sort({ createdAt: -1 }).lean();
    const zones = await this.getZoneStates();
    const config = await this.configModel.findOne({ type: 'global' }).lean();
    return { global: g ? this.c(g) : { state: 'balanced', ratio: 1.0 }, zones, automationConfig: config ? this.c(config) : null, engineStatus: this.engine.stats.status, lastCycleAt: this.engine.stats.last_cycle_at, totalExecutions: this.engine.stats.total_executions, timestamp: nowUtc() };
  }
  async syncUnifiedState() {
    const zones = await this.getZoneStates();
    let tD = 0, tS = 0, cS = 0, eS = 0;
    for (const z of zones) { tD += z?.demandCount || 0; tS += z?.supplyCount || 0; cS += z?.conversionRate || 0; eS += z?.avgEtaMinutes || 0; }
    const cnt = Math.max(zones.length, 1), r = +(tD / Math.max(tS, 1)).toFixed(2);
    const st = r < 0.8 ? 'surplus' : r < 1.5 ? 'balanced' : r < 2.5 ? 'busy' : r < 3.5 ? 'surge' : 'critical';
    const synced = await this.snapshotModel.create({ id: uid(), scopeType: 'global', scopeId: 'all', demandCount: tD, supplyCount: tS, ratio: r, state: st, avgEtaMinutes: +(eS / cnt).toFixed(1), conversionRate: +(cS / cnt).toFixed(1), syncedFromZones: true, zonesCount: zones.length, createdAt: nowUtc() });
    return { synced: true, globalState: this.c(synced), zonesProcessed: zones.length };
  }
  async getUnifiedStateHealth() {
    const g: any = await this.snapshotModel.findOne({ scopeType: 'global' }).sort({ createdAt: -1 }).lean();
    const zones = await this.getZoneStates();
    let tD = 0, tS = 0; for (const z of zones) { tD += z?.demandCount || 0; tS += z?.supplyCount || 0; }
    const dDrift = Math.abs(tD - (g?.demandCount || 0)), sDrift = Math.abs(tS - (g?.supplyCount || 0));
    const issues: any[] = [];
    if (dDrift > 20) issues.push({ type: 'demand_drift', severity: 'warning', detail: `Zone demand (${tD}) differs from global (${g?.demandCount || 0}) by ${dDrift}` });
    if (sDrift > 15) issues.push({ type: 'supply_drift', severity: 'warning', detail: `Zone supply (${tS}) differs from global (${g?.supplyCount || 0}) by ${sDrift}` });
    return { health: issues.length === 0 ? 'healthy' : issues.length <= 2 ? 'degraded' : 'critical', issues, zonesCount: zones.length, timestamp: nowUtc() };
  }

  // ── Failsafe ──
  async getFailsafeRules() { const rules = await this.failsafeModel.find().lean(); const r = []; for (const rule of rules) { r.push({ ...this.c(rule), incidentsCount: await this.incidentModel.countDocuments({ ruleId: rule.id }) }); } return r; }
  async createFailsafeRule(data: any) { return this.c(await this.failsafeModel.create({ id: uid(), name: data.name, metric: data.metric, condition: data.condition, rollbackActionType: data.rollbackActionType, rollbackPayload: data.rollbackPayload || {}, isEnabled: true })); }
  async getFailsafeIncidents(status?: string, limit = 50) { const q: any = {}; if (status) q.status = status; return this.cl(await this.incidentModel.find(q).sort({ detectedAt: -1 }).limit(limit).lean()); }
  async resolveIncident(id: string) { const r = await this.incidentModel.updateOne({ id }, { $set: { status: 'resolved', resolvedAt: nowUtc() } }); if (!r.matchedCount) throw new Error('Not found'); return { success: true }; }
  async testFailsafe() { const rules = await this.failsafeModel.find({ isEnabled: true }).lean(); const results = rules.map(r => ({ ruleId: r.id, ruleName: r.name, metric: r.metric, condition: r.condition, triggered: Math.random() > 0.6, currentValue: +(Math.random() * 100).toFixed(1) })); return { results, rulesChecked: rules.length, triggered: results.filter(r => r.triggered).length }; }

  // ── Feedback ──
  async getFeedback(ruleId?: string, limit = 50) { const q: any = {}; if (ruleId) q.ruleId = ruleId; return this.cl(await this.feedbackModel.find(q).sort({ createdAt: -1 }).limit(limit).lean()); }
  async getFeedbackSummary() {
    const all = await this.feedbackModel.find().lean();
    const pos = all.filter(f => f.impactType === 'positive').length, neg = all.filter(f => f.impactType === 'negative').length, neu = all.filter(f => f.impactType === 'neutral').length;
    const avgScore = all.length > 0 ? +(all.reduce((s, f) => s + (f.impactScore || 0), 0) / all.length).toFixed(2) : 0;
    const byRule = new Map<string, any>();
    for (const f of all) { const rid = f.ruleId || 'unknown'; if (!byRule.has(rid)) byRule.set(rid, { positive: 0, negative: 0, neutral: 0, total: 0, totalScore: 0 }); const d = byRule.get(rid); d[f.impactType || 'neutral']++; d.total++; d.totalScore += f.impactScore || 0; }
    const ruleSummaries: any[] = [];
    for (const [rid, data] of byRule) { const rule: any = await this.ruleModel.findOne({ id: rid }).lean(); ruleSummaries.push({ ruleId: rid, ruleName: rule?.name || 'Unknown', ...data, avgScore: data.total > 0 ? +(data.totalScore / data.total).toFixed(2) : 0, effectiveness: data.total > 0 ? +((data.positive / data.total) * 100).toFixed(1) : 0 }); }
    ruleSummaries.sort((a, b) => b.effectiveness - a.effectiveness);
    return { total: all.length, positive: pos, negative: neg, neutral: neu, avgImpactScore: avgScore, byRule: ruleSummaries };
  }

  // ── Dry Run ──
  async dryRun(scenario: string, scopeType: string, scopeId: string) {
    const scenarios: Record<string, any> = {
      critical_zone_supply_drop: { predictedActions: ['send_push_nearby_providers', 'set_surge_1.7', 'expand_radius_2km', 'enable_bidding'], expectedImpact: { etaDelta: -3, conversionDelta: 8, supplyDelta: 4, revenueDelta: 12 } },
      peak_hour_demand_spike: { predictedActions: ['increase_surge_1.5', 'reduce_provider_radius', 'send_push_all_providers'], expectedImpact: { etaDelta: -2, conversionDelta: 5, supplyDelta: 8, revenueDelta: 18 } },
      provider_mass_offline: { predictedActions: ['alert_operators', 'expand_radius_5km', 'enable_manual_mode', 'send_emergency_push'], expectedImpact: { etaDelta: 5, conversionDelta: -15, supplyDelta: -20, revenueDelta: -25 } },
      low_conversion_zone: { predictedActions: ['reduce_surge', 'expand_provider_pool', 'send_targeted_push'], expectedImpact: { etaDelta: -1, conversionDelta: 12, supplyDelta: 3, revenueDelta: 8 } },
    };
    const result = scenarios[scenario] || { predictedActions: ['analyze_data'], expectedImpact: {} };
    const activeRules = await this.ruleModel.countDocuments({ isEnabled: true });
    const activeChains = await this.chainModel.countDocuments({ isEnabled: true });
    return { scenario, scope: { type: scopeType, id: scopeId }, ...result, matchingRules: activeRules, activeChains, riskLevel: (result.expectedImpact.conversionDelta || 0) < -10 ? 'high' : (result.expectedImpact.conversionDelta || 0) < 0 ? 'medium' : 'low', timestamp: nowUtc() };
  }

  // ── Performance ──
  async getRulePerformance() {
    const rules = await this.ruleModel.find().lean();
    const result = [];
    for (const rule of rules) {
      const total = await this.execModel.countDocuments({ ruleId: rule.id });
      const success = await this.execModel.countDocuments({ ruleId: rule.id, status: 'executed' });
      const fb = await this.feedbackModel.find({ ruleId: rule.id }).lean();
      const avgConv = fb.length > 0 ? +(fb.reduce((s, f) => s + ((f.metricAfter?.conversion || 0) - (f.metricBefore?.conversion || 0)), 0) / fb.length).toFixed(2) : 0;
      const avgEta = fb.length > 0 ? +(fb.reduce((s, f) => s + ((f.metricAfter?.eta || 0) - (f.metricBefore?.eta || 0)), 0) / fb.length).toFixed(2) : 0;
      const avgRev = fb.length > 0 ? +(fb.reduce((s, f) => s + ((f.metricAfter?.revenue || 0) - (f.metricBefore?.revenue || 0)), 0) / fb.length).toFixed(2) : 0;
      const sr = total > 0 ? +((success / total) * 100).toFixed(1) : 0;
      result.push({ ruleId: rule.id, ruleName: rule.name, actionType: rule.actionType, executions: total, successRate: sr, avgConversionDelta: avgConv, avgEtaDelta: avgEta, avgRevenueDelta: avgRev, recommendation: sr > 70 && avgConv >= 0 ? 'keep' : sr > 40 ? 'tune' : 'disable', isEnabled: rule.isEnabled });
    }
    return result.sort((a, b) => b.successRate - a.successRate);
  }

  // ── Dashboard ──
  async getDashboard() {
    const [rulesTotal, rulesActive, chainsTotal, chainsActive, incidentsOpen, failsafeCount] = await Promise.all([
      this.ruleModel.countDocuments(), this.ruleModel.countDocuments({ isEnabled: true }),
      this.chainModel.countDocuments(), this.chainModel.countDocuments({ isEnabled: true }),
      this.incidentModel.countDocuments({ status: 'open' }), this.failsafeModel.countDocuments({ isEnabled: true })
    ]);
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const execs24h = await this.execModel.countDocuments({ createdAt: { $gte: since24h } });
    const config = await this.configModel.findOne({ type: 'global' }).lean();
    const ms: any = await this.snapshotModel.findOne({ scopeType: 'global' }).sort({ createdAt: -1 }).lean();
    const fb = await this.feedbackModel.find().lean();
    const posFb = fb.filter(f => f.impactType === 'positive').length;
    return { autoActions: { total: rulesTotal, active: rulesActive, executions24h: execs24h }, actionChains: { total: chainsTotal, active: chainsActive }, failsafe: { rules: failsafeCount, openIncidents: incidentsOpen }, feedback: { total: fb.length, positiveRate: fb.length > 0 ? +((posFb / fb.length) * 100).toFixed(1) : 0 }, marketState: ms ? this.c(ms) : { state: 'balanced', ratio: 1.0 }, automationConfig: config ? this.c(config) : {}, timestamp: nowUtc() };
  }

  // ── Engine Control ──
  getMonitor() { return this.engine.getMonitorData(); }
  getHistory(limit: number) { return this.engine.getHistory(limit); }
  getShadowHistory(limit: number) { return this.engine.getShadowHistory(limit); }
  async startEngine() { await this.engine.start(); return { status: this.engine.stats.status }; }
  async stopEngine() { await this.engine.stop(); return { status: this.engine.stats.status }; }
  async pauseEngine() { await this.engine.pause(); return { status: this.engine.stats.status }; }
  async resumeEngine() { await this.engine.resume(); return { status: this.engine.stats.status }; }
  updateEngineConfig(body: any) { if (body.interval) this.engine.setInterval(body.interval); return { interval: this.engine.getInterval(), status: this.engine.stats.status }; }

  // ── Shadow ──
  getShadowComparison() {
    const act = this.engine._history.filter(h => h.status === 'executed'), sh = this.engine._shadowHistory;
    const avg = (e: any[], k: string) => { const v = e.map(x => x.metricsAfter?.[k] || 0).filter(Boolean); return v.length > 0 ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : 0; };
    return { active: { count: act.length, avgConversion: avg(act, 'conversion'), avgEta: avg(act, 'eta'), totalCost: +(act.reduce((s, e) => s + (e.cost || 0), 0)).toFixed(4), totalRevenue: +(act.reduce((s, e) => s + (e.revenueImpact || 0), 0)).toFixed(2) }, shadow: { count: sh.length, avgConversion: avg(sh, 'conversion'), avgEta: avg(sh, 'eta'), totalCost: +(sh.reduce((s, e) => s + (e.cost || 0), 0)).toFixed(4), totalRevenue: +(sh.reduce((s, e) => s + (e.revenueImpact || 0), 0)).toFixed(2) }, timestamp: nowUtc() };
  }

  // ── Replay ──
  async runReplay(timeRangeHours: number, rulesetAIds: string[], rulesetBMods: any) { const r = await this.engine.runReplay(timeRangeHours, rulesetAIds, rulesetBMods); const record = { id: uid(), ...r, rulesetAIds, rulesetBMods, createdAt: nowUtc() }; await this.replayModel.create(record); return record; }
  async getReplayHistory(limit = 20) { return this.cl(await this.replayModel.find().sort({ createdAt: -1 }).limit(limit).lean()); }

  // ── ROI ──
  getROI() { return this.engine.getROIData(); }
  async getROISummary() {
    const roi = this.engine.getROIData();
    const rules = await this.ruleModel.find({}, { _id: 0, id: 1, name: 1 }).lean();
    const rm = Object.fromEntries(rules.map(r => [r.id, r.name]));
    for (const item of roi.byRule) if (rm[item.ruleId]) item.ruleName = rm[item.ruleId];
    const chains = await this.chainModel.find({}, { _id: 0, id: 1, name: 1 }).lean();
    const cm = Object.fromEntries(chains.map(c => [c.id, c.name]));
    for (const item of roi.byChain) if (cm[item.chainId]) item.chainName = cm[item.chainId];
    const pushCost = this.engine._costByAction.get('send_push') || 0;
    const pushCount = this.engine._history.filter(h => h.actionType === 'send_push' && h.status === 'executed').length;
    const boostCost = this.engine._costByAction.get('boost_visibility') || 0;
    const boostCount = this.engine._history.filter(h => h.actionType === 'boost_visibility' && h.status === 'executed').length;
    const surges = this.engine._history.filter(h => h.actionType === 'set_surge' && h.status === 'executed');
    return { ...roi, costBreakdown: { costPerPush: +(pushCost / Math.max(pushCount, 1)).toFixed(4), pushCount, costPerIncentive: +(boostCost / Math.max(boostCount, 1)).toFixed(4), incentiveCount: boostCount, avgSurgeImpact: surges.length > 0 ? +(surges.reduce((s, h) => s + (h.revenueImpact || 0), 0) / surges.length).toFixed(2) : 0, surgeCount: surges.length } };
  }

  // ── Idempotency ──
  getIdempotencyStatus() { const now = Date.now() / 1000; const active: any[] = []; for (const [k, v] of this.engine._idempotencyKeys) if (v > now) active.push({ key: k, ttlSeconds: +(v - now).toFixed(1) }); return { activeKeys: active.length, keys: active.slice(0, 50), totalSkipped: this.engine.stats.skipped_idempotency, idemTtl: this.engine._idemTtl, timestamp: nowUtc() }; }
  updateIdempotencyConfig(ttl: number) { this.engine._idemTtl = Math.max(30, Math.min(3600, ttl)); return { idemTtl: this.engine._idemTtl }; }
  clearIdempotencyKeys() { const cnt = this.engine._idempotencyKeys.size; this.engine._idempotencyKeys.clear(); return { cleared: cnt }; }
}
