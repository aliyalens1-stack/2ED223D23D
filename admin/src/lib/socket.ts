/**
 * Sprint 4 — Realtime socket client
 *
 * • Connects to NestJS socket.io gateway via FastAPI proxy (`/api/socket.io/realtime/`).
 * • Uses polling transport only (WS upgrade is not supported through current /api proxy).
 * • Auto-reconnect; exposes status + `on/off/emit` helpers.
 * • Sends JWT from localStorage in handshake auth → server places client in admin/providers room.
 *
 * Event routing (see realtime.controller.ts):
 *   zone:*        → global      (everyone)
 *   booking:*     → global      (filter by bookingId client-side)
 *   provider:*    → admin+providers
 *   orchestrator:*, alert:*, governance:* → admin only
 */

import { io, Socket } from 'socket.io-client';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

class RealtimeClient {
  private socket: Socket | null = null;
  private status: RealtimeStatus = 'disconnected';
  private statusListeners = new Set<(s: RealtimeStatus) => void>();

  connect(tokenKey = 'admin_token') {
    if (this.socket?.connected) return this.socket;
    const token = typeof window !== 'undefined' ? (localStorage.getItem(tokenKey) || localStorage.getItem('token') || '') : '';

    this.setStatus('connecting');

    this.socket = io('/realtime', {
      path: '/api/socket.io/',
      transports: ['polling'],           // polling flows through /api proxy; WS upgrade not supported here
      upgrade: false,
      auth: token ? { token } : undefined,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 20000,
    });

    this.socket.on('connect',    () => this.setStatus('connected'));
    this.socket.on('disconnect', () => this.setStatus('disconnected'));
    this.socket.on('connect_error', () => this.setStatus('error'));
    this.socket.on('connected', (meta) => {
      // eslint-disable-next-line no-console
      console.info('[realtime] auth ok', meta);
    });

    return this.socket;
  }

  disconnect() {
    this.socket?.disconnect();
    this.socket = null;
    this.setStatus('disconnected');
  }

  on<T = any>(event: string, handler: (data: T) => void) {
    this.connect();
    this.socket?.on(event, handler);
    return () => this.socket?.off(event, handler);
  }

  off(event: string, handler?: (data: any) => void) {
    this.socket?.off(event, handler);
  }

  emit(event: string, payload: any) {
    this.connect();
    this.socket?.emit(event, payload);
  }

  joinRoom(room: string) {
    this.emit('join', { room });
  }

  leaveRoom(room: string) {
    this.emit('leave', { room });
  }

  onStatusChange(cb: (s: RealtimeStatus) => void) {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  getStatus(): RealtimeStatus { return this.status; }

  private setStatus(s: RealtimeStatus) {
    this.status = s;
    this.statusListeners.forEach((cb) => cb(s));
  }
}

export const realtime = new RealtimeClient();
export default realtime;
