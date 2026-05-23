import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PaymentStatus } from './payment.schema';
import { TransactionType } from './payment-transaction.schema';
import { CreatePaymentDto, RefundPaymentDto } from './dto/payment.dto';
import { BookingStatus } from '../../shared/enums';
import { StripeService } from './stripe.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { EventBus, PlatformEvent } from '../../shared/events';
// 🔥 Commission Engine Integration
import { CommissionEngineService } from './commission-engine.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectModel('Payment') private readonly paymentModel: Model<any>,
    @InjectModel('PaymentTransaction') private readonly txModel: Model<any>,
    @InjectModel('Booking') private readonly bookingModel: Model<any>,
    @InjectModel('User') private readonly userModel: Model<any>,
    private readonly stripeService: StripeService,
    private readonly configService: PlatformConfigService,
    private readonly eventBus: EventBus,
    // 🔥 Inject Commission Engine
    private readonly commissionEngine: CommissionEngineService,
  ) {}

  /**
   * Create payment + Stripe PaymentIntent for a confirmed booking
   */
  async create(userId: string, dto: CreatePaymentDto) {
    const booking: any = await this.bookingModel.findById(dto.bookingId).lean();
    if (!booking) throw new NotFoundException('Booking not found');
    if (String(booking.userId) !== userId) throw new BadRequestException('Not authorized');
    if (booking.status !== BookingStatus.CONFIRMED && booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException('Booking must be pending or confirmed before payment');
    }

    // Check existing payment
    const existing: any = await this.paymentModel.findOne({ bookingId: dto.bookingId });
    if (existing) {
      if (existing.status === PaymentStatus.PAID) {
        throw new ConflictException('Payment already completed');
      }
      // Return existing pending/draft payment with clientSecret
      return this.sanitizePayment(existing);
    }

    const user: any = await this.userModel.findById(userId).lean();
    
    // 🔥 USE COMMISSION ENGINE instead of fixed fee
    const amount = booking.snapshot?.price || 0;
    if (amount <= 0) throw new BadRequestException('Booking has no price');

    const commissionResult = await this.commissionEngine.calculate({
      providerId: String(booking.organizationId),
      bookingId: dto.bookingId,
      amount,
    });

    const platformFee = commissionResult.platformFee;
    const providerAmount = commissionResult.providerAmount;
    const feePercent = commissionResult.ratePercent;

    // Create payment record with commission breakdown
    const payment = await this.paymentModel.create({
      bookingId: new Types.ObjectId(dto.bookingId),
      userId: new Types.ObjectId(userId),
      organizationId: booking.organizationId,
      amount,
      currency: 'rub',
      platformFee,
      providerAmount,
      platformFeePercent: feePercent,
      // 🔥 Save commission breakdown
      commissionLog: commissionResult.log,
      status: PaymentStatus.DRAFT,
      paymentMethod: dto.paymentMethod || 'card',
      snapshot: {
        serviceName: booking.snapshot?.serviceName || '',
        orgName: booking.snapshot?.orgName || '',
        userName: user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '',
      },
    });

    // Create Stripe PaymentIntent
    try {
      const intent = await this.stripeService.createPaymentIntent({
        amount: amount * 100, // Convert to kopecks
        currency: 'rub',
        metadata: {
          paymentId: String(payment._id),
          bookingId: dto.bookingId,
          userId,
        },
        description: `Booking: ${booking.snapshot?.serviceName || 'Service'} at ${booking.snapshot?.orgName || 'Provider'}`,
      });

      payment.paymentIntentId = intent.intentId;
      payment.clientSecret = intent.clientSecret;
      payment.status = PaymentStatus.PENDING;
      await payment.save();

      // Record transaction
      await this.txModel.create({
        paymentId: payment._id,
        type: TransactionType.INTENT_CREATED,
        amount,
        status: 'pending',
        externalId: intent.intentId,
      });

      this.logger.log(`Payment ${payment._id} created with intent ${intent.intentId}`);
    } catch (err) {
      payment.status = PaymentStatus.FAILED;
      payment.failureReason = err.message;
      payment.failedAt = new Date();
      await payment.save();

      await this.txModel.create({
        paymentId: payment._id,
        type: TransactionType.PAYMENT_FAILED,
        amount,
        status: 'failed',
        payloadSnapshot: { error: err.message },
      });

      throw new BadRequestException(`Payment creation failed: ${err.message}`);
    }

    return this.sanitizePayment(payment);
  }

  /**
   * Confirm payment (mock mode fallback — when Stripe is not configured)
   */
  async confirmMock(userId: string, paymentId: string) {
    const isStripeConfigured = await this.stripeService.isConfigured();
    if (isStripeConfigured) {
      throw new BadRequestException('Use Stripe client-side confirmation. This endpoint is for mock mode only.');
    }

    const payment: any = await this.paymentModel.findById(paymentId);
    if (!payment) throw new NotFoundException('Payment not found');
    if (String(payment.userId) !== userId) throw new BadRequestException('Not authorized');
    if (payment.status === PaymentStatus.PAID) throw new ConflictException('Already paid');
    if (payment.status === PaymentStatus.REFUNDED) throw new BadRequestException('Already refunded');

    payment.status = PaymentStatus.PAID;
    payment.paidAt = new Date();
    await payment.save();

    // Update booking status to confirmed + paid
    await this.bookingModel.findByIdAndUpdate(payment.bookingId, {
      $set: { paymentStatus: 'paid', isPaid: true, status: BookingStatus.CONFIRMED },
    });

    await this.txModel.create({
      paymentId: payment._id,
      type: TransactionType.PAYMENT_CAPTURED,
      amount: payment.amount,
      status: 'paid',
      externalId: payment.paymentIntentId,
    });

    // Emit event
    await this.eventBus.emit(PlatformEvent.PAYMENT_SUCCESS, {
      paymentId: String(payment._id),
      bookingId: String(payment.bookingId),
      userId: String(payment.userId),
      amount: payment.amount,
    });

    return this.sanitizePayment(payment);
  }

  /**
   * Handle Stripe webhook events
   */
  async handleWebhook(event: { type: string; data: { object: any } }) {
    const { type, data } = event;
    const obj = data.object;

    this.logger.log(`Webhook received: ${type}`);

    switch (type) {
      case 'payment_intent.succeeded': {
        const payment: any = await this.paymentModel.findOne({ paymentIntentId: obj.id });
        if (!payment) {
          this.logger.warn(`Payment not found for intent ${obj.id}`);
          return;
        }
        if (payment.status === PaymentStatus.PAID) return; // Idempotent

        payment.status = PaymentStatus.PAID;
        payment.paidAt = new Date();
        payment.chargeId = obj.latest_charge || null;
        payment.stripeMetadata = { amount_received: obj.amount_received };
        await payment.save();

        // Update booking
        await this.bookingModel.findByIdAndUpdate(payment.bookingId, {
          $set: { paymentStatus: 'paid', isPaid: true },
        });

        await this.txModel.create({
          paymentId: payment._id,
          type: TransactionType.PAYMENT_CAPTURED,
          amount: payment.amount,
          status: 'paid',
          externalId: obj.id,
          payloadSnapshot: { charge: obj.latest_charge, amount_received: obj.amount_received },
        });

        await this.eventBus.emit(PlatformEvent.PAYMENT_SUCCESS, {
          paymentId: String(payment._id),
          bookingId: String(payment.bookingId),
          userId: String(payment.userId),
          amount: payment.amount,
        });

        this.logger.log(`Payment ${payment._id} succeeded via webhook`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const payment: any = await this.paymentModel.findOne({ paymentIntentId: obj.id });
        if (!payment) return;

        payment.status = PaymentStatus.FAILED;
        payment.failedAt = new Date();
        payment.failureReason = obj.last_payment_error?.message || 'Payment failed';
        await payment.save();

        await this.txModel.create({
          paymentId: payment._id,
          type: TransactionType.PAYMENT_FAILED,
          amount: payment.amount,
          status: 'failed',
          externalId: obj.id,
          payloadSnapshot: { error: obj.last_payment_error },
        });

        this.logger.log(`Payment ${payment._id} failed via webhook`);
        break;
      }

      case 'charge.refunded': {
        const intentId = obj.payment_intent;
        const payment: any = await this.paymentModel.findOne({ paymentIntentId: intentId });
        if (!payment) return;

        const refundedAmount = obj.amount_refunded / 100;
        const isFullRefund = refundedAmount >= payment.amount;

        payment.status = isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
        payment.refundedAt = new Date();
        await payment.save();

        if (isFullRefund) {
          await this.bookingModel.findByIdAndUpdate(payment.bookingId, {
            $set: { paymentStatus: 'refunded' },
          });
        }

        await this.txModel.create({
          paymentId: payment._id,
          type: TransactionType.REFUND_COMPLETED,
          amount: refundedAmount,
          status: payment.status,
          externalId: obj.id,
        });

        this.logger.log(`Payment ${payment._id} refunded (${refundedAmount})`);
        break;
      }

      default:
        this.logger.log(`Unhandled webhook event: ${type}`);
    }
  }

  /**
   * Get payment by ID
   */
  async getById(paymentId: string) {
    const payment = await this.paymentModel.findById(paymentId).lean();
    if (!payment) throw new NotFoundException('Payment not found');
    return this.sanitizePayment(payment);
  }

  /**
   * Get payment by booking ID
   */
  async getByBooking(bookingId: string) {
    const payment = await this.paymentModel.findOne({ bookingId: new Types.ObjectId(bookingId) }).lean();
    return payment ? this.sanitizePayment(payment) : null;
  }

  /**
   * Get my payments
   */
  async getMyPayments(userId: string) {
    const payments = await this.paymentModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ createdAt: -1 })
      .lean();
    return payments.map((p: any) => this.sanitizePayment(p));
  }

  /**
   * Refund payment
   */
  async refund(paymentId: string, dto?: RefundPaymentDto) {
    const payment: any = await this.paymentModel.findById(paymentId);
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.status !== PaymentStatus.PAID) {
      throw new BadRequestException('Can only refund paid payments');
    }

    try {
      const result = await this.stripeService.createRefund({
        paymentIntentId: payment.paymentIntentId,
        amount: dto?.amount ? dto.amount * 100 : undefined,
        reason: dto?.reason,
      });

      const isPartial = dto?.amount && dto.amount < payment.amount;
      payment.status = isPartial ? PaymentStatus.PARTIALLY_REFUNDED : PaymentStatus.REFUNDED;
      payment.refundedAt = new Date();
      payment.refundId = result?.refundId || null;
      await payment.save();

      if (!isPartial) {
        await this.bookingModel.findByIdAndUpdate(payment.bookingId, {
          $set: { paymentStatus: 'refunded' },
        });
      }

      await this.txModel.create({
        paymentId: payment._id,
        type: TransactionType.REFUND_INITIATED,
        amount: dto?.amount || payment.amount,
        status: payment.status,
        externalId: result?.refundId,
      });

      this.logger.log(`Payment ${payment._id} refund initiated`);
      return this.sanitizePayment(payment);
    } catch (err) {
      throw new BadRequestException(`Refund failed: ${err.message}`);
    }
  }

  /**
   * Get all payments (admin)
   */
  async getAllPayments(options?: { status?: string; limit?: number; skip?: number }) {
    const query: any = {};
    if (options?.status) query.status = options.status;

    const [payments, total] = await Promise.all([
      this.paymentModel
        .find(query)
        .sort({ createdAt: -1 })
        .skip(options?.skip || 0)
        .limit(options?.limit || 50)
        .lean(),
      this.paymentModel.countDocuments(query),
    ]);

    const stats = await this.paymentModel.aggregate([
      { $match: { status: PaymentStatus.PAID } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          totalPlatformFee: { $sum: '$platformFee' },
          totalProviderAmount: { $sum: '$providerAmount' },
          count: { $sum: 1 },
        },
      },
    ]);

    return {
      payments: payments.map((p: any) => this.sanitizePayment(p)),
      total,
      stats: stats[0] || { totalAmount: 0, totalPlatformFee: 0, totalProviderAmount: 0, count: 0 },
    };
  }

  /**
   * Get payment transactions (ledger)
   */
  async getTransactions(paymentId: string) {
    return this.txModel.find({ paymentId: new Types.ObjectId(paymentId) }).sort({ createdAt: -1 }).lean();
  }

  /**
   * Remove clientSecret from response for non-owner
   */
  private sanitizePayment(payment: any) {
    const obj = payment.toObject ? payment.toObject() : { ...payment };
    // Keep clientSecret — needed by frontend for Stripe confirmation
    return obj;
  }
}
