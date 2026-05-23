import { Injectable, Logger } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';

// Event types
export enum EventType {
  // Request events
  REQUEST_CREATED = 'request.created',
  REQUEST_UPDATED = 'request.updated',
  REQUEST_EXPIRED = 'request.expired',
  REQUEST_ESCALATED = 'request.escalated',
  PROVIDER_RESPONDED = 'provider.responded',
  RESPONSE_SELECTED = 'response.selected',

  // Provider events
  PROVIDER_ONLINE = 'provider.online',
  PROVIDER_OFFLINE = 'provider.offline',
  PROVIDER_LOCATION_UPDATED = 'provider.location.updated',
  PROVIDER_STATUS_CHANGED = 'provider.status.changed',
  PROVIDER_VERIFIED = 'provider.verified',
  PROVIDER_SUSPENDED = 'provider.suspended',

  // Booking events
  BOOKING_CREATED = 'booking.created',
  BOOKING_CONFIRMED = 'booking.confirmed',
  BOOKING_STARTED = 'booking.started',
  BOOKING_COMPLETED = 'booking.completed',
  BOOKING_CANCELLED = 'booking.cancelled',

  // Payment events
  PAYMENT_SUCCESS = 'payment.success',
  PAYMENT_FAILED = 'payment.failed',
  REFUND_CREATED = 'refund.created',
  PAYOUT_PROCESSED = 'payout.processed',

  // Dispute events
  DISPUTE_OPENED = 'dispute.opened',
  DISPUTE_UPDATED = 'dispute.updated',
  DISPUTE_RESOLVED = 'dispute.resolved',

  // Review events
  REVIEW_POSTED = 'review.posted',
  REVIEW_FLAGGED = 'review.flagged',

  // System events
  ALERT_CREATED = 'alert.created',
  ALERT_DISMISSED = 'alert.dismissed',
  SLA_WARNING = 'sla.warning',
  SLA_BREACH = 'sla.breach',
}

export interface PlatformEvent {
  type: EventType;
  payload: any;
  metadata?: {
    userId?: string;
    providerId?: string;
    bookingId?: string;
    requestId?: string;
    cityId?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
  };
}

@Injectable()
export class EventBusService {
  private logger = new Logger('EventBus');

  constructor(private gateway: RealtimeGateway) {}

  // Main emit method
  emit(event: PlatformEvent) {
    const { type, payload, metadata } = event;

    this.logger.debug(`Event: ${type}`, JSON.stringify(payload).slice(0, 200));

    // Create standardized event payload
    const eventPayload = {
      type,
      data: payload,
      meta: metadata,
      timestamp: new Date().toISOString(),
    };

    // Route to appropriate rooms based on event type
    switch (type) {
      // Admin-only events
      case EventType.REQUEST_CREATED:
      case EventType.REQUEST_EXPIRED:
      case EventType.REQUEST_ESCALATED:
      case EventType.DISPUTE_OPENED:
      case EventType.DISPUTE_UPDATED:
      case EventType.PAYMENT_FAILED:
      case EventType.ALERT_CREATED:
      case EventType.SLA_WARNING:
      case EventType.SLA_BREACH:
      case EventType.PROVIDER_SUSPENDED:
        this.gateway.emitToAdmin(type, eventPayload);
        break;

      // Provider events - go to both admin and providers
      case EventType.PROVIDER_RESPONDED:
      case EventType.PROVIDER_ONLINE:
      case EventType.PROVIDER_OFFLINE:
      case EventType.PROVIDER_LOCATION_UPDATED:
      case EventType.PROVIDER_VERIFIED:
        this.gateway.emitToAdmin(type, eventPayload);
        if (metadata?.cityId) {
          this.gateway.emitToRoom(`city:${metadata.cityId}`, type, eventPayload);
        }
        break;

      // Booking events - admin + specific user + provider
      case EventType.BOOKING_CREATED:
      case EventType.BOOKING_CONFIRMED:
      case EventType.BOOKING_STARTED:
      case EventType.BOOKING_COMPLETED:
      case EventType.BOOKING_CANCELLED:
        this.gateway.emitToAdmin(type, eventPayload);
        if (metadata?.userId) {
          this.gateway.emitToUser(metadata.userId, type, eventPayload);
        }
        if (metadata?.providerId) {
          this.gateway.emitToRoom(`provider:${metadata.providerId}`, type, eventPayload);
        }
        break;

      // Payment events
      case EventType.PAYMENT_SUCCESS:
      case EventType.REFUND_CREATED:
      case EventType.PAYOUT_PROCESSED:
        this.gateway.emitToAdmin(type, eventPayload);
        if (metadata?.userId) {
          this.gateway.emitToUser(metadata.userId, type, eventPayload);
        }
        if (metadata?.providerId) {
          this.gateway.emitToRoom(`provider:${metadata.providerId}`, type, eventPayload);
        }
        break;

      // Review events
      case EventType.REVIEW_POSTED:
      case EventType.REVIEW_FLAGGED:
        this.gateway.emitToAdmin(type, eventPayload);
        if (metadata?.providerId) {
          this.gateway.emitToRoom(`provider:${metadata.providerId}`, type, eventPayload);
        }
        break;

      // Dispute resolution
      case EventType.DISPUTE_RESOLVED:
        this.gateway.emitToAdmin(type, eventPayload);
        if (metadata?.userId) {
          this.gateway.emitToUser(metadata.userId, type, eventPayload);
        }
        if (metadata?.providerId) {
          this.gateway.emitToRoom(`provider:${metadata.providerId}`, type, eventPayload);
        }
        break;

      // Global events
      default:
        this.gateway.emitGlobal(type, eventPayload);
    }
  }

