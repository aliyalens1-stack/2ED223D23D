import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

// Default platform configuration
const DEFAULTS: Record<string, { value: any; description: string; isSecret: boolean }> = {
  'stripe.secret_key': { value: '', description: 'Stripe Secret API Key', isSecret: true },
  'stripe.webhook_secret': { value: '', description: 'Stripe Webhook Signing Secret', isSecret: true },
  'stripe.currency': { value: 'rub', description: 'Default payment currency', isSecret: false },
  'platform.fee_percent': { value: 15, description: 'Platform commission percentage', isSecret: false },
  'booking.slot_reservation_minutes': { value: 15, description: 'Slot reservation timeout in minutes', isSecret: false },
  'booking.max_advance_days': { value: 30, description: 'Max days in advance for booking', isSecret: false },
};

@Injectable()
export class PlatformConfigService implements OnModuleInit {
  private cache: Map<string, any> = new Map();

  constructor(
    @InjectModel('PlatformConfig') private readonly configModel: Model<any>,
  ) {}

  async onModuleInit() {
    // Seed defaults if not exist
    for (const [key, def] of Object.entries(DEFAULTS)) {
      const existing = await this.configModel.findOne({ key });
      if (!existing) {
        await this.configModel.create({ key, ...def });
      }
    }
    // Warm cache
    await this.refreshCache();
  }

  async refreshCache() {
    const all = await this.configModel.find().lean();
    this.cache.clear();
    for (const item of all) {
      this.cache.set(item.key, item.value);
    }
  }

  async get(key: string): Promise<any> {
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    const doc: any = await this.configModel.findOne({ key }).lean();
    if (doc) {
      this.cache.set(key, doc.value);
      return doc.value;
    }
    return DEFAULTS[key]?.value ?? null;
  }

  async set(key: string, value: any): Promise<any> {
    const doc = await this.configModel.findOneAndUpdate(
      { key },
      { $set: { value } },
      { new: true, upsert: true },
    );
    this.cache.set(key, value);
    return doc;
  }

  async getAll(includeSecrets = false): Promise<any[]> {
    const all: any[] = await this.configModel.find().lean();
    if (!includeSecrets) {
      return all.map((item: any) => ({
        ...item,
        value: item.isSecret ? (item.value ? '***configured***' : '') : item.value,
      }));
    }
    return all;
  }

  // Convenience getters
  async getStripeSecretKey(): Promise<string> {
    return (await this.get('stripe.secret_key')) || '';
  }

  async getStripeWebhookSecret(): Promise<string> {
    return (await this.get('stripe.webhook_secret')) || '';
  }

  async getPlatformFeePercent(): Promise<number> {
    return (await this.get('platform.fee_percent')) ?? 15;
  }

  async getSlotReservationMinutes(): Promise<number> {
    return (await this.get('booking.slot_reservation_minutes')) ?? 15;
  }
}
