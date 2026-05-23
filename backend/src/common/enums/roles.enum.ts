export enum UserRole {
  CUSTOMER = 'customer',
  PROVIDER = 'provider',
  ADMIN = 'admin',
}

export enum UserStatus {
  ACTIVE = 'active',
  BLOCKED = 'blocked',
  PENDING = 'pending',
}

export enum ProviderType {
  STO = 'sto',
  PRIVATE_MASTER = 'private_master',
  GARAGE = 'garage',
  DETAILING = 'detailing',
  TOWING = 'towing',
  TIRE_SERVICE = 'tire_service',
  OTHER = 'other',
}

export enum LocationType {
  MAIN = 'main',
  BRANCH = 'branch',
  MOBILE = 'mobile',
}