  // Convenience methods for common events

  // ============ REQUEST EVENTS ============
  
  requestCreated(request: any) {
    this.emit({
      type: EventType.REQUEST_CREATED,
      payload: {
        id: request._id?.toString() || request.id,
        description: request.description?.slice(0, 100),
        serviceType: request.requestedServiceId?.name || request.serviceType,
        urgency: request.urgency,
        city: request.city?.nameLocal || request.city?.name,
        customerId: request.customerId?._id?.toString() || request.customerId,
        location: request.location,
      },
      metadata: {
        requestId: request._id?.toString() || request.id,
        cityId: request.cityId?.toString() || request.city?._id?.toString(),
        priority: request.urgency === 'emergency' ? 'critical' : request.urgency === 'urgent' ? 'high' : 'medium',
      },
    });
  }

  providerResponded(request: any, response: any) {
    this.emit({
      type: EventType.PROVIDER_RESPONDED,
      payload: {
        requestId: request._id?.toString() || request.id,
        responseId: response._id?.toString() || response.id,
        providerId: response.providerId?._id?.toString() || response.providerId,
        providerName: response.providerId?.name,
        price: response.price,
        responseTime: response.responseTime,
      },
      metadata: {
        requestId: request._id?.toString() || request.id,
        providerId: response.providerId?._id?.toString() || response.providerId,
      },
    });
  }

  requestExpired(request: any) {
    this.emit({
      type: EventType.REQUEST_EXPIRED,
      payload: {
        id: request._id?.toString() || request.id,
        description: request.description?.slice(0, 50),
        responsesCount: request.responsesCount || 0,
      },
      metadata: {
        requestId: request._id?.toString() || request.id,
        priority: 'high',
      },
    });
  }

  // ============ PROVIDER EVENTS ============

  providerLocationUpdated(provider: any, location: { lat: number; lng: number }) {
    this.emit({
      type: EventType.PROVIDER_LOCATION_UPDATED,
      payload: {
        id: provider._id?.toString() || provider.id,
        name: provider.name,
        location,
        isOnline: provider.isOnline,
      },
      metadata: {
        providerId: provider._id?.toString() || provider.id,
        cityId: provider.cityId?.toString(),
      },
    });
  }

  providerStatusChanged(provider: any, newStatus: string, oldStatus?: string) {
    this.emit({
      type: EventType.PROVIDER_STATUS_CHANGED,
      payload: {
        id: provider._id?.toString() || provider.id,
        name: provider.name,
        newStatus,
        oldStatus,
      },
      metadata: {
        providerId: provider._id?.toString() || provider.id,
        priority: newStatus === 'suspended' ? 'high' : 'medium',
      },
    });
  }

  providerOnline(provider: any) {
    this.emit({
      type: EventType.PROVIDER_ONLINE,
      payload: {
        id: provider._id?.toString() || provider.id,
        name: provider.name,
        location: provider.location,
      },
      metadata: {
        providerId: provider._id?.toString() || provider.id,
        cityId: provider.cityId?.toString(),
      },
    });
  }

  providerOffline(provider: any) {
    this.emit({
      type: EventType.PROVIDER_OFFLINE,
      payload: {
        id: provider._id?.toString() || provider.id,
        name: provider.name,
      },
      metadata: {
        providerId: provider._id?.toString() || provider.id,
        cityId: provider.cityId?.toString(),
      },
    });
  }

  // ============ BOOKING EVENTS ============

