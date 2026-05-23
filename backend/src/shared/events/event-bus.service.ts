// EventBus - внутренняя шина событий платформы
import { Injectable } from '@nestjs/common';
import { EventPayload, PlatformEvent } from './events';

type EventHandler = (payload: EventPayload) => Promise<void>;

@Injectable()
export class EventBus {
  private handlers: Map<PlatformEvent, EventHandler[]> = new Map();

  /**
   * Подписка на событие
   */
  on(event: PlatformEvent, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
  }

  /**
   * Отписка от события
   */
  off(event: PlatformEvent, handler: EventHandler): void {
    const handlers = this.handlers.get(event);
    if (handlers) {
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * Публикация события
   */
  async emit(event: PlatformEvent, data: Record<string, any>, meta?: EventPayload['meta']): Promise<void> {
    const payload: EventPayload = {
      event,
      timestamp: new Date(),
      data,
      meta,
    };

    const handlers = this.handlers.get(event) || [];
    
    // Выполняем все handlers последовательно
    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch (error) {
        console.error(`EventBus handler error for ${event}:`, error);
        // Не прерываем другие handlers при ошибке
      }
    }
  }

  /**
   * Получить список всех событий с подписчиками
   */
  getSubscriptions(): Record<string, number> {
    const result: Record<string, number> = {};
    this.handlers.forEach((handlers, event) => {
      result[event] = handlers.length;
    });
    return result;
  }
}
