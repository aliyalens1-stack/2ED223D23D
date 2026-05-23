import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { UserRole } from '../shared/enums';
import { GeoStatus } from '../shared/enums';

const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || 'auto_platform';

async function seed() {
  await mongoose.connect(MONGO_URL, { dbName: DB_NAME });
  console.log('Connected to MongoDB for seeding');

  const db = mongoose.connection.db;

  // 1. Admin user
  const usersCol = db.collection('users');
  const existingAdmin = await usersCol.findOne({ email: process.env.ADMIN_EMAIL || 'admin@autoservice.com' });
  if (!existingAdmin) {
    const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin123!', 10);
    await usersCol.insertOne({
      email: process.env.ADMIN_EMAIL || 'admin@autoservice.com',
      passwordHash,
      role: UserRole.ADMIN,
      firstName: 'Admin',
      lastName: 'System',
      phone: '',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('Admin user created');
  } else {
    console.log('Admin user already exists');
  }

  // 2. Test customer
  const existingCustomer = await usersCol.findOne({ email: 'customer@test.com' });
  if (!existingCustomer) {
    const passwordHash = await bcrypt.hash('Customer123!', 10);
    await usersCol.insertOne({
      email: 'customer@test.com',
      passwordHash,
      role: UserRole.CUSTOMER,
      firstName: 'Test',
      lastName: 'Customer',
      phone: '+79001234567',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('Test customer created');
  }

  // 3. Test provider owner
  let providerId;
  const existingProvider = await usersCol.findOne({ email: 'provider@test.com' });
  if (!existingProvider) {
    const passwordHash = await bcrypt.hash('Provider123!', 10);
    const providerRes = await usersCol.insertOne({
      email: 'provider@test.com',
      passwordHash,
      role: UserRole.PROVIDER_OWNER,
      firstName: 'Test',
      lastName: 'Provider',
      phone: '+79009876543',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    providerId = providerRes.insertedId;
    console.log('Test provider created');
  } else {
    providerId = existingProvider._id;
  }

  // 3.1 Create Organization for Provider
  const organizationsCol = db.collection('organizations');
  let testOrg = await organizationsCol.findOne({ name: 'Автосервис Тест' });
  if (!testOrg && providerId) {
    const orgRes = await organizationsCol.insertOne({
      name: 'Автосервис Тест',
      slug: 'autoservice-test',
      description: 'Тестовый автосервис для демонстрации',
      ownerId: providerId,
      status: 'active',
      isVerified: true,
      rating: 4.5,
      reviewsCount: 10,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    testOrg = { _id: orgRes.insertedId };
    console.log('Test organization created');

    // Create membership
    await db.collection('organizationmemberships').insertOne({
      userId: providerId,
      organizationId: orgRes.insertedId,
      role: 'owner',
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('Provider membership created');
  }

  // 4. Geo: Russia
  const countriesCol = db.collection('countries');
  let country = await countriesCol.findOne({ code: 'RU' });
  if (!country) {
    const res = await countriesCol.insertOne({
      code: 'RU',
      name: 'Russia',
      nameLocal: 'Россия',
      currency: 'RUB',
      timezone: 'Europe/Moscow',
      phoneCode: '+7',
      status: GeoStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    country = { _id: res.insertedId, code: 'RU' };
    console.log('Country RU created');
  }

  const regionsCol = db.collection('regions');
  const citiesCol = db.collection('cities');

  const regionsData = [
    {
      code: 'MSK',
      name: 'Moscow Oblast',
      nameLocal: 'Московская область',
      cities: [
        { name: 'Moscow', nameLocal: 'Москва', slug: 'moscow', lat: 55.7558, lng: 37.6173, population: 12600000 },
        { name: 'Zelenograd', nameLocal: 'Зеленоград', slug: 'zelenograd', lat: 55.9825, lng: 37.1814, population: 250000 },
      ],
    },
    {
      code: 'SPB',
      name: 'Saint Petersburg',
      nameLocal: 'Санкт-Петербург',
      cities: [
        { name: 'Saint Petersburg', nameLocal: 'Санкт-Петербург', slug: 'saint-petersburg', lat: 59.9343, lng: 30.3351, population: 5400000 },
      ],
    },
    {
      code: 'NSK',
      name: 'Novosibirsk Oblast',
      nameLocal: 'Новосибирская область',
      cities: [
        { name: 'Novosibirsk', nameLocal: 'Новосибирск', slug: 'novosibirsk', lat: 55.0084, lng: 82.9357, population: 1600000 },
      ],
    },
    {
      code: 'KRD',
      name: 'Krasnodar Krai',
      nameLocal: 'Краснодарский край',
      cities: [
        { name: 'Krasnodar', nameLocal: 'Краснодар', slug: 'krasnodar', lat: 45.0355, lng: 38.9753, population: 1000000 },
        { name: 'Sochi', nameLocal: 'Сочи', slug: 'sochi', lat: 43.5854, lng: 39.7231, population: 450000 },
      ],
    },
    {
      code: 'SVE',
      name: 'Sverdlovsk Oblast',
      nameLocal: 'Свердловская область',
      cities: [
        { name: 'Yekaterinburg', nameLocal: 'Екатеринбург', slug: 'yekaterinburg', lat: 56.8389, lng: 60.6057, population: 1500000 },
      ],
    },
    {
      code: 'TAT',
      name: 'Republic of Tatarstan',
      nameLocal: 'Республика Татарстан',
      cities: [
        { name: 'Kazan', nameLocal: 'Казань', slug: 'kazan', lat: 55.7887, lng: 49.1221, population: 1260000 },
      ],
    },
  ];

  for (const regionData of regionsData) {
    let region = await regionsCol.findOne({ code: regionData.code, countryId: country._id });
    if (!region) {
      const res = await regionsCol.insertOne({
        countryId: country._id,
        code: regionData.code,
        name: regionData.name,
        nameLocal: regionData.nameLocal,
        status: GeoStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      region = { _id: res.insertedId };
      console.log(`Region ${regionData.code} created`);
    }

    for (const cityData of regionData.cities) {
      const existing = await citiesCol.findOne({ slug: cityData.slug });
      if (!existing) {
        await citiesCol.insertOne({
          regionId: region._id,
          name: cityData.name,
          nameLocal: cityData.nameLocal,
          slug: cityData.slug,
          lat: cityData.lat,
          lng: cityData.lng,
          population: cityData.population,
          timezone: 'Europe/Moscow',
          status: GeoStatus.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`City ${cityData.name} created`);
      }
    }
  }

  // 5. Service categories + services
  const categoriesCol = db.collection('servicecategories');
  const servicesCol = db.collection('services');

  const categoriesData = [
    {
      name: 'Engine',
      nameLocal: 'Двигатель',
      slug: 'engine',
      sortOrder: 1,
      services: [
        { name: 'Oil Change', slug: 'oil-change', durationMin: 30, durationMax: 60, priceMin: 1500, priceMax: 5000 },
        { name: 'Engine Diagnostics', slug: 'engine-diagnostics', durationMin: 60, durationMax: 120, priceMin: 2000, priceMax: 8000, requiresDiagnostics: true },
        { name: 'Timing Belt Replacement', slug: 'timing-belt', durationMin: 120, durationMax: 480, priceMin: 5000, priceMax: 25000 },
      ],
    },
    {
      name: 'Brakes',
      nameLocal: 'Тормоза',
      slug: 'brakes',
      sortOrder: 2,
      services: [
        { name: 'Brake Pad Replacement', slug: 'brake-pads', durationMin: 30, durationMax: 90, priceMin: 2000, priceMax: 8000 },
        { name: 'Brake Disc Replacement', slug: 'brake-discs', durationMin: 60, durationMax: 180, priceMin: 4000, priceMax: 15000 },
        { name: 'Brake Fluid Change', slug: 'brake-fluid', durationMin: 30, durationMax: 60, priceMin: 1000, priceMax: 3000 },
      ],
    },
    {
      name: 'Suspension',
      nameLocal: 'Подвеска',
      slug: 'suspension',
      sortOrder: 3,
      services: [
        { name: 'Shock Absorber Replacement', slug: 'shock-absorbers', durationMin: 60, durationMax: 180, priceMin: 3000, priceMax: 12000 },
        { name: 'Wheel Alignment', slug: 'wheel-alignment', durationMin: 30, durationMax: 60, priceMin: 1500, priceMax: 4000 },
        { name: 'Ball Joint Replacement', slug: 'ball-joints', durationMin: 60, durationMax: 120, priceMin: 2000, priceMax: 8000 },
      ],
    },
    {
      name: 'Electrical',
      nameLocal: 'Электрика',
      slug: 'electrical',
      sortOrder: 4,
      services: [
        { name: 'Battery Replacement', slug: 'battery-replacement', durationMin: 15, durationMax: 30, priceMin: 500, priceMax: 2000 },
        { name: 'Starter Repair', slug: 'starter-repair', durationMin: 60, durationMax: 180, priceMin: 3000, priceMax: 10000 },
        { name: 'Electrical Diagnostics', slug: 'electrical-diagnostics', durationMin: 60, durationMax: 120, priceMin: 2000, priceMax: 5000, requiresDiagnostics: true },
      ],
    },
    {
      name: 'Transmission',
      nameLocal: 'Трансмиссия',
      slug: 'transmission',
      sortOrder: 5,
      services: [
        { name: 'Transmission Fluid Change', slug: 'transmission-fluid', durationMin: 30, durationMax: 60, priceMin: 2000, priceMax: 6000 },
        { name: 'Clutch Replacement', slug: 'clutch-replacement', durationMin: 180, durationMax: 480, priceMin: 8000, priceMax: 30000 },
      ],
    },
    {
      name: 'Body & Paint',
      nameLocal: 'Кузов и покраска',
      slug: 'body-paint',
      sortOrder: 6,
      services: [
        { name: 'Dent Repair', slug: 'dent-repair', durationMin: 60, durationMax: 480, priceMin: 3000, priceMax: 20000 },
        { name: 'Full Body Paint', slug: 'full-paint', durationMin: 1440, durationMax: 4320, priceMin: 50000, priceMax: 200000 },
      ],
    },
    {
      name: 'Maintenance',
      nameLocal: 'ТО',
      slug: 'maintenance',
      sortOrder: 7,
      services: [
        { name: 'Regular Service (TO)', slug: 'regular-service', durationMin: 60, durationMax: 180, priceMin: 3000, priceMax: 15000 },
        { name: 'AC Service', slug: 'ac-service', durationMin: 30, durationMax: 90, priceMin: 2000, priceMax: 5000 },
        { name: 'Tire Change (Seasonal)', slug: 'tire-change', durationMin: 30, durationMax: 60, priceMin: 1500, priceMax: 3000 },
      ],
    },
  ];

  for (const cat of categoriesData) {
    let category = await categoriesCol.findOne({ slug: cat.slug });
    if (!category) {
      const res = await categoriesCol.insertOne({
        parentId: null,
        name: cat.name,
        slug: cat.slug,
        description: cat.nameLocal,
        icon: '',
        sortOrder: cat.sortOrder,
        status: GeoStatus.ACTIVE,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      category = { _id: res.insertedId };
      console.log(`Category ${cat.name} created`);
    }

    for (const svc of cat.services) {
      const existing = await servicesCol.findOne({ slug: svc.slug });
      if (!existing) {
        await servicesCol.insertOne({
          categoryId: category._id,
          name: svc.name,
          slug: svc.slug,
          description: '',
          durationMin: svc.durationMin,
          durationMax: svc.durationMax,
          priceMin: svc.priceMin,
          priceMax: svc.priceMax,
          requiresDiagnostics: svc.requiresDiagnostics || false,
          popularityScore: 0,
          status: GeoStatus.ACTIVE,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        console.log(`Service ${svc.name} created`);
      }
    }
  }

  // 6. Create test branch for test organization
  const moscowCity = await citiesCol.findOne({ slug: 'moscow' });
  const testBranch = await createTestBranch(db, testOrg, moscowCity);

  // 7. Create ProviderAvailability for test branch (Mon-Sat)
  if (testBranch) {
    await createProviderAvailability(db, testOrg, testBranch);
  }

  // 8. Create ProviderServices for test branch
  if (testBranch && testOrg) {
    await createProviderServices(db, testOrg, testBranch, servicesCol);
  }

  // 9. Create test quote with response for customer flow testing
  if (testBranch && testOrg && providerId) {
    const customer = await usersCol.findOne({ email: 'customer@test.com' });
    if (customer) {
      await createTestQuoteWithResponse(db, customer, testOrg, testBranch, servicesCol);
      // 10. Create geo requests for map display
      await createTestGeoRequests(db, customer, servicesCol);
    }
  }

  console.log('Seed complete!');
  await mongoose.disconnect();
}

// Helper function to create branch for test organization
async function createTestBranch(db, testOrg, moscowCity) {
  if (!testOrg || !moscowCity) return null;
  
  const branchesCol = db.collection('branches');
  let existingBranch = await branchesCol.findOne({ organizationId: testOrg._id });
  
  if (!existingBranch) {
    const res = await branchesCol.insertOne({
      organizationId: testOrg._id,
      name: 'Центральный филиал',
      address: 'г. Москва, ул. Тестовая, д. 1',
      cityId: moscowCity._id,
      location: {
        type: 'Point',
        coordinates: [37.6173, 55.7558],
      },
      phone: '+79001234567',
      email: 'test@autoservice.com',
      workingHours: {
        monday: { open: '09:00', close: '21:00' },
        tuesday: { open: '09:00', close: '21:00' },
        wednesday: { open: '09:00', close: '21:00' },
        thursday: { open: '09:00', close: '21:00' },
        friday: { open: '09:00', close: '21:00' },
        saturday: { open: '10:00', close: '18:00' },
        sunday: { open: null, close: null },
      },
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    console.log('Test branch created');
    return { _id: res.insertedId };
  }
  return existingBranch;
}

// Create provider availability (Mon-Sat working hours)
async function createProviderAvailability(db, testOrg, testBranch) {
  const availCol = db.collection('provideravailabilities');
  const existing = await availCol.findOne({ branchId: testBranch._id });
  if (existing) {
    console.log('Provider availability already exists');
    return;
  }

  // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  const schedule = [
    { weekday: 0, startTime: '00:00', endTime: '00:00', isWorkingDay: false },
    { weekday: 1, startTime: '09:00', endTime: '21:00', isWorkingDay: true },
    { weekday: 2, startTime: '09:00', endTime: '21:00', isWorkingDay: true },
    { weekday: 3, startTime: '09:00', endTime: '21:00', isWorkingDay: true },
    { weekday: 4, startTime: '09:00', endTime: '21:00', isWorkingDay: true },
    { weekday: 5, startTime: '09:00', endTime: '21:00', isWorkingDay: true },
    { weekday: 6, startTime: '10:00', endTime: '18:00', isWorkingDay: true },
  ];

  for (const item of schedule) {
    await availCol.insertOne({
      organizationId: testOrg._id,
      branchId: testBranch._id,
      weekday: item.weekday,
      startTime: item.startTime,
      endTime: item.endTime,
      isWorkingDay: item.isWorkingDay,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  console.log('Provider availability created (Mon-Sat)');
}

// Create provider services linking branch to platform services
async function createProviderServices(db, testOrg, testBranch, servicesCol) {
  const psCol = db.collection('providerservices');
  const existing = await psCol.findOne({ branchId: testBranch._id });
  if (existing) {
    console.log('Provider services already exist');
    return;
  }

  const services = await servicesCol.find({}).toArray();
  for (const svc of services) {
    const price = svc.priceMin + Math.round((svc.priceMax - svc.priceMin) / 2);
    await psCol.insertOne({
      organizationId: testOrg._id,
      branchId: testBranch._id,
      serviceId: svc._id,
      price,
      priceFrom: svc.priceMin,
      priceTo: svc.priceMax,
      duration: svc.durationMin || 60,
      warrantyDays: 30,
      description: svc.name,
      brandsSupported: [],
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  console.log(`Provider services created (${services.length} services)`);
}

// Create a test quote with a response for testing the full flow
async function createTestQuoteWithResponse(db, customer, testOrg, testBranch, servicesCol) {
  const quotesCol = db.collection('quotes');
  const responsesCol = db.collection('quoteresponses');
  const psCol = db.collection('providerservices');

  const existingQuote = await quotesCol.findOne({ userId: customer._id, status: 'responded' });
  if (existingQuote) {
    console.log('Test quote with response already exists');
    return;
  }

  // Get an oil change service
  const oilChange = await servicesCol.findOne({ slug: 'oil-change' });
  if (!oilChange) return;

  // Get the provider service
  const ps = await psCol.findOne({ branchId: testBranch._id, serviceId: oilChange._id });
  if (!ps) return;

  // Create quote
  const quoteRes = await quotesCol.insertOne({
    userId: customer._id,
    vehicleId: null,
    requestedServiceId: oilChange._id,
    description: 'Нужна замена масла в двигателе',
    city: null,
    status: 'responded',
    responsesCount: 1,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Create response from the test organization
  await responsesCol.insertOne({
    quoteId: quoteRes.insertedId,
    providerId: testOrg._id,
    branchId: testBranch._id,
    providerServiceId: ps._id,
    price: ps.price,
    message: 'Готовы выполнить замену масла. Используем качественные масла и фильтры.',
    isSelected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  console.log('Test quote with response created');
}

// Create test requests with geo locations for map display
async function createTestGeoRequests(db, customer, servicesCol) {
  const quotesCol = db.collection('quotes');

  // Check if geo requests already exist
  const existingGeoRequests = await quotesCol.findOne({ 'location.coordinates': { $exists: true } });
  if (existingGeoRequests) {
    console.log('Geo requests already exist');
    return;
  }

  // Get various services
  const services = await servicesCol.find({}).limit(5).toArray();
  if (services.length === 0) return;

  // Moscow area coordinates with different urgencies and statuses
  const testRequests = [
    {
      lat: 55.7558,
      lng: 37.6173,
      description: 'Не заводится машина, нужна диагностика',
      urgency: 'critical',
      status: 'pending',
      city: 'Москва',
    },
    {
      lat: 55.7400,
      lng: 37.6000,
      description: 'Скрип при торможении',
      urgency: 'high',
      status: 'pending',
      city: 'Москва',
    },
    {
      lat: 55.7700,
      lng: 37.5800,
      description: 'Плановое ТО',
      urgency: 'normal',
      status: 'in_review',
      city: 'Москва',
    },
    {
      lat: 55.7300,
      lng: 37.6500,
      description: 'Замена масла',
      urgency: 'low',
      status: 'responded',
      city: 'Москва',
    },
    {
      lat: 55.7600,
      lng: 37.5500,
      description: 'Проблема с кондиционером',
      urgency: 'normal',
      status: 'pending',
      city: 'Москва',
    },
    {
      lat: 55.7200,
      lng: 37.6800,
      description: 'Стук в подвеске',
      urgency: 'high',
      status: 'pending',
      city: 'Москва',
    },
  ];

  for (const req of testRequests) {
    const service = services[Math.floor(Math.random() * services.length)];
    
    await quotesCol.insertOne({
      userId: customer._id,
      vehicleId: null,
      requestedServiceId: service._id,
      description: req.description,
      city: req.city,
      status: req.status,
      responsesCount: req.status === 'responded' ? 1 : 0,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      // GEO LOCATION
      location: {
        type: 'Point',
        coordinates: [req.lng, req.lat], // [longitude, latitude] - MongoDB format
      },
      locationSource: 'gps',
      urgency: req.urgency,
      source: 'quick',
      createdAt: new Date(Date.now() - Math.random() * 3600000), // Random time in last hour
      updatedAt: new Date(),
    });
  }

  console.log(`Created ${testRequests.length} test geo requests for map`);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