  bookingCreated(booking: any) {
    this.emit({
      type: EventType.BOOKING_CREATED,
      payload: {
        id: booking._id?.toString() || booking.id,
        customerId: booking.customerId?._id?.toString() || booking.customerId,
        customerName: booking.customerId?.firstName,
        providerId: booking.organizationId?._id?.toString() || booking.organizationId,
        providerName: booking.organizationId?.name,
        totalPrice: booking.totalPrice,
        scheduledDate: booking.scheduledDate,
      },
      metadata: {
        bookingId: booking._id?.toString() || booking.id,
        userId: booking.customerId?._id?.toString() || booking.customerId,
        providerId: booking.organizationId?._id?.toString() || booking.organizationId,
      },
    });
  }

  bookingConfirmed(booking: any) {
    this.emit({
      type: EventType.BOOKING_CONFIRMED,
      payload: {
        id: booking._id?.toString() || booking.id,
        providerName: booking.organizationId?.name,
      },
      metadata: {
        bookingId: booking._id?.toString() || booking.id,
        userId: booking.customerId?._id?.toString() || booking.customerId,
        providerId: booking.organizationId?._id?.toString() || booking.organizationId,
      },
    });
  }

  bookingCompleted(booking: any) {
    this.emit({
      type: EventType.BOOKING_COMPLETED,
      payload: {
        id: booking._id?.toString() || booking.id,
        totalPrice: booking.totalPrice,
        platformFee: booking.platformFee,
      },
      metadata: {
        bookingId: booking._id?.toString() || booking.id,
        userId: booking.customerId?._id?.toString() || booking.customerId,
        providerId: booking.organizationId?._id?.toString() || booking.organizationId,
      },
    });
  }

  // ============ PAYMENT EVENTS ============

  paymentSuccess(payment: any) {
    this.emit({
      type: EventType.PAYMENT_SUCCESS,
      payload: {
        id: payment._id?.toString() || payment.id,
        amount: payment.amount,
        type: payment.type,
      },
      metadata: {
        userId: payment.userId?.toString(),
        providerId: payment.organizationId?.toString(),
      },
    });
  }

  paymentFailed(payment: any, error?: string) {
    this.emit({
      type: EventType.PAYMENT_FAILED,
      payload: {
        id: payment._id?.toString() || payment.id,
        amount: payment.amount,
        error,
      },
      metadata: {
        userId: payment.userId?.toString(),
        priority: 'high',
      },
    });
  }

  // ============ DISPUTE EVENTS ============

  disputeOpened(dispute: any) {
    this.emit({
      type: EventType.DISPUTE_OPENED,
      payload: {
        id: dispute._id?.toString() || dispute.id,
        category: dispute.category,
        amountAtRisk: dispute.amountAtRisk,
        customerId: dispute.customerId?._id?.toString() || dispute.customerId,
        providerId: dispute.providerId?._id?.toString() || dispute.providerId,
      },
      metadata: {
        priority: dispute.priority === 'urgent' ? 'critical' : 'high',
      },
    });
  }

  disputeResolved(dispute: any, resolution: string) {
    this.emit({
      type: EventType.DISPUTE_RESOLVED,
      payload: {
        id: dispute._id?.toString() || dispute.id,
        resolution,
      },
      metadata: {
        userId: dispute.customerId?._id?.toString() || dispute.customerId,
        providerId: dispute.providerId?._id?.toString() || dispute.providerId,
      },
    });
  }

  // ============ REVIEW EVENTS ============

  reviewPosted(review: any) {
    this.emit({
      type: EventType.REVIEW_POSTED,
      payload: {
        id: review._id?.toString() || review.id,
        rating: review.rating,
        text: review.text?.slice(0, 100),
        providerId: review.organizationId?._id?.toString() || review.organizationId,
        providerName: review.organizationId?.name,
      },
      metadata: {
        providerId: review.organizationId?._id?.toString() || review.organizationId,
        priority: review.rating <= 2 ? 'high' : 'low',
      },
    });
  }

  // ============ ALERT EVENTS ============

  createAlert(alert: {
    type: 'critical' | 'warning' | 'info';
    title: string;
    description: string;
    count?: number;
    action?: string;
  }) {
    this.emit({
      type: EventType.ALERT_CREATED,
      payload: alert,
      metadata: {
        priority: alert.type === 'critical' ? 'critical' : alert.type === 'warning' ? 'high' : 'medium',
      },
    });
  }

  slaWarning(entity: 'request' | 'dispute' | 'booking', entityId: string, timeLeft: number) {
    this.emit({
      type: EventType.SLA_WARNING,
      payload: {
        entity,
        entityId,
        timeLeftMinutes: Math.round(timeLeft / 60000),
      },
      metadata: {
        priority: timeLeft < 300000 ? 'critical' : 'high', // < 5 min = critical
      },
    });
  }
}
