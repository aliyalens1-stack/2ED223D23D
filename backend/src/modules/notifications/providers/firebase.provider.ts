import * as admin from 'firebase-admin';
import { PushProvider, PushPayload } from './push.provider.interface';

export class FirebaseProvider implements PushProvider {
  private messaging: admin.messaging.Messaging | null = null;
  private initialized = false;

  constructor() {
    this.init();
  }

  private init() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !privateKey) {
      console.warn('[Firebase] Missing credentials — push delivery disabled. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY in .env');
      return;
    }

    try {
      if (!admin.apps.length) {
        admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, '\n'),
          }),
        });
      }
      this.messaging = admin.messaging();
      this.initialized = true;
      console.log('[Firebase] Initialized successfully');
    } catch (err) {
      console.error('[Firebase] Init failed:', err);
    }
  }

  async send(token: string, payload: PushPayload): Promise<boolean> {
    if (!this.initialized || !this.messaging) {
      console.log(`[Push] Would send to token ${token.slice(0, 20)}...: ${payload.title}`);
      return false;
    }

    try {
      await this.messaging.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
      });
      return true;
    } catch (err: any) {
      console.error(`[Push] Send failed:`, err.message);
      return false;
    }
  }

  async sendBulk(tokens: string[], payload: PushPayload): Promise<{ success: number; failure: number }> {
    if (!this.initialized || !this.messaging) {
      console.log(`[Push] Would send bulk to ${tokens.length} devices: ${payload.title}`);
      return { success: 0, failure: tokens.length };
    }

    try {
      const res = await this.messaging.sendEachForMulticast({
        tokens,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
      });
      return { success: res.successCount, failure: res.failureCount };
    } catch (err: any) {
      console.error(`[Push] Bulk send failed:`, err.message);
      return { success: 0, failure: tokens.length };
    }
  }
}
