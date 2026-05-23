import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';

const MONGO_URL = process.env.MONGO_URL;
const DB_NAME = process.env.DB_NAME || 'auto_platform';

/**
 * Seed V5 data: geo coordinates + visibility + matching data for providers
 */
async function seedV5Data() {
  await mongoose.connect(MONGO_URL, { dbName: DB_NAME });
  console.log('Connected to MongoDB for V5 seeding');

  const db = mongoose.connection.db;
  const orgsCol = db.collection('organizations');
  const branchesCol = db.collection('branches');

  // 🔥 Test providers with geo (Kyiv area)
  // Different location sources: 'self', 'admin', 'auto'
  const testProviders = [
    {
      name: 'BMW Garage',
      slug: 'bmw-garage-kyiv',
      description: 'Специализированный сервис BMW',
      lat: 50.4501,
      lng: 30.5234,
      address: 'ул. Крещатик 15, Киев',
      isVerified: true,
      isPopular: true,
      isMobile: false,
      ratingAvg: 4.8,
      reviewsCount: 128,
      bookingsCount: 156,
      completedBookingsCount: 142,
      avgResponseTimeMinutes: 8,
      visibilityScore: 87,
      visibilityState: 'BOOSTED',
      specializations: ['BMW', 'Audi', 'Mercedes'],
      locationSource: 'self', // Мастер сам указал
      isLocationVerified: true, // Админ проверил
    },
    {
      name: 'Автоэлектрик Pro',
      slug: 'autoelectric-pro',
      description: 'Диагностика и ремонт электрики любых авто',
      lat: 50.4612,
      lng: 30.5109,
      address: 'ул. Сагайдачного 25',
      isVerified: true,
      isPopular: false,
      isMobile: true,
      ratingAvg: 4.6,
      reviewsCount: 54,
      bookingsCount: 72,
      completedBookingsCount: 68,
      avgResponseTimeMinutes: 12,
      visibilityScore: 74,
      visibilityState: 'NORMAL',
      specializations: ['Электрика', 'Диагностика'],
      locationSource: 'admin', // Добавлен админом
      isLocationVerified: true,
    },
    {
      name: 'СТО Мотор+',
      slug: 'sto-motor-plus',
      description: 'Полный спектр услуг по ремонту авто',
      lat: 50.4398,
      lng: 30.5342,
      address: '',
      isVerified: false,
      isPopular: false,
      isMobile: false,
      ratingAvg: 4.2,
      reviewsCount: 23,
      bookingsCount: 45,
      completedBookingsCount: 38,
      avgResponseTimeMinutes: 25,
      visibilityScore: 52,
      visibilityState: 'NORMAL',
      specializations: ['Двигатель', 'Подвеска'],
      locationSource: 'auto', // Автоматически найден
      isLocationVerified: false, // Не проверен
    },
    {
      name: 'Шиномонтаж Express',
      slug: 'tire-express',
      description: 'Быстрый шиномонтаж и балансировка',
      lat: 50.4555,
      lng: 30.5432,
      address: 'пр. Победы 67',
      isVerified: true,
      isPopular: true,
      isMobile: true,
      ratingAvg: 4.9,
      reviewsCount: 89,
      bookingsCount: 234,
      completedBookingsCount: 228,
      avgResponseTimeMinutes: 5,
      visibilityScore: 92,
      visibilityState: 'BOOSTED',
      specializations: ['Шиномонтаж', 'Балансировка'],
      locationSource: 'self',
      isLocationVerified: true,
    },
    {
      name: 'Детейлинг Studio',
      slug: 'detailing-studio',
      description: 'Премиум детейлинг и уход за авто',
      lat: 50.4489,
      lng: 30.5156,
      address: 'ул. Владимирская 101',
      isVerified: true,
      isPopular: false,
      isMobile: false,
      ratingAvg: 4.7,
      reviewsCount: 45,
      bookingsCount: 67,
      completedBookingsCount: 62,
      avgResponseTimeMinutes: 15,
      visibilityScore: 68,
      visibilityState: 'NORMAL',
      specializations: ['Детейлинг', 'Полировка'],
      locationSource: 'self',
      isLocationVerified: false, // Ожидает проверки
    },
    {
      name: 'VAG Specialist',
      slug: 'vag-specialist',
      description: 'Сервис для VW, Audi, Skoda, Seat',
      lat: 50.4678,
      lng: 30.4987,
      address: 'ул. Борщаговская 200',
      isVerified: true,
      isPopular: false,
      isMobile: false,
      ratingAvg: 4.5,
      reviewsCount: 67,
      bookingsCount: 89,
      completedBookingsCount: 81,
      avgResponseTimeMinutes: 18,
      visibilityScore: 65,
      visibilityState: 'NORMAL',
      specializations: ['VW', 'Audi', 'Skoda'],
      locationSource: 'admin',
      isLocationVerified: true,
    },
    {
      name: 'Mobile Service 24',
      slug: 'mobile-service-24',
      description: 'Выезд к вам 24/7',
      lat: 50.4534,
      lng: 30.5289,
      address: '',
      isVerified: false,
      isPopular: false,
      isMobile: true,
      ratingAvg: 4.3,
      reviewsCount: 34,
      bookingsCount: 56,
      completedBookingsCount: 48,
      avgResponseTimeMinutes: 10,
      visibilityScore: 58,
      visibilityState: 'NORMAL',
      specializations: ['Выезд', 'Аккумуляторы'],
      locationSource: 'auto',
      isLocationVerified: false,
    },
  ];

  console.log('Creating test providers with geo data...');

  for (const providerData of testProviders) {
    const existingOrg = await orgsCol.findOne({ slug: providerData.slug });
    if (existingOrg) {
      // Update with V5 fields
      await orgsCol.updateOne(
        { _id: existingOrg._id },
        {
          $set: {
            location: {
              type: 'Point',
              coordinates: [providerData.lng, providerData.lat],
            },
            lat: providerData.lat,
            lng: providerData.lng,
            address: providerData.address || '',
            isVerified: providerData.isVerified,
            isPopular: providerData.isPopular,
            isMobile: providerData.isMobile,
            ratingAvg: providerData.ratingAvg,
            reviewsCount: providerData.reviewsCount,
            bookingsCount: providerData.bookingsCount,
            completedBookingsCount: providerData.completedBookingsCount,
            avgResponseTimeMinutes: providerData.avgResponseTimeMinutes,
            visibilityScore: providerData.visibilityScore,
            visibilityState: providerData.visibilityState,
            specializations: providerData.specializations,
            hasAvailableSlotsToday: true,
            // Location source
            locationSource: providerData.locationSource || 'auto',
            isLocationVerified: providerData.isLocationVerified || false,
            locationUpdatedAt: new Date(),
            // V5 fields
            suspiciousScore: 0,
            isShadowBanned: false,
            isShadowLimited: false,
            providerType: providerData.completedBookingsCount > 50 ? 'established' : 
                          providerData.completedBookingsCount > 5 ? 'active' : 'new',
            repeatBookingRate: 0.25 + Math.random() * 0.3,
            totalPlatformFeesPaid: Math.round(providerData.completedBookingsCount * 150),
            updatedAt: new Date(),
          },
        }
      );
      console.log(`Updated: ${providerData.name}`);
    } else {
      // Create new
      const res = await orgsCol.insertOne({
        ...providerData,
        ownerId: null,
        status: 'active',
        location: {
          type: 'Point',
          coordinates: [providerData.lng, providerData.lat],
        },
        hasAvailableSlotsToday: true,
        // V5 fields
        suspiciousScore: 0,
        isShadowBanned: false,
        isShadowLimited: false,
        providerType: providerData.completedBookingsCount > 50 ? 'established' : 
                      providerData.completedBookingsCount > 5 ? 'active' : 'new',
        repeatBookingRate: 0.25 + Math.random() * 0.3,
        totalPlatformFeesPaid: Math.round(providerData.completedBookingsCount * 150),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create branch with location
      await branchesCol.insertOne({
        organizationId: res.insertedId,
        name: providerData.name,
        slug: providerData.slug + '-main',
        isMain: true,
        address: 'Київ, Україна',
        lat: providerData.lat,
        lng: providerData.lng,
        location: {
          type: 'Point',
          coordinates: [providerData.lng, providerData.lat],
        },
        phone: '+380501234567',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      console.log(`Created: ${providerData.name}`);
    }
  }

  // Create 2dsphere index for geo queries
  try {
    await orgsCol.createIndex({ location: '2dsphere' });
    await branchesCol.createIndex({ location: '2dsphere' });
    console.log('Geo indexes created');
  } catch (e) {
    console.log('Geo indexes already exist');
  }

  // Update existing organizations without location
  const orgsWithoutLocation = await orgsCol.find({ location: { $exists: false } }).toArray();
  for (const org of orgsWithoutLocation) {
    await orgsCol.updateOne(
      { _id: org._id },
      {
        $set: {
          location: {
            type: 'Point',
            coordinates: [30.5234 + (Math.random() - 0.5) * 0.1, 50.4501 + (Math.random() - 0.5) * 0.1],
          },
          visibilityScore: 50 + Math.floor(Math.random() * 30),
          visibilityState: 'NORMAL',
          hasAvailableSlotsToday: Math.random() > 0.3,
        },
      }
    );
  }
  console.log(`Updated ${orgsWithoutLocation.length} organizations with location data`);

  await mongoose.disconnect();
  console.log('V5 seed complete!');
}

seedV5Data().catch(console.error);
