import { Controller, Get, Post, Query, Body } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { EventBusService } from './event-bus.service';

interface StoredEvent {
  id: string;
  type: string;
  data: any;
  timestamp: string;
}

@Controller('realtime')
export class RealtimeController {
  private eventBuffer: StoredEvent[] = [];
  private maxBufferSize = 200;
  private counter = 0;

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly eventBus: EventBusService,
  ) {}

  @Get('status')
  getStatus() {
    const stats = this.gateway.getStats();
    return {
      connected: true,
      mode: 'polling',
      clients: stats,
      eventsBuffered: this.eventBuffer.length,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('events')
  getEvents(
    @Query('since') since?: string,
    @Query('limit') limit?: number,
  ) {
    const maxLimit = Math.min(limit || 20, 50);
    let events: StoredEvent[];

    if (since) {
      const sinceDate = new Date(since).getTime();
      events = this.eventBuffer.filter(
        (e) => new Date(e.timestamp).getTime() > sinceDate,
      );
    } else {
      events = this.eventBuffer.slice(-maxLimit);
    }

    return {
      events: events.slice(-maxLimit),
      total: events.length,
      timestamp: new Date().toISOString(),
    };
  }

  @Post('emit')
  emitEvent(
    @Query('event_type') eventType: string,
    @Body() data: any,
  ) {
    const event: StoredEvent = {
      id: `evt_${++this.counter}_${Date.now()}`,
      type: eventType || 'test.event',
      data: data || {},
      timestamp: new Date().toISOString(),
    };

    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }

    // Route by event prefix:
    //  zone:*   — public (marketplace map, admin)       → global
    //  booking:* — user-specific + admin                 → global (filtered client-side)
    //  provider:* — admin + providers                    → admin + providers
    //  orchestrator:* / failsafe:* / alert:* / governance:* — admin only
    //  default — admin
    const payload = { type: event.type, data: event.data };
    if (event.type.startsWith('zone:') || event.type.startsWith('booking:')) {
      this.gateway.emitGlobal(event.type, payload);
    } else if (event.type.startsWith('provider:')) {
      this.gateway.emitToAdmin(event.type, payload);
      this.gateway.emitToProviders(event.type, payload);
    } else {
      this.gateway.emitToAdmin(event.type, payload);
    }

    return { success: true, event };
  }

  // Called internally by other services to push events into the polling buffer
  pushEvent(type: string, data: any) {
    const event: StoredEvent = {
      id: `evt_${++this.counter}_${Date.now()}`,
      type,
      data,
      timestamp: new Date().toISOString(),
    };
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBufferSize) {
      this.eventBuffer = this.eventBuffer.slice(-this.maxBufferSize);
    }
  }
}
