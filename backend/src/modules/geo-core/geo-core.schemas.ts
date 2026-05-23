import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

// ============ PROVIDER FIXED LOCATION ============
// СТО, гараж, точка детейлинга

@Schema({ collection: 'provider_locations', timestamps: true })
export class ProviderLocation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true, index: true })
  providerId: Types.ObjectId;

  @Prop({ required: true, enum: ['fixed', 'branch', 'main'] })
  type: string;

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number], // [lng, lat]
      required: true,
    },
  })
  point: {
    type: string;
    coordinates: number[];
  };

  @Prop()
  address: string;

  @Prop({ type: Types.ObjectId, ref: 'City' })
  cityId: Types.ObjectId;

  @Prop()
  district: string;

  @Prop({ default: false })
  isMain: boolean;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isVerified: boolean;

  @Prop({ enum: ['self', 'admin', 'geocoded', 'imported'], default: 'self' })
  source: string;

  @Prop()
  serviceRadius: number; // km

  @Prop({ type: Object })
  metadata: Record<string, any>;
}

export const ProviderLocationSchema = SchemaFactory.createForClass(ProviderLocation);
ProviderLocationSchema.index({ point: '2dsphere' });
ProviderLocationSchema.index({ providerId: 1, isMain: 1 });

// ============ PROVIDER LIVE LOCATION ============
// Выездной мастер - живая позиция

@Schema({ collection: 'provider_live_locations', timestamps: true })
export class ProviderLiveLocation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true, unique: true })
  providerId: Types.ObjectId;

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  })
  point: {
    type: string;
    coordinates: number[];
  };

  @Prop()
  accuracy: number; // meters

  @Prop()
  heading: number; // degrees 0-360

  @Prop()
  speed: number; // m/s

  @Prop()
  altitude: number;

  @Prop({ default: Date.now })
  capturedAt: Date;

  @Prop({ enum: ['gps', 'network', 'manual', 'simulated'], default: 'gps' })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'City' })
  cityId: Types.ObjectId;
}

export const ProviderLiveLocationSchema = SchemaFactory.createForClass(ProviderLiveLocation);
ProviderLiveLocationSchema.index({ point: '2dsphere' });
ProviderLiveLocationSchema.index({ providerId: 1 });
ProviderLiveLocationSchema.index({ capturedAt: -1 });

// ============ PROVIDER PRESENCE ============
// Статус присутствия мастера

@Schema({ collection: 'provider_presences', timestamps: true })
export class ProviderPresence extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Organization', required: true, unique: true })
  providerId: Types.ObjectId;

  @Prop({ 
    required: true, 
    enum: ['online', 'idle', 'offline'],
    default: 'offline'
  })
  onlineState: string;

  @Prop({ 
    required: true, 
    enum: ['available', 'busy', 'on_route', 'in_job', 'paused'],
    default: 'available'
  })
  workState: string;

  @Prop({ default: true })
  acceptsQuickRequests: boolean;

  @Prop({ default: true })
  acceptsDirectBookings: boolean;

  @Prop()
  lastSeenAt: Date;

  @Prop()
  onlineSince: Date;

  @Prop({ type: Types.ObjectId, ref: 'Booking' })
  currentBookingId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Quote' })
  currentRequestId: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  activeZones: string[];

  @Prop({ type: Object })
  deviceInfo: {
    platform?: string;
    appVersion?: string;
    deviceId?: string;
  };
}

export const ProviderPresenceSchema = SchemaFactory.createForClass(ProviderPresence);
ProviderPresenceSchema.index({ onlineState: 1, workState: 1 });
ProviderPresenceSchema.index({ lastSeenAt: -1 });

// ============ REQUEST LOCATION ============
// Точка, где нужна помощь клиенту

