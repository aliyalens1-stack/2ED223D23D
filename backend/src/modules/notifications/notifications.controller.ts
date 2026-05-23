// Notifications Controller
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    @InjectModel('UserDevice') private readonly deviceModel: Model<any>,
  ) {}

  // ============ DEVICE REGISTRATION ============

  @Post('devices/register')
  @ApiOperation({ summary: 'Register device for push notifications' })
  async registerDevice(@Req() req: any, @Body() body: any) {
    const { deviceToken, platform } = body;
    if (!deviceToken) return { success: false, message: 'deviceToken required' };

    await this.deviceModel.findOneAndUpdate(
      { deviceToken },
      {
        userId: new Types.ObjectId(req.user.sub),
        platform: platform || 'expo',
        isActive: true,
        lastSeenAt: new Date(),
      },
      { upsert: true, new: true },
    );

    return { success: true };
  }

  @Post('devices/unregister')
  @ApiOperation({ summary: 'Unregister device from push notifications' })
  async unregisterDevice(@Body() body: any) {
    if (!body.deviceToken) return { success: false };

    await this.deviceModel.updateOne(
      { deviceToken: body.deviceToken },
      { isActive: false },
    );

    return { success: true };
  }

  // ============ NOTIFICATIONS ============

  @Get('notifications')
  @ApiOperation({ summary: 'Get my notifications' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  async getMyNotifications(
    @Req() req: any,
    @Query('limit') limit?: string,
    @Query('skip') skip?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    return this.notificationsService.getUserNotifications(req.user.sub, {
      limit: limit ? parseInt(limit, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
      unreadOnly: unreadOnly === 'true',
    });
  }

  @Get('notifications/unread-count')
  @ApiOperation({ summary: 'Get unread notifications count' })
  async getUnreadCount(@Req() req: any) {
    const count = await this.notificationsService.getUnreadCount(req.user.sub);
    return { unreadCount: count };
  }

  @Patch('notifications/:id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  async markAsRead(@Param('id') id: string, @Req() req: any) {
    const success = await this.notificationsService.markAsRead(id, req.user.sub);
    return { success };
  }

  @Patch('notifications/read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@Req() req: any) {
    const count = await this.notificationsService.markAllAsRead(req.user.sub);
    return { success: true, markedCount: count };
  }

  @Delete('notifications/:id')
  @ApiOperation({ summary: 'Delete notification' })
  async delete(@Param('id') id: string, @Req() req: any) {
    const success = await this.notificationsService.delete(id, req.user.sub);
    return { success };
  }
}
