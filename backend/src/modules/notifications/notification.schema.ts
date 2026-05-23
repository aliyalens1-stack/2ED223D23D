// Notification Schema
import { Schema } from 'mongoose';

export const NotificationSchema = new Schema(
  {
    // Кому адресовано
    userId: { 
      type: Schema.Types.ObjectId, 
      ref: 'User', 
      required: true,
      index: true,
    },

    // Тип уведомления (соответствует PlatformEvent)
    type: { 
      type: String, 
      required: true,
      index: true,
    },

    // Контент
    title: { type: String, required: true },
    message: { type: String, required: true },

    // Связанные данные для навигации
    data: { 
      type: Schema.Types.Mixed,
      default: {},
    },

    // Статус прочтения
    isRead: { 
      type: Boolean, 
      default: false, 
      index: true,
    },

    // Когда прочитано
    readAt: { type: Date },
  },
  { 
    timestamps: true,
    collection: 'notifications',
  },
);

// Составной индекс для эффективных запросов
NotificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, createdAt: -1 });

export interface INotification {
  _id: any;
  userId: any;
  type: string;
  title: string;
  message: string;
  data: Record<string, any>;
  isRead: boolean;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
