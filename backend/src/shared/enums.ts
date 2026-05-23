export enum UserRole {
  CUSTOMER = 'customer',
  PROVIDER_OWNER = 'provider_owner',
  PROVIDER_MANAGER = 'provider_manager',
  PROVIDER_STAFF = 'provider_staff',
  ADMIN = 'admin',
  SUPPORT = 'support',
}

export enum QuoteStatus {
  PENDING = 'pending',
  IN_REVIEW = 'in_review',
  RESPONDED = 'responded',
  ACCEPTED = 'accepted',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
}

export enum BookingStatus {
  DRAFT = 'draft',
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  ON_ROUTE = 'on_route',       // Мастер выехал
  ARRIVED = 'arrived',          // Мастер прибыл
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
  DISPUTED = 'disputed',        // Открыт спор
}

export enum OrganizationStatus {
  DRAFT = 'draft',
  PENDING_VERIFICATION = 'pending_verification',
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  BLOCKED = 'blocked',
}

export enum BranchStatus {
  ACTIVE = 'active',
  TEMPORARILY_CLOSED = 'temporarily_closed',
  PERMANENTLY_CLOSED = 'permanently_closed',
  PENDING_SETUP = 'pending_setup',
}

export enum VehicleStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
}

export enum GeoStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  REFUND_PENDING = 'refund_pending',
  REFUNDED = 'refunded',
}

export enum ReviewStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  PUBLISHED = 'published',
  REJECTED = 'rejected',
  HIDDEN = 'hidden',
}

export enum DisputeStatus {
  OPEN = 'open',
  UNDER_REVIEW = 'under_review',
  RESOLVED = 'resolved',
  CLOSED = 'closed',
}

export enum MembershipStatus {
  ACTIVE = 'active',
  INVITED = 'invited',
  SUSPENDED = 'suspended',
  REMOVED = 'removed',
}

export enum StaffRole {
  OWNER = 'owner',
  MANAGER = 'manager',
  RECEPTIONIST = 'receptionist',
  MECHANIC = 'mechanic',
  TECHNICIAN = 'technician',
}
