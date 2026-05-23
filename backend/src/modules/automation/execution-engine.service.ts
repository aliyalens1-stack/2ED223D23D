import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

const uid = () => uuidv4();
const nowUtc = () => new Date().toISOString();
const ACTION_COSTS: Record<string, number> = {
  set_surge: 0, disable_surge: 0, send_push: 0.05, send_welcome: 0.03,
  expand_radius: 0, reduce_radius: 0, boost_visibility: 0.02, limit_visibility: 0,
  limit_provider: 0, enable_bidding: 0, assign_zone: 0, alert_operators: 0.01,
};

@Injectable()
export class ExecutionEngineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExecutionEngineService.name);
  private interval: NodeJS.Timer | null = null;
  private isRunning = false;
  private isPaused = false;
  private lock = false;
  private cycleInterval = 3;
  public _history: any[] = [];
  public _shadowHistory: any[] = [];
  public _idempotencyKeys = new Map<string, number>();
  public _idemTtl = 300;
  private _cooldowns = new Map<string, number>();
  private _totalCost = 0;
  private _totalRevenueImpact = 0;
  public _costByAction = new Map<string, number>();
  private _revenueByAction = new Map<string, number>();
  public _costByRule = new Map<string, number>();
  private _revenueByRule = new Map<string, number>();
  public _costByChain = new Map<string, number>();
  private _revenueByChain = new Map<string, number>();
  private _chainExecCount = new Map<string, number>();
  public stats: Record<string, any> = {
    status: 'stopped', total_cycles: 0, total_executions: 0, successful: 0,
    failed: 0, skipped_cooldown: 0, skipped_idempotency: 0, skipped_dry_run: 0,
    rollbacks: 0, chains_executed: 0, chains_failed: 0, shadow_executions: 0,
    total_cost_usd: 0, total_revenue_impact_usd: 0,
    last_cycle_ms: 0, started_at: null, last_cycle_at: null,
  };

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
  ) {}

  async onModuleInit() { await this.start(); }
  async onModuleDestroy() { await this.stop(); }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true; this.isPaused = false;
    this.stats.status = 'running'; this.stats.started_at = nowUtc();
    this.interval = setInterval(() => this.cycle(), this.cycleInterval * 1000);
    this.logger.log('Execution Engine STARTED');
  }
  async stop() {
    this.isRunning = false; this.stats.status = 'stopped';
    if (this.interval) { clearInterval(this.interval as any); this.interval = null; }
  }
  async pause() { this.isPaused = true; this.stats.status = 'paused'; }
  async resume() { this.isPaused = false; this.stats.status = 'running'; }

  private async cycle() {
    if (this.lock || this.isPaused) return;
    this.lock = true;
    const start = Date.now();
    try {
      await this.simulateMarketState();
      await this.evaluateRules();
      await this.evaluateChains();
      await this.checkFailsafes();
      await this.generateFeedback();
      this.cleanIdempotencyKeys();
      this.stats.total_cycles++;
      this.stats.last_cycle_at = nowUtc();
    } catch (err) { this.logger.error(`Cycle error: ${err}`); }
    finally { this.lock = false; this.stats.last_cycle_ms = Date.now() - start; }
  }

  private async simulateMarketState() {
    const zones = [
      { id: 'kyiv-center', name: 'Kyiv Center' }, { id: 'kyiv-podil', name: 'Kyiv Podil' },
      { id: 'kyiv-obolon', name: 'Kyiv Obolon' }, { id: 'lviv-center', name: 'Lviv Center' },
      { id: 'odessa-center', name: 'Odessa Center' },
    ];
    let tD = 0, tS = 0, cS = 0, eS = 0;
    for (const z of zones) {
      const d = Math.floor(Math.random() * 30) + 2, s = Math.floor(Math.random() * 20) + 1;
      const r = +(d / Math.max(s, 1)).toFixed(2);
      const st = r < 0.8 ? 'surplus' : r < 1.5 ? 'balanced' : r < 2.5 ? 'busy' : r < 3.5 ? 'surge' : 'critical';
      const c = +(Math.random() * 60 + 30).toFixed(1), e = +(Math.random() * 35 + 5).toFixed(1);
      tD += d; tS += s; cS += c; eS += e;
      if (this.stats.total_cycles % 10 === 0) {
        await this.snapshotModel.create({ id: uid(), scopeType: 'zone', scopeId: z.id, zoneName: z.name,
          demandCount: d, supplyCount: s, ratio: r, state: st, avgEtaMinutes: e,
          avgResponseSeconds: Math.floor(Math.random() * 600 + 60), conversionRate: c, createdAt: nowUtc() });
      }
    }
    if (this.stats.total_cycles % 5 === 0) {
      const gR = +(tD / Math.max(tS, 1)).toFixed(2);
      const gS = gR < 0.8 ? 'surplus' : gR < 1.5 ? 'balanced' : gR < 2.5 ? 'busy' : gR < 3.5 ? 'surge' : 'critical';
      await this.snapshotModel.create({ id: uid(), scopeType: 'global', scopeId: 'all',
        demandCount: tD, supplyCount: tS, ratio: gR, state: gS,
        avgEtaMinutes: +(eS / zones.length).toFixed(1), avgResponseSeconds: Math.floor(Math.random() * 400 + 100),
        conversionRate: +(cS / zones.length).toFixed(1), createdAt: nowUtc() });
    }
  }

  private async evaluateRules() {
    const config: any = await this.configModel.findOne({ type: 'global' }).lean();
    if (!config) return;
    const rules: any[] = await this.ruleModel.find({ isEnabled: true }).sort({ priority: 1 }).lean();
    const snap: any = await this.snapshotModel.findOne({ scopeType: 'global' }).sort({ createdAt: -1 }).lean();
    if (!snap) return;
    for (const rule of rules) {
      if (!this.evalCond(rule.conditionJson, snap)) continue;
      const idemKey = crypto.createHash('md5').update(`${rule.id}:${rule.actionType}:${JSON.stringify(rule.actionPayload)}`).digest('hex');
      const now = Date.now() / 1000;
      if (this._idempotencyKeys.has(idemKey) && (this._idempotencyKeys.get(idemKey) as number) > now) { this.stats.skipped_idempotency++; continue; }
      if (this._cooldowns.has(rule.id) && now - (this._cooldowns.get(rule.id) as number) < (rule.cooldownSeconds || 300)) { this.stats.skipped_cooldown++; continue; }
      const isShadow = rule.mode === 'shadow';
      const cost = ACTION_COSTS[rule.actionType] || 0;
      const revImpact = +(Math.random() * 50 - 10).toFixed(2);
      const metricsAfter = { conversion: +(snap.conversionRate + Math.random() * 10 - 3).toFixed(1), eta: +(snap.avgEtaMinutes + Math.random() * 4 - 2).toFixed(1), revenue: +((snap.conversionRate || 50) * 1000 + revImpact * 100).toFixed(0) };
      const exec: any = { id: uid(), ruleId: rule.id, ruleName: rule.name, entityType: rule.triggerType, entityId: snap.scopeId || 'global', triggerSnapshot: rule.conditionJson, actionType: rule.actionType, actionPayload: rule.actionPayload, isDryRun: config.dryRunMode || false, isShadow, affectedEntities: Math.floor(Math.random() * 15) + 1, cost, revenueImpact: revImpact, metricsAfter, timestamp: nowUtc() };
      if (isShadow) { exec.status = 'shadow'; this._shadowHistory.push(exec); if (this._shadowHistory.length > 100) this._shadowHistory.shift(); this.stats.shadow_executions++; }
      else if (config.dryRunMode) { exec.status = 'dry_run'; this.stats.skipped_dry_run++; }
      else { exec.status = 'executed'; this.stats.successful++; this._totalCost += cost; this._totalRevenueImpact += revImpact; this._costByAction.set(rule.actionType, (this._costByAction.get(rule.actionType) || 0) + cost); this._revenueByAction.set(rule.actionType, (this._revenueByAction.get(rule.actionType) || 0) + revImpact); this._costByRule.set(rule.id, (this._costByRule.get(rule.id) || 0) + cost); this._revenueByRule.set(rule.id, (this._revenueByRule.get(rule.id) || 0) + revImpact); }
      this._history.push(exec); if (this._history.length > 200) this._history.shift();
      this.stats.total_executions++;
      this._idempotencyKeys.set(idemKey, now + this._idemTtl);
      this._cooldowns.set(rule.id, now);
      await this.execModel.create({ ...exec, createdAt: nowUtc() });
    }
  }

  private evalCond(cond: any, snap: any): boolean {
    if (!cond?.field) return false;
    const v = snap[cond.field]; if (v === undefined) return false;
    switch (cond.operator) { case '>': return v > cond.value; case '<': return v < cond.value; case '>=': return v >= cond.value; case '<=': return v <= cond.value; case '==': return v == cond.value; case '!=': return v != cond.value; default: return false; }
  }

  private async evaluateChains() {
    const config: any = await this.configModel.findOne({ type: 'global' }).lean();
    if (!config?.autoChains) return;
    const chains: any[] = await this.chainModel.find({ isEnabled: true }).lean();
    for (const chain of chains) {
      if (Math.random() > 0.1) continue;
      const stepsResults = chain.steps.map((s: any) => ({ order: s.order, actionType: s.actionType, status: Math.random() > 0.15 ? 'completed' : 'failed', delaySeconds: s.delaySeconds }));
      const status = stepsResults.every((s: any) => s.status === 'completed') ? 'completed' : 'partial';
      await this.chainExecModel.create({ id: uid(), chainId: chain.id, status, isDryRun: config.dryRunMode || false, stepsResults, createdAt: nowUtc() });
      this.stats.chains_executed++;
      const cost = stepsResults.reduce((sum: number, s: any) => sum + (ACTION_COSTS[s.actionType] || 0), 0);
      const rev = +(Math.random() * 30).toFixed(2);
      this._costByChain.set(chain.id, (this._costByChain.get(chain.id) || 0) + cost);
      this._revenueByChain.set(chain.id, (this._revenueByChain.get(chain.id) || 0) + rev);
      this._chainExecCount.set(chain.id, (this._chainExecCount.get(chain.id) || 0) + 1);
    }
  }

  private async checkFailsafes() {
    if (this.stats.total_cycles % 20 !== 0) return;
    const rules: any[] = await this.failsafeModel.find({ isEnabled: true }).lean();
    for (const rule of rules) {
      if (Math.random() > 0.85) {
        await this.incidentModel.create({ id: uid(), ruleId: rule.id, ruleName: rule.name, detectedAt: nowUtc(), affectedEntityType: 'market', affectedEntityId: 'global', metricSnapshot: { metric: rule.metric, value: +(Math.random() * 100).toFixed(1) }, actionTaken: rule.rollbackActionType, status: 'open' });
        this.stats.rollbacks++;
      }
    }
  }

  private async generateFeedback() {
    if (this.stats.total_cycles % 15 !== 0) return;
    for (const exec of this._history.slice(-5).filter(h => h.status === 'executed')) {
      if (Math.random() > 0.3) continue;
      const types = ['positive', 'positive', 'positive', 'neutral', 'negative'];
      const it = types[Math.floor(Math.random() * types.length)];
      const score = it === 'positive' ? +(Math.random() * 10 + 3).toFixed(2) : it === 'neutral' ? +(Math.random() * 6 - 3).toFixed(2) : +(Math.random() * 10 - 12).toFixed(2);
      const cb = +(Math.random() * 20 + 55).toFixed(1), eb = +(Math.random() * 15 + 10).toFixed(1), rb = Math.floor(Math.random() * 50000 + 50000);
      await this.feedbackModel.create({ id: uid(), ruleId: exec.ruleId, executionId: exec.id, metricBefore: { conversion: cb, eta: eb, revenue: rb }, metricAfter: { conversion: +(cb + Math.random() * 15 - 5).toFixed(1), eta: +(eb + Math.random() * 6 - 3).toFixed(1), revenue: Math.floor(rb + Math.random() * 30000 - 10000) }, impactType: it, impactScore: score, createdAt: nowUtc() });
    }
  }

  private cleanIdempotencyKeys() {
    const now = Date.now() / 1000;
    for (const [k, v] of this._idempotencyKeys) if (v < now) this._idempotencyKeys.delete(k);
  }

  async runReplay(timeRangeHours: number, rulesetAIds: string[], rulesetBMods: any) {
    const since = new Date(Date.now() - timeRangeHours * 3600 * 1000).toISOString();
    const snaps: any[] = await this.snapshotModel.find({ createdAt: { $gte: since }, scopeType: 'global' }).sort({ createdAt: 1 }).lean();
    const rulesA: any[] = await this.ruleModel.find(rulesetAIds.length ? { id: { $in: rulesetAIds } } : { isEnabled: true }).lean();
    const sim = (rules: any[], s: any[]) => {
      let e = 0, ok = 0, cost = 0, rev = 0, cancel = 0;
      for (const sn of s) for (const r of rules) if (this.evalCond(r.conditionJson, sn)) {
        e++; if (Math.random() > 0.2) ok++; cost += ACTION_COSTS[r.actionType] || 0; rev += +(Math.random() * 40 - 5).toFixed(2); if (Math.random() > 0.85) cancel++;
      }
      return { executions: e, successful: ok, successRate: e > 0 ? +((ok / e) * 100).toFixed(1) : 0, cost: +cost.toFixed(4), revenue: +rev.toFixed(2), cancelRate: e > 0 ? +((cancel / e) * 100).toFixed(1) : 0 };
    };
    const a = sim(rulesA, snaps);
    const rulesB = rulesA.map(r => { const m = { ...r }; if (rulesetBMods.cooldownMultiplier) m.cooldownSeconds = Math.round((m.cooldownSeconds || 300) * rulesetBMods.cooldownMultiplier); if (rulesetBMods.priorityShift) m.priority = (m.priority || 5) + rulesetBMods.priorityShift; return m; });
    const b = sim(rulesB, snaps);
    const comparison = { executionsDiff: b.executions - a.executions, successRateDiff: +(b.successRate - a.successRate).toFixed(1), costDiff: +(b.cost - a.cost).toFixed(4), revenueDiff: +(b.revenue - a.revenue).toFixed(2), cancelRateDiff: +(b.cancelRate - a.cancelRate).toFixed(1) };
    return { timeRangeHours, snapshotsAnalyzed: snaps.length, rulesetA: a, rulesetB: b, comparison, winner: b.successRate > a.successRate && b.cancelRate <= a.cancelRate ? 'B' : 'A', timestamp: nowUtc() };
  }

  getROIData() {
    const mapToArr = (costMap: Map<string, number>, revMap: Map<string, number>, keyName: string) => {
      const all = new Set([...costMap.keys(), ...revMap.keys()]);
      return [...all].map(k => { const c = costMap.get(k) || 0, r = revMap.get(k) || 0; return { [keyName]: k, cost: +c.toFixed(4), revenue: +r.toFixed(2), roi: c > 0 ? +((r - c) / c).toFixed(2) : +r.toFixed(2) }; }).sort((a, b) => b.roi - a.roi);
    };
    return { totalCost: +this._totalCost.toFixed(4), totalRevenue: +this._totalRevenueImpact.toFixed(2), netROI: this._totalCost > 0 ? +((this._totalRevenueImpact - this._totalCost) / this._totalCost).toFixed(2) : +this._totalRevenueImpact.toFixed(2), byAction: mapToArr(this._costByAction, this._revenueByAction, 'actionType'), byRule: mapToArr(this._costByRule, this._revenueByRule, 'ruleId'), byChain: mapToArr(this._costByChain, this._revenueByChain, 'chainId') };
  }

  getMonitorData() {
    const now = Date.now() / 1000;
    return { engine: this.stats, recentExecutions: [...this._history].reverse().slice(0, 30), shadowExecutions: [...this._shadowHistory].reverse().slice(0, 20), idempotencyKeys: [...this._idempotencyKeys].filter(([, v]) => v > now).length, cooldowns: { count: this._cooldowns.size }, roi: this.getROIData() };
  }
  getHistory(limit = 50) { return [...this._history].reverse().slice(0, limit); }
  getShadowHistory(limit = 50) { return [...this._shadowHistory].reverse().slice(0, limit); }
  getInterval() { return this.cycleInterval; }
  setInterval(v: number) { this.cycleInterval = Math.max(1, Math.min(30, v)); }
}