@Schema({ collection: 'request_locations', timestamps: true })
export class RequestLocation extends Document {
  @Prop({ type: Types.ObjectId, ref: 'Quote', required: true })
  requestId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  customerId: Types.ObjectId;

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: {
      type: [Number],
      required: true,
    },
  })
  point: {
    type: string;
    coordinates: number[];
  };

  @Prop()
  accuracy: number;

  @Prop({ enum: ['gps', 'manual_pin', 'address_geocoded', 'saved'], default: 'gps' })
  source: string;

  @Prop()
  address: string;

  @Prop({ type: Types.ObjectId, ref: 'City' })
  cityId: Types.ObjectId;

  @Prop()
  district: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const RequestLocationSchema = SchemaFactory.createForClass(RequestLocation);
RequestLocationSchema.index({ point: '2dsphere' });
RequestLocationSchema.index({ requestId: 1 });
RequestLocationSchema.index({ isActive: 1 });

// ============ GEO ZONE ============
// Зоны управления: priority, no-supply, high-demand

@Schema({ collection: 'geo_zones', timestamps: true })
export class GeoZone extends Document {
  @Prop({ required: true })
  name: string;

  @Prop({ 
    required: true, 
    enum: ['service_coverage', 'priority', 'no_supply', 'high_demand', 'admin_override', 'restricted']
  })
  type: string;

  @Prop({ type: Types.ObjectId, ref: 'City' })
  cityId: Types.ObjectId;

  @Prop({
    type: {
      type: String,
      enum: ['Polygon'],
      default: 'Polygon',
    },
    coordinates: {
      type: [[[Number]]], // Array of arrays of [lng, lat] pairs
      required: true,
    },
  })
  polygon: {
    type: string;
    coordinates: number[][][];
  };

  @Prop({ type: Object })
  metadata: {
    color?: string;
    priority?: number;
    description?: string;
    rules?: any;
  };

  @Prop({ default: true })
  isActive: boolean;

  @Prop()
  validFrom: Date;

  @Prop()
  validUntil: Date;
}

export const GeoZoneSchema = SchemaFactory.createForClass(GeoZone);
GeoZoneSchema.index({ polygon: '2dsphere' });
GeoZoneSchema.index({ type: 1, isActive: 1 });

// ============ GEO EVENT ============
// История гео-событий для аналитики

@Schema({ collection: 'geo_events', timestamps: true })
export class GeoEvent extends Document {
  @Prop({ 
    required: true, 
    enum: [
      'provider.location.updated',
      'provider.presence.changed',
      'request.location.created',
      'request.assigned',
      'provider.arrived',
      'provider.started_route',
      'provider.completed_route',
      'anomaly.detected'
    ]
  })
  eventType: string;

  @Prop({ enum: ['provider', 'customer', 'request', 'system'] })
  entityType: string;

  @Prop({ type: Types.ObjectId })
  entityId: Types.ObjectId;

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point',
    },
    coordinates: [Number],
  })
  point: {
    type: string;
    coordinates: number[];
  };

  @Prop({ type: Object })
  data: Record<string, any>;

  @Prop({ type: Types.ObjectId, ref: 'City' })
  cityId: Types.ObjectId;
}

export const GeoEventSchema = SchemaFactory.createForClass(GeoEvent);
GeoEventSchema.index({ eventType: 1, createdAt: -1 });
GeoEventSchema.index({ entityType: 1, entityId: 1 });
GeoEventSchema.index({ point: '2dsphere' });

// ============ ETA CACHE ============
// Кэш расчётов ETA

@Schema({ collection: 'eta_cache', timestamps: true })
export class EtaCache extends Document {
  @Prop({ required: true })
  fromHash: string; // geohash of from point

  @Prop({ required: true })
  toHash: string; // geohash of to point

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: [Number],
  })
  fromPoint: {
    type: string;
    coordinates: number[];
  };

  @Prop({
    type: {
      type: String,
      enum: ['Point'],
    },
    coordinates: [Number],
  })
  toPoint: {
    type: string;
    coordinates: number[];
  };

  @Prop({ required: true })
  distanceMeters: number;

  @Prop({ required: true })
  durationSeconds: number;

  @Prop({ enum: ['approx', 'routing', 'historical'], default: 'approx' })
  source: string;

  @Prop()
  expiresAt: Date;
}

export const EtaCacheSchema = SchemaFactory.createForClass(EtaCache);
EtaCacheSchema.index({ fromHash: 1, toHash: 1 });
EtaCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
