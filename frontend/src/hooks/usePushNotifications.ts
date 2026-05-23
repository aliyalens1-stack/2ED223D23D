import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { useRouter } from 'expo-router';
import { api } from '../services/api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function usePushNotifications() {
  const router = useRouter();
  const notificationListener = useRef<Notifications.Subscription>();
  const responseListener = useRef<Notifications.Subscription>();

  useEffect(() => {
    registerForPush();

    notificationListener.current = Notifications.addNotificationReceivedListener((notification) => {
      console.log('[Push] Received:', notification.request.content.title);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      handleDeepLink(data);
    });

    return () => {
      if (notificationListener.current) Notifications.removeNotificationSubscription(notificationListener.current);
      if (responseListener.current) Notifications.removeNotificationSubscription(responseListener.current);
    };
  }, []);

  const handleDeepLink = (data: any) => {
    if (!data?.type) return;

    switch (data.type) {
      case 'BOOKING_CONFIRMED':
      case 'BOOKING_STARTED':
      case 'BOOKING_COMPLETED':
      case 'PAYMENT_SUCCESS':
      case 'BOOKING_CANCELLED':
        if (data.bookingId) {
          router.push(`/booking/${data.bookingId}`);
        }
        break;
      case 'QUOTE_RESPONDED':
      case 'QUOTE_CREATED':
        if (data.quoteId) {
          router.push(`/quote/${data.quoteId}`);
        }
        break;
      default:
        break;
    }
  };

  const registerForPush = async () => {
    if (!Device.isDevice) {
      console.log('[Push] Must use physical device for push');
      return;
    }

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        console.log('[Push] Permission not granted');
        return;
      }

      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: undefined,
      });
      const token = tokenData.data;
      console.log('[Push] Token:', token);

      await api.post('/devices/register', {
        deviceToken: token,
        platform: Platform.OS,
      });
      console.log('[Push] Device registered');
    } catch (error) {
      console.log('[Push] Registration error:', error);
    }

    if (Platform.OS === 'android') {
      Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
  };

  return { registerForPush };
}
