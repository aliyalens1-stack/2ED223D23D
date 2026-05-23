import { Controller, Get, Post, Patch, Delete, Body, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { AutomationService } from './automation.service';

@Controller('admin/automation')
export class AutomationController {
  constructor(private readonly svc: AutomationService) {}

  @Get('dashboard') getDashboard() { return this.svc.getDashboard(); }

  // Rules
  @Get('rules') getRules() { return this.svc.getRules(); }
  @Post('rules') createRule(@Body() b: any) { return this.svc.createRule(b); }
  @Patch('rules/:id') async updateRule(@Param('id') id: string, @Body() b: any) { try { return await this.svc.updateRule(id, b); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Delete('rules/:id') async deleteRule(@Param('id') id: string) { try { return await this.svc.deleteRule(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('rules/:id/toggle') async toggleRule(@Param('id') id: string) { try { return await this.svc.toggleRule(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('rules/:id/run-test') async testRule(@Param('id') id: string) { try { return await this.svc.testRule(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('rules/:id/set-mode') async setRuleMode(@Param('id') id: string, @Body() b: { mode: string }) { try { return await this.svc.setRuleMode(id, b.mode); } catch (e: any) { throw new HttpException(e.message, HttpStatus.BAD_REQUEST); } }
  @Post('rules/:id/promote') async promoteRule(@Param('id') id: string) { try { return await this.svc.promoteRule(id); } catch (e: any) { throw new HttpException(e.message, HttpStatus.BAD_REQUEST); } }
  @Post('rules/bulk-promote') async bulkPromote(@Body() b: { ruleIds: string[] }) { return this.svc.bulkPromote(b.ruleIds || []); }
  @Get('executions') getExecutions(@Query('ruleId') ruleId?: string, @Query('limit') limit?: number) { return this.svc.getExecutions(ruleId, limit || 50); }

  // Chains
  @Get('chains') getChains() { return this.svc.getChains(); }
  @Post('chains') createChain(@Body() b: any) { return this.svc.createChain(b); }
  @Patch('chains/:id') async updateChain(@Param('id') id: string, @Body() b: any) { try { return await this.svc.updateChain(id, b); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Delete('chains/:id') async deleteChain(@Param('id') id: string) { try { return await this.svc.deleteChain(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('chains/:id/toggle') async toggleChain(@Param('id') id: string) { try { return await this.svc.toggleChain(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('chains/:id/run-test') async testChain(@Param('id') id: string) { try { return await this.svc.testChain(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Get('chains/:id/executions') getChainExecs(@Param('id') id: string, @Query('limit') limit?: number) { return this.svc.getChainExecutions(id, limit || 20); }

  // Config
  @Get('config') getConfig() { return this.svc.getConfig(); }
  @Post('config') updateConfig(@Body() b: any) { return this.svc.updateConfig(b); }

  // Engine
  @Get('engine/monitor') getMonitor() { return this.svc.getMonitor(); }
  @Get('engine/history') getHistory(@Query('limit') limit?: number) { return this.svc.getHistory(limit || 50); }
  @Post('engine/start') startEngine() { return this.svc.startEngine(); }
  @Post('engine/stop') stopEngine() { return this.svc.stopEngine(); }
  @Post('engine/pause') pauseEngine() { return this.svc.pauseEngine(); }
  @Post('engine/resume') resumeEngine() { return this.svc.resumeEngine(); }
  @Post('engine/config') updateEngineConfig(@Body() b: any) { return this.svc.updateEngineConfig(b); }

  // Shadow
  @Get('shadow/history') getShadowHistory(@Query('limit') limit?: number) { return this.svc.getShadowHistory(limit || 50); }
  @Get('shadow/comparison') getShadowComparison() { return this.svc.getShadowComparison(); }

  // Replay
  @Post('replay') runReplay(@Body() b: any) { return this.svc.runReplay(b.timeRangeHours || 4, b.rulesetAIds || [], b.rulesetBMods || {}); }
  @Get('replay/history') getReplayHistory(@Query('limit') limit?: number) { return this.svc.getReplayHistory(limit || 20); }

  // ROI
  @Get('roi') getROI() { return this.svc.getROI(); }
  @Get('roi/summary') getROISummary() { return this.svc.getROISummary(); }

  // Idempotency
  @Get('idempotency') getIdempotency() { return this.svc.getIdempotencyStatus(); }
  @Post('idempotency/config') updateIdempotencyConfig(@Body() b: { ttl: number }) { return this.svc.updateIdempotencyConfig(b.ttl); }
  @Post('idempotency/clear') clearIdempotencyKeys() { return this.svc.clearIdempotencyKeys(); }

  // Unified State
  @Get('unified-state') getUnifiedState() { return this.svc.getUnifiedState(); }
  @Post('unified-state/sync') async syncUnifiedState() { try { return await this.svc.syncUnifiedState(); } catch (e: any) { throw new HttpException(e.message, HttpStatus.NOT_FOUND); } }
  @Get('unified-state/health') getUnifiedStateHealth() { return this.svc.getUnifiedStateHealth(); }

  // Failsafe
  @Get('failsafe/rules') getFailsafeRules() { return this.svc.getFailsafeRules(); }
  @Post('failsafe/rules') createFailsafeRule(@Body() b: any) { return this.svc.createFailsafeRule(b); }
  @Get('failsafe/incidents') getFailsafeIncidents(@Query('status') status?: string, @Query('limit') limit?: number) { return this.svc.getFailsafeIncidents(status, limit || 50); }
  @Post('failsafe/incidents/:id/resolve') async resolveIncident(@Param('id') id: string) { try { return await this.svc.resolveIncident(id); } catch { throw new HttpException('Not found', HttpStatus.NOT_FOUND); } }
  @Post('failsafe/run-test') testFailsafe() { return this.svc.testFailsafe(); }

  // Feedback
  @Get('feedback') getFeedback(@Query('ruleId') ruleId?: string, @Query('limit') limit?: number) { return this.svc.getFeedback(ruleId, limit || 50); }
  @Get('feedback/summary') getFeedbackSummary() { return this.svc.getFeedbackSummary(); }

  // Dry Run & Performance
  @Post('dry-run') dryRun(@Body() b: any) { return this.svc.dryRun(b.scenario || 'critical_zone_supply_drop', b.scopeType || 'zone', b.scopeId || 'kyiv-center'); }
  @Get('performance') getRulePerformance() { return this.svc.getRulePerformance(); }
}
