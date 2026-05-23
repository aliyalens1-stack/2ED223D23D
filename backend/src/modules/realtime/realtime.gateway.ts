import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

interface ConnectedClient {
  id: string;
  userId?: string;
  role?: string;
  rooms: Set<string>;
  connectedAt: Date;
}

@WebSocketGateway({
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/realtime',
  path: '/api/socket.io/',
  transports: ['websocket', 'polling'],
})
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private logger = new Logger('RealtimeGateway');
  private clients = new Map<string, ConnectedClient>();

  constructor(private jwtService: JwtService) {}

  afterInit(server: Server) {
    this.logger.log('🚀 WebSocket Gateway initialized');
  }

  async handleConnection(client: Socket) {
    try {
      // Try to authenticate from token
      const token = client.handshake.auth?.token || 
                   client.handshake.headers?.authorization?.replace('Bearer ', '');
      
      let userId: string | undefined;
      let role: string | undefined;

      if (token) {
        try {
          const payload = this.jwtService.verify(token, {
            secret: process.env.JWT_ACCESS_SECRET || 'auto_service_jwt_secret_key_2025_very_secure',
          });
          userId = payload.sub;
          role = payload.role;
        } catch (e) {
          // Token invalid, continue as anonymous
        }
      }

      const clientData: ConnectedClient = {
        id: client.id,
        userId,
        role,
        rooms: new Set(['global']),
        connectedAt: new Date(),
      };

      this.clients.set(client.id, clientData);

      // Join default room
      client.join('global');

      // Admin users join admin room
      if (role === 'admin' || role === 'support') {
        client.join('admin');
        clientData.rooms.add('admin');
      }

      // Provider users join provider room
      if (role === 'provider_owner' || role === 'provider_manager') {
        client.join('providers');
        clientData.rooms.add('providers');
      }

      this.logger.log(`Client connected: ${client.id} (user: ${userId || 'anonymous'}, role: ${role || 'none'})`);
      
      // Send connection confirmation
      client.emit('connected', {
        clientId: client.id,
        userId,
        role,
        rooms: Array.from(clientData.rooms),
        timestamp: new Date().toISOString(),
      });

    } catch (error) {
      this.logger.error(`Connection error: ${error.message}`);
    }
  }

  handleDisconnect(client: Socket) {
    this.clients.delete(client.id);
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  // ============ ROOM MANAGEMENT ============

  @SubscribeMessage('join')
  handleJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { room: string },
  ) {
    const clientData = this.clients.get(client.id);
    if (clientData) {
      client.join(data.room);
      clientData.rooms.add(data.room);
      this.logger.debug(`Client ${client.id} joined room: ${data.room}`);
    }
    return { success: true, room: data.room };
  }

  @SubscribeMessage('leave')
  handleLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { room: string },
  ) {
    const clientData = this.clients.get(client.id);
    if (clientData && data.room !== 'global') {
      client.leave(data.room);
      clientData.rooms.delete(data.room);
    }
    return { success: true };
  }

  // ============ EVENT EMITTERS ============

  // Emit to all connected clients
  emitGlobal(event: string, payload: any) {
    this.server.to('global').emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // Emit to admin room only
  emitToAdmin(event: string, payload: any) {
    this.server.to('admin').emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // Emit to providers room
  emitToProviders(event: string, payload: any) {
    this.server.to('providers').emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // Emit to specific room (e.g., city, region)
  emitToRoom(room: string, event: string, payload: any) {
    this.server.to(room).emit(event, {
      ...payload,
      timestamp: new Date().toISOString(),
    });
  }

  // Emit to specific user by userId
  emitToUser(userId: string, event: string, payload: any) {
    for (const [clientId, client] of this.clients) {
      if (client.userId === userId) {
        this.server.to(clientId).emit(event, {
          ...payload,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // ============ PING/PONG ============

  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket) {
    return { event: 'pong', timestamp: new Date().toISOString() };
  }

  // ============ STATS ============

  getStats() {
    const stats = {
      totalClients: this.clients.size,
      adminClients: 0,
      providerClients: 0,
      anonymousClients: 0,
    };

    for (const client of this.clients.values()) {
      if (client.role === 'admin' || client.role === 'support') {
        stats.adminClients++;
      } else if (client.role === 'provider_owner' || client.role === 'provider_manager') {
        stats.providerClients++;
      } else if (!client.userId) {
        stats.anonymousClients++;
      }
    }

    return stats;
  }
}
