import { Injectable, Logger } from '@nestjs/common';
import { PlatformConfigService } from '../platform-config/platform-config.service';

// stripe@22 exports a function, not a class
const Stripe = require('stripe');

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);

  constructor(private readonly configService: PlatformConfigService) {}

  /**
   * Get Stripe client instance (lazy, uses admin-configured key)
   */
  private async getClient(): Promise<any | null> {
    const secretKey = await this.configService.getStripeSecretKey();
    if (!secretKey) {
      this.logger.warn('Stripe secret key not configured — running in MOCK mode');
      return null;
    }
    return Stripe(secretKey);
  }

  /**
   * Check if Stripe is configured
   */
  async isConfigured(): Promise<boolean> {
    const key = await this.configService.getStripeSecretKey();
    return !!key;
  }

  /**
   * Create a PaymentIntent
   */
  async createPaymentIntent(params: {
    amount: number;
    currency: string;
    metadata?: Record<string, string>;
    description?: string;
  }): Promise<{ intentId: string; clientSecret: string }> {
    const stripe = await this.getClient();
    if (!stripe) {
      // MOCK mode
      const mockId = `pi_mock_${Date.now()}`;
      return { intentId: mockId, clientSecret: `${mockId}_secret_mock` };
    }

    try {
      const intent = await stripe.paymentIntents.create({
        amount: params.amount,
        currency: params.currency,
        metadata: params.metadata || {},
        description: params.description,
        automatic_payment_methods: { enabled: true },
      });

      return {
        intentId: intent.id,
        clientSecret: intent.client_secret,
      };
    } catch (err) {
      this.logger.error(`Stripe createPaymentIntent failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Retrieve a PaymentIntent
   */
  async retrievePaymentIntent(intentId: string): Promise<any | null> {
    const stripe = await this.getClient();
    if (!stripe) return null;

    try {
      return await stripe.paymentIntents.retrieve(intentId);
    } catch (err) {
      this.logger.error(`Stripe retrievePaymentIntent failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Cancel a PaymentIntent
   */
  async cancelPaymentIntent(intentId: string): Promise<boolean> {
    const stripe = await this.getClient();
    if (!stripe) return true;

    try {
      await stripe.paymentIntents.cancel(intentId);
      return true;
    } catch (err) {
      this.logger.error(`Stripe cancelPaymentIntent failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Create a refund
   */
  async createRefund(params: {
    paymentIntentId: string;
    amount?: number;
    reason?: string;
  }): Promise<{ refundId: string }> {
    const stripe = await this.getClient();
    if (!stripe) {
      return { refundId: `re_mock_${Date.now()}` };
    }

    try {
      const refund = await stripe.refunds.create({
        payment_intent: params.paymentIntentId,
        amount: params.amount,
        reason: params.reason || 'requested_by_customer',
      });
      return { refundId: refund.id };
    } catch (err) {
      this.logger.error(`Stripe createRefund failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Verify webhook signature
   */
  async verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
  ): Promise<any | null> {
    const stripe = await this.getClient();
    const webhookSecret = await this.configService.getStripeWebhookSecret();

    if (!stripe || !webhookSecret) {
      this.logger.warn('Webhook verification skipped — Stripe not fully configured');
      return null;
    }

    try {
      return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      return null;
    }
  }
}
