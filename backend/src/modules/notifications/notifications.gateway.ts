// WebSocket Gateway for realtime notifications
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

@WebSocketGateway({
  cors: {
    origin: '*',
    credentials: true,
  },
  namespace: '/notifications',
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationsGateway.name);
  
  // Map userId -> Set<socketId> (один пользователь может иметь несколько соединений)
  private userSockets: Map<string, Set<string>> = new Map();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    
    // Удаляем socket из всех user rooms
    this.userSockets.forEach((sockets, userId) => {
      if (sockets.has(client.id)) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    });
  }

  /**
   * Клиент присоединяется к своей комнате по userId
   */
  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() userId: string,
  ) {
    if (!userId) {
      return { success: false, error: 'userId required' };
    }

    // Присоединяем к комнате
    client.join(userId);
    
    // Сохраняем маппинг
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(client.id);

    this.logger.log(`User ${userId} joined with socket ${client.id}`);
    
    return { success: true, message: `Joined room ${userId}` };
  }

  /**
   * Клиент покидает комнату
   */
  @SubscribeMessage('leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() userId: string,
  ) {
    client.leave(userId);
    
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(client.id);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }

    this.logger.log(`User ${userId} left with socket ${client.id}`);
    
    return { success: true };
  }

  /**
   * Отправить уведомление конкретному пользователю
   */
  notifyUser(userId: string, notification: any): void {
    this.server.to(userId).emit('notification', notification);
    this.logger.debug(`Notification sent to user ${userId}: ${notification.type}`);
  }

  /**
   * Отправить уведомление нескольким пользователям
   */
  notifyUsers(userIds: string[], notification: any): void {
    for (const userId of userIds) {
      this.notifyUser(userId, notification);
    }
  }

  /**
   * Broadcast всем подключенным клиентам
   */
  broadcast(event: string, data: any): void {
    this.server.emit(event, data);
  }

  /**
   * Проверить, подключен ли пользователь
   */
  isUserOnline(userId: string): boolean {
    const sockets = this.userSockets.get(userId);
    return sockets !== undefined && sockets.size > 0;
  }

  /**
   * Получить количество онлайн пользователей
   */
  getOnlineUsersCount(): number {
    return this.userSockets.size;
  }
}
