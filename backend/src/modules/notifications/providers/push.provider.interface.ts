export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushProvider {
  send(token: string, payload: PushPayload): Promise<boolean>;
  sendBulk(tokens: string[], payload: PushPayload): Promise<{ success: number; failure: number }>;
}
